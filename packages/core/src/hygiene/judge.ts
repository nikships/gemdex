import { GoogleGenAI, Type } from '@google/genai';
import { DEFAULT_DIGEST_MODEL, DIGEST_MODELS } from '../ingest/digester';
import { HygieneConfidence, HygieneFinding, HygieneVerdictKind } from './types';

/** Content chars per memory included in a judge prompt. */
export const JUDGE_CONTENT_CHAR_LIMIT = 8_000;

/** One cluster member plus its full content, as fed to the judge. */
export interface JudgeMemberInput {
    memoryId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    content: string;
}

const JUDGE_SYSTEM_INSTRUCTION = `You are auditing an AI agent's long-term memory store for stale or redundant
entries. You are given a cluster of memories about similar topics, oldest
first. For EACH memory return a verdict: 'duplicate' if another memory in the
cluster makes it fully redundant (same facts, no unique info); 'superseded' if
a NEWER memory covers the same subject with updated information making this
one stale; 'contradicted' if a NEWER memory states facts that directly
conflict with this one (e.g. rotated credentials, changed URLs/paths, 'X is
broken' followed by 'X was fixed'); otherwise 'keep'. Be conservative:
memories describing DIFFERENT work sessions, incidents, or tasks on the same
topic are 'keep' unless one strictly contains the other's useful content.
Newer wins only when claims actually conflict or fully overlap. At least one
memory in every cluster must be 'keep'. For non-keep verdicts cite
supersededBy (the id of the newer covering memory) and evidence (one short
quote pair: the stale claim and the newer claim). Confidence: 'high' only
when you would stake the deletion on it.`;

export const JUDGE_RESPONSE_SCHEMA = {
    type: Type.ARRAY,
    items: {
        type: Type.OBJECT,
        properties: {
            memory_id: { type: Type.STRING },
            verdict: {
                type: Type.STRING,
                enum: ['keep', 'duplicate', 'superseded', 'contradicted'],
            },
            superseded_by: { type: Type.STRING },
            evidence: { type: Type.STRING },
            confidence: {
                type: Type.STRING,
                enum: ['high', 'medium', 'low'],
            },
        },
        required: ['memory_id', 'verdict', 'confidence'],
    },
} as const;

/** Build the judge prompt: one block per memory, ordered oldest → newest. */
export function buildJudgePrompt(members: JudgeMemberInput[]): string {
    const ordered = [...members].sort((a, b) => a.updatedAt - b.updatedAt);
    return ordered
        .map((member) => {
            const content = member.content.length > JUDGE_CONTENT_CHAR_LIMIT
                ? `${member.content.slice(0, JUDGE_CONTENT_CHAR_LIMIT)}\n[truncated]`
                : member.content;
            return `=== MEMORY ${member.memoryId} ===\n`
                + `title: ${member.title}\n`
                + `createdAt: ${new Date(member.createdAt).toISOString()}\n`
                + `updatedAt: ${new Date(member.updatedAt).toISOString()}\n`
                + `content:\n${content}`;
        })
        .join('\n\n');
}

const VERDICTS: HygieneVerdictKind[] = ['keep', 'duplicate', 'superseded', 'contradicted'];
const CONFIDENCES: HygieneConfidence[] = ['high', 'medium', 'low'];

/**
 * Parse the judge's structured-output JSON into findings. Guarantees exactly
 * one finding per known member: missing members default to keep/low,
 * hallucinated ids are dropped, and if the model condemned every member the
 * newest one is flipped back to keep (at least one keep per cluster).
 */
export function parseJudgeResponse(text: string, memberIds: string[]): HygieneFinding[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Judge model returned invalid JSON');
    }
    if (!Array.isArray(parsed)) {
        throw new Error('Judge model returned a non-array response');
    }

    const known = new Set(memberIds);
    const byId = new Map<string, HygieneFinding>();
    for (const raw of parsed) {
        if (!raw || typeof raw !== 'object') continue;
        const record = raw as Record<string, unknown>;
        const memoryId = typeof record.memory_id === 'string' ? record.memory_id : '';
        // Ignore verdicts for ids the model hallucinated.
        if (!known.has(memoryId)) continue;
        const verdict = VERDICTS.includes(record.verdict as HygieneVerdictKind)
            ? (record.verdict as HygieneVerdictKind)
            : 'keep';
        const confidence = CONFIDENCES.includes(record.confidence as HygieneConfidence)
            ? (record.confidence as HygieneConfidence)
            : 'low';
        const supersededBy = typeof record.superseded_by === 'string' && record.superseded_by.length > 0
            ? record.superseded_by
            : undefined;
        const evidence = typeof record.evidence === 'string' && record.evidence.length > 0
            ? record.evidence
            : undefined;
        byId.set(memoryId, {
            memoryId,
            verdict,
            ...(supersededBy !== undefined && { supersededBy }),
            ...(evidence !== undefined && { evidence }),
            confidence,
        });
    }

    // Every member gets a verdict; unmentioned members default to keep/low.
    const findings: HygieneFinding[] = memberIds.map((memoryId) =>
        byId.get(memoryId) ?? { memoryId, verdict: 'keep', confidence: 'low' });

    // Enforce "at least one keep": if the model condemned everything, flip
    // the newest member (memberIds are ordered newest-first) back to keep.
    if (findings.length > 0 && findings.every((f) => f.verdict !== 'keep')) {
        findings[0] = { memoryId: findings[0].memoryId, verdict: 'keep', confidence: 'low' };
    }
    return findings;
}

export interface ClusterJudgeConfig {
    apiKey: string;
    model?: string;
    baseURL?: string;
}

/** Thin client that judges one cluster of memories via `generateContent`. */
export class ClusterJudge {
    private client: GoogleGenAI;
    readonly model: string;

    constructor(config: ClusterJudgeConfig) {
        this.model = config.model ?? DEFAULT_DIGEST_MODEL;
        if (!DIGEST_MODELS[this.model]) {
            throw new Error(
                `Unsupported judge model "${this.model}". Supported: ${Object.keys(DIGEST_MODELS).join(', ')}`,
            );
        }
        this.client = new GoogleGenAI({
            apiKey: config.apiKey,
            ...(config.baseURL && { httpOptions: { baseUrl: config.baseURL } }),
        });
    }

    getClient(): GoogleGenAI {
        return this.client;
    }

    /** Judge one cluster. `members` should be ordered newest-first (scan order). */
    async judge(members: JudgeMemberInput[]): Promise<HygieneFinding[]> {
        const response = await this.client.models.generateContent({
            model: this.model,
            contents: buildJudgePrompt(members),
            config: {
                responseMimeType: 'application/json',
                responseSchema: JUDGE_RESPONSE_SCHEMA,
                systemInstruction: JUDGE_SYSTEM_INSTRUCTION,
                temperature: 0,
            },
        });
        const text = response.text;
        if (!text) {
            throw new Error('Judge model returned an empty response');
        }
        return parseJudgeResponse(text, members.map((m) => m.memoryId));
    }
}
