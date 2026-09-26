import { GoogleGenAI } from '@google/genai';
import { ClaudeCodeRunner, DEFAULT_CLAUDE_MODEL, assertSupportedModel } from '../inference/claude-code';
import { ParsedSession, SessionDigest, SessionMeta } from './types';
import { renderTranscript } from './transcript-parser';

/** Output budget assumed per digest for cost estimates. */
export const ESTIMATED_OUTPUT_TOKENS_PER_SESSION = 800;

/**
 * Anything that turns one parsed session into a structured digest. Local
 * Gemdex digests with {@link ClaudeCodeDigester}; the BYOI server digests
 * uploaded sessions with the Gemini {@link SessionDigester}.
 */
export interface Digester {
    readonly model: string;
    digest(session: ParsedSession): Promise<SessionDigest>;
}

const SOURCE_LABELS: Record<string, string> = {
    claude: 'Claude Code',
    factory: 'Factory CLI',
    codex: 'Codex',
    antigravity: 'Antigravity',
    custom: 'Coding agent',
};

const DIGEST_SYSTEM_INSTRUCTION = `You distill a coding-agent chat transcript into the note a future AI agent
needs to redo this work without the transcript. Optimize for reproducibility
and recall: exact commands with flags, exact file paths, exact tool/service
names, where credentials/config live. Prefer concrete specifics over prose.
Omit anything generic that any engineer would already know. If the session was
trivial or exploratory, keep every field short rather than padding.`;

/** Digest structured-output schema (JSON Schema; top level must be an object). */
export const DIGEST_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        title: {
            type: 'string',
            description: "Imperative, searchable title — e.g. 'Set up SSE chat streaming in agent frontend'",
        },
        what_was_done: {
            type: 'string',
            description: '2-4 sentence narrative of the task and end state',
        },
        how_to_reproduce: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered steps with exact commands, flags, file paths',
        },
        tools_and_services: {
            type: 'array',
            items: { type: 'string' },
            description: "Tools/CLIs/APIs/libraries used and what for — e.g. 'xcrun notarytool — Apple notarization'",
        },
        credentials_and_config: {
            type: 'array',
            items: { type: 'string' },
            description: 'Where keys/tokens/profiles/env vars live (names and locations)',
        },
        gotchas: {
            type: 'array',
            items: { type: 'string' },
            description: 'Errors hit plus the actual fix; non-obvious constraints',
        },
    },
    required: ['title', 'what_was_done'],
} as const;

/**
 * Convert a JSON Schema subset (type/properties/items/required/description/enum)
 * into Gemini's OpenAPI-style `responseSchema`, whose `type` values are the
 * upper-case `Type` enum strings.
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (key === 'type' && typeof value === 'string') {
            out.type = value.toUpperCase();
        } else if (key === 'properties' && value && typeof value === 'object') {
            out.properties = Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, toGeminiSchema(child)]),
            );
        } else if (key === 'items') {
            out.items = toGeminiSchema(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Parse the model's structured-output JSON text into a SessionDigest. */
export function parseDigestResponse(text: string): SessionDigest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Digest model returned invalid JSON');
    }
    return parseDigestOutput(parsed);
}

/** Validate an already-decoded structured output into a SessionDigest. */
export function parseDigestOutput(parsed: unknown): SessionDigest {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Digest model returned a non-object response');
    }
    const record = parsed as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const whatWasDone = typeof record.what_was_done === 'string' ? record.what_was_done.trim() : '';
    if (!title || !whatWasDone) {
        throw new Error("Digest response is missing 'title' or 'what_was_done'");
    }
    return {
        title,
        whatWasDone,
        howToReproduce: asStringArray(record.how_to_reproduce),
        toolsAndServices: asStringArray(record.tools_and_services),
        credentialsAndConfig: asStringArray(record.credentials_and_config),
        gotchas: asStringArray(record.gotchas),
    };
}

function formatDate(ms: number | undefined): string | undefined {
    if (ms === undefined) return undefined;
    return new Date(ms).toISOString().slice(0, 10);
}

function section(heading: string, items: string[], ordered: boolean): string {
    if (items.length === 0) return '';
    const lines = items.map((item, index) => ordered ? `${index + 1}. ${item}` : `- ${item}`);
    return `\n## ${heading}\n${lines.join('\n')}\n`;
}

/**
 * Render a digest plus session metadata into the memory content. Always
 * footed with the provenance pointer back to the raw transcript so an agent
 * can read the verbatim session when the digest isn't enough.
 */
export function renderDigestMemory(
    digest: SessionDigest,
    meta: SessionMeta,
    options: { transcriptPointer?: string } = {},
): string {
    const sourceLabel = SOURCE_LABELS[meta.source] ?? SOURCE_LABELS.custom;
    const headerParts = [`Source: ${sourceLabel}`];
    if (meta.cwd) {
        headerParts.push(`Repo: ${meta.cwd}${meta.gitBranch ? ` (${meta.gitBranch})` : ''}`);
    }
    const date = formatDate(meta.lastTs ?? meta.firstTs);
    if (date) headerParts.push(date);

    let body = `${headerParts.join(' · ')}\n${digest.whatWasDone}\n`;
    body += section('How to reproduce', digest.howToReproduce, true);
    body += section('Tools & services', digest.toolsAndServices, false);
    body += section('Credentials & config', digest.credentialsAndConfig, false);
    body += section('Gotchas', digest.gotchas, false);
    // Provenance footer. The path-based pipeline points at the source file on
    // the machine that ingested it; an uploaded session has no such path on the
    // ingesting host, so callers override the pointer with something an agent
    // can actually act on (the read_attachment hint).
    body += `\n---\nFull transcript: ${options.transcriptPointer ?? meta.filePath}\n`
        + '(read this file for the verbatim session)';
    return body;
}

/** Deterministic memory id for a session — re-ingestion upserts, never duplicates. */
export function memoryIdForSession(meta: Pick<SessionMeta, 'source' | 'sessionId'>): string {
    return `chat:${meta.source}:${meta.sessionId}`;
}

/** Build the user-prompt contents for one session's digest request. */
export function buildDigestPrompt(session: ParsedSession): string {
    const contextLines = [
        `Agent: ${SOURCE_LABELS[session.source] ?? SOURCE_LABELS.custom}`,
        session.cwd ? `Working directory: ${session.cwd}` : null,
        session.gitBranch ? `Git branch: ${session.gitBranch}` : null,
        session.title ? `Session title: ${session.title}` : null,
    ].filter((line): line is string => line !== null);
    return `${contextLines.join('\n')}\n\nTranscript:\n\n${renderTranscript(session.turns)}`;
}

/** Default Gemini model for the BYOI server's uploaded-session digests. */
export const GEMINI_DIGEST_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_DIGEST_MODELS = [GEMINI_DIGEST_MODEL];

export interface DigesterConfig {
    apiKey: string;
    model?: string;
    baseURL?: string;
}

/**
 * Gemini digester used by the BYOI server (`POST /v1/sessions/ingest`), which
 * holds the deployment's Gemini key. Local Gemdex uses {@link ClaudeCodeDigester}.
 */
export class SessionDigester implements Digester {
    private client: GoogleGenAI;
    readonly model: string;

    constructor(config: DigesterConfig) {
        this.model = config.model ?? GEMINI_DIGEST_MODEL;
        if (!GEMINI_DIGEST_MODELS.includes(this.model)) {
            throw new Error(
                `Unsupported digest model "${this.model}". Supported: ${GEMINI_DIGEST_MODELS.join(', ')}`,
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

    async digest(session: ParsedSession): Promise<SessionDigest> {
        const response = await this.client.models.generateContent({
            model: this.model,
            contents: buildDigestPrompt(session),
            config: {
                responseMimeType: 'application/json',
                responseSchema: toGeminiSchema(DIGEST_RESPONSE_SCHEMA),
                systemInstruction: DIGEST_SYSTEM_INSTRUCTION,
                temperature: 0.2,
            },
        });
        const text = response.text;
        if (!text) {
            throw new Error('Digest model returned an empty response');
        }
        return parseDigestResponse(text);
    }
}

export interface ClaudeCodeDigesterConfig {
    model?: string;
    runner?: ClaudeCodeRunner;
}

/** Digests one session through the user's local Claude Code CLI. */
export class ClaudeCodeDigester implements Digester {
    readonly model: string;
    private readonly runner: ClaudeCodeRunner;

    constructor(config: ClaudeCodeDigesterConfig = {}) {
        this.model = config.model ?? DEFAULT_CLAUDE_MODEL;
        assertSupportedModel(this.model);
        this.runner = config.runner ?? new ClaudeCodeRunner();
    }

    async digest(session: ParsedSession): Promise<SessionDigest> {
        const { output } = await this.runner.runStructured({
            model: this.model,
            systemPrompt: DIGEST_SYSTEM_INSTRUCTION,
            prompt: buildDigestPrompt(session),
            schema: DIGEST_RESPONSE_SCHEMA,
        });
        return parseDigestOutput(output);
    }
}
