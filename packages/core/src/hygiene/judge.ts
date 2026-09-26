import { ClaudeCodeRunner, DEFAULT_CLAUDE_MODEL, assertSupportedModel } from '../inference/claude-code';
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

/**
 * Judge structured-output schema. Claude Code's `--json-schema` requires an
 * object at the top level, so the per-memory verdicts live under `verdicts`.
 */
export const JUDGE_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        verdicts: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    memory_id: { type: 'string' },
                    verdict: {
                        type: 'string',
                        enum: ['keep', 'duplicate', 'superseded', 'contradicted'],
                    },
                    superseded_by: { type: 'string' },
                    evidence: { type: 'string' },
                    confidence: {
                        type: 'string',
                        enum: ['high', 'medium', 'low'],
                    },
                },
                required: ['memory_id', 'verdict', 'confidence'],
            },
        },
    },
    required: ['verdicts'],
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
 * Turn the judge's structured output into findings. Accepts the
 * `{ verdicts: [...] }` object (or a bare verdict array). Guarantees exactly
 * one finding per known member: missing members default to keep/low,
 * hallucinated ids are dropped, and if the model condemned every member the
 * newest one is flipped back to keep (at least one keep per cluster).
 */
export function parseJudgeOutput(output: unknown, memberIds: string[]): HygieneFinding[] {
    const parsed = Array.isArray(output)
        ? output
        : (output && typeof output === 'object' ? (output as Record<string, unknown>).verdicts : undefined);
    if (!Array.isArray(parsed)) {
        throw new Error('Judge model returned no verdict list');
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

/** Parse the judge's structured-output JSON text into findings. */
export function parseJudgeResponse(text: string, memberIds: string[]): HygieneFinding[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Judge model returned invalid JSON');
    }
    return parseJudgeOutput(parsed, memberIds);
}

/** Anything that returns per-member verdicts for one cluster. */
export interface Judge {
    readonly model: string;
    /** Judge one cluster. `members` should be ordered newest-first (scan order). */
    judge(members: JudgeMemberInput[]): Promise<HygieneFinding[]>;
}

export interface ClusterJudgeConfig {
    model?: string;
    runner?: ClaudeCodeRunner;
}

/** Judges one cluster of memories through the user's local Claude Code CLI. */
export class ClusterJudge implements Judge {
    readonly model: string;
    private readonly runner: ClaudeCodeRunner;

    constructor(config: ClusterJudgeConfig = {}) {
        this.model = config.model ?? DEFAULT_CLAUDE_MODEL;
        assertSupportedModel(this.model);
        this.runner = config.runner ?? new ClaudeCodeRunner();
    }

    async judge(members: JudgeMemberInput[]): Promise<HygieneFinding[]> {
        const { output } = await this.runner.runStructured({
            model: this.model,
            systemPrompt: JUDGE_SYSTEM_INSTRUCTION,
            prompt: buildJudgePrompt(members),
            schema: JUDGE_RESPONSE_SCHEMA,
        });
        return parseJudgeOutput(output, members.map((m) => m.memoryId));
    }
}
