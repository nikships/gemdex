import * as fs from 'node:fs';
import * as path from 'node:path';
import { IngestSource, ParsedSession, SessionTurn } from './types';

/** Sessions with less real conversation than this are skipped as trivial. */
export const MIN_SESSION_CHARS = 200;

/** Max length for a rendered command line before truncation. */
const MAX_COMMAND_CHARS = 300;
/** Max length kept from a tool-result error line. */
const MAX_ERROR_CHARS = 200;

/** Tools whose invocation is a shell command — the reproducibility payload. */
const COMMAND_TOOLS = new Set(['Bash', 'Execute']);
/** Tools that write files; reduced to `edit: <path>` so paths stay searchable. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'Create', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Strip `<system-reminder>…</system-reminder>` blocks (Factory injects them into user text). */
export function stripSystemReminders(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * Render one `tool_use` content part as a compact, searchable line — or null
 * when the tool is read-only noise. Exact commands and file paths are kept
 * because they are what a future agent needs to reproduce the work.
 */
function toolUseToLine(name: unknown, input: unknown): string | null {
    if (typeof name !== 'string') return null;
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (COMMAND_TOOLS.has(name) && typeof args.command === 'string' && args.command.trim()) {
        return `$ ${truncate(args.command.trim().replace(/\s*\n\s*/g, ' '), MAX_COMMAND_CHARS)}`;
    }
    if (WRITE_TOOLS.has(name) && typeof args.file_path === 'string' && args.file_path.trim()) {
        return `edit: ${args.file_path.trim()}`;
    }
    if (typeof args.url === 'string' && args.url.trim()) {
        return `fetch: ${truncate(args.url.trim(), MAX_COMMAND_CHARS)}`;
    }
    return null;
}

/** Extract a short error line from a `tool_result` part; null for non-errors. */
function toolResultToLine(part: Record<string, unknown>): string | null {
    if (part.is_error !== true) return null;
    const content = part.content;
    let text = '';
    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        const textPart = content.find((p) => p && typeof p === 'object' && (p as any).type === 'text');
        text = typeof (textPart as any)?.text === 'string' ? (textPart as any).text : '';
    }
    const firstLine = text.trim().split('\n')[0]?.trim();
    return firstLine ? `error: ${truncate(firstLine, MAX_ERROR_CHARS)}` : null;
}

/**
 * Flatten a message `content` value (string or part array) into the turn text:
 * text parts verbatim, tool_use parts as compact command/path lines, error
 * tool_results as one-line errors; thinking and successful results dropped.
 */
function contentToText(content: unknown, role: 'user' | 'assistant'): string {
    if (typeof content === 'string') {
        return role === 'user' ? stripSystemReminders(content) : content.trim();
    }
    if (!Array.isArray(content)) return '';
    const lines: string[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p.type === 'text' && typeof p.text === 'string') {
            const text = role === 'user' ? stripSystemReminders(p.text) : p.text.trim();
            if (text) lines.push(text);
        } else if (p.type === 'tool_use') {
            const line = toolUseToLine(p.name, p.input);
            if (line) lines.push(line);
        } else if (p.type === 'tool_result') {
            const line = toolResultToLine(p);
            if (line) lines.push(line);
        }
    }
    return lines.join('\n');
}

function parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
}

function sessionIdFromFile(filePath: string): string {
    return path.basename(filePath, '.jsonl');
}

interface RawLine {
    record: Record<string, unknown>;
}

function readJsonlRecords(filePath: string): RawLine[] {
    const raw = fs.readFileSync(filePath, 'utf8');
    const records: RawLine[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const record = JSON.parse(trimmed);
            if (record && typeof record === 'object' && !Array.isArray(record)) {
                records.push({ record });
            }
        } catch {
            // Tolerate corrupt lines (active writes, truncation).
        }
    }
    return records;
}

/**
 * Parse a session transcript into the normalized shape, auto-detecting the
 * dialect:
 * - **Claude Code** — events typed `user`/`assistant` carrying `message`,
 *   `cwd`, `gitBranch`, `sessionId`; sidechain events excluded.
 * - **Factory CLI** — a `session_start` record (id/title/cwd) followed by
 *   `message` events.
 *
 * Returns null when the file holds no meaningful conversation
 * (< {@link MIN_SESSION_CHARS} chars of real text).
 */
export function parseSessionFile(filePath: string, source: IngestSource): ParsedSession | null {
    const records = readJsonlRecords(filePath);
    if (records.length === 0) return null;

    const parsed: ParsedSession = {
        sessionId: sessionIdFromFile(filePath),
        source,
        filePath,
        turns: [],
    };

    for (const { record } of records) {
        const type = record.type;

        if (type === 'session_start') {
            // Factory dialect header.
            if (typeof record.id === 'string' && record.id) parsed.sessionId = record.id;
            if (typeof record.title === 'string' && record.title.trim()) parsed.title = record.title.trim();
            if (typeof record.cwd === 'string' && record.cwd) parsed.cwd = record.cwd;
            continue;
        }

        let role: 'user' | 'assistant' | null = null;
        let message: Record<string, unknown> | null = null;

        if (type === 'user' || type === 'assistant') {
            // Claude dialect. Skip subagent sidechains — they aren't the user's
            // conversation and routinely dwarf it.
            if (record.isSidechain === true) continue;
            role = type;
            message = (record.message && typeof record.message === 'object'
                ? record.message : null) as Record<string, unknown> | null;
            if (typeof record.sessionId === 'string' && record.sessionId) parsed.sessionId = record.sessionId;
            if (typeof record.cwd === 'string' && record.cwd) parsed.cwd ??= record.cwd;
            if (typeof record.gitBranch === 'string' && record.gitBranch) parsed.gitBranch ??= record.gitBranch;
        } else if (type === 'message') {
            // Factory dialect.
            message = (record.message && typeof record.message === 'object'
                ? record.message : null) as Record<string, unknown> | null;
            const messageRole = message?.role;
            if (messageRole === 'user' || messageRole === 'assistant') role = messageRole;
        } else {
            continue; // queue-operation, attachment, last-prompt, settings, …
        }

        if (!role || !message) continue;

        const ts = parseTimestamp(record.timestamp);
        if (ts !== undefined) {
            parsed.firstTs = parsed.firstTs === undefined ? ts : Math.min(parsed.firstTs, ts);
            parsed.lastTs = parsed.lastTs === undefined ? ts : Math.max(parsed.lastTs, ts);
        }

        const text = contentToText(message.content, role);
        if (!text) continue;
        parsed.turns.push({ role, text });
    }

    const totalChars = parsed.turns.reduce((sum, turn) => sum + turn.text.length, 0);
    if (totalChars < MIN_SESSION_CHARS) return null;
    return parsed;
}

/** Default per-session transcript budget handed to the digest model (~75k tokens). */
export const DEFAULT_TRANSCRIPT_CHAR_CAP = 300_000;

/**
 * Render the parsed turns as a plain-text transcript for the digest prompt.
 * When over the cap, keeps the head (60%) and tail (40%) with an elision
 * marker — the start (task framing) and the end (final state) carry the most
 * reproducibility signal.
 */
export function renderTranscript(turns: SessionTurn[], cap: number = DEFAULT_TRANSCRIPT_CHAR_CAP): string {
    const full = turns
        .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}:\n${turn.text}`)
        .join('\n\n');
    if (full.length <= cap) return full;
    const headBudget = Math.floor(cap * 0.6);
    const tailBudget = cap - headBudget;
    return `${full.slice(0, headBudget)}\n\n[… transcript elided …]\n\n${full.slice(full.length - tailBudget)}`;
}
