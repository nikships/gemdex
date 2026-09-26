import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { envManager } from '../utils/env-manager';

/**
 * Structured-output inference through the user's local Claude Code CLI
 * (`claude -p`). Chat-history digestion and memory hygiene run here so local
 * Gemdex needs no model API key: the CLI authenticates with whatever login the
 * user already has (Claude subscription or Anthropic Console).
 *
 * Every call is an isolated, tool-less, single-turn completion. The flags and
 * environment below exist to stop the user's own Claude Code setup (hooks,
 * skills, MCP servers, CLAUDE.md files, auto-memory, plugins) from leaking into
 * or being triggered by a Gemdex background job:
 *
 * - `--tools ""` — no tools at all; the model can only answer.
 * - `--setting-sources ""` + `--settings {"disableAllHooks":true}` — ignore
 *   user/project/local settings, so no hooks or plugins load.
 * - `--strict-mcp-config --mcp-config {"mcpServers":{}}` — no MCP servers.
 * - `--disable-slash-commands` — no skills.
 * - `--no-session-persistence` — nothing written to `~/.claude/projects`, so
 *   Gemdex's own jobs never show up as sessions for the next ingest to digest.
 * - `--system-prompt` — replaces the Claude Code agent prompt entirely.
 * - A fresh empty temp dir as cwd, so no project CLAUDE.md is discovered.
 *
 * `--bare` would be simpler but refuses OAuth/keychain logins (API key only),
 * and a temporary HOME loses the login, so neither is used.
 */

export const DEFAULT_CLAUDE_MODEL = 'haiku';

export interface InferenceModelInfo {
    /** USD per 1M input tokens at Anthropic API list price. */
    inputUsdPerMTok: number;
    /** USD per 1M output tokens at Anthropic API list price. */
    outputUsdPerMTok: number;
    description: string;
    /** Substring every `modelUsage` key must contain (guards silent fallback). */
    family: string;
}

/** Date the list prices below were last checked against anthropic.com/pricing. */
export const INFERENCE_PRICING_AS_OF = '2026-09-26';

/** Models offered for digestion and hygiene. Single model by design. */
export const INFERENCE_MODELS: Record<string, InferenceModelInfo> = {
    haiku: {
        inputUsdPerMTok: 1,
        outputUsdPerMTok: 5,
        description: 'Claude Haiku via your Claude Code login',
        family: 'haiku',
    },
};

/** Cost estimate for one model at API list price. */
export interface ModelCostEstimate {
    model: string;
    /** USD at Anthropic API list price; subscription logins are not billed per token. */
    usd: number;
}

/** Rough chars→tokens divisor for estimates. */
const CHARS_PER_TOKEN = 4;

export function estimateTokensForChars(chars: number): number {
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateCost(inputTokens: number, outputTokens: number): ModelCostEstimate[] {
    return Object.entries(INFERENCE_MODELS).map(([model, info]) => ({
        model,
        usd: Number(((inputTokens * info.inputUsdPerMTok + outputTokens * info.outputUsdPerMTok) / 1_000_000).toFixed(2)),
    }));
}

export function assertSupportedModel(model: string): InferenceModelInfo {
    const info = INFERENCE_MODELS[model];
    if (!info) {
        throw new Error(`Unsupported model "${model}". Supported: ${Object.keys(INFERENCE_MODELS).join(', ')}`);
    }
    return info;
}

/**
 * Env vars that make a spawned CLI believe it is nested inside another Claude
 * Code session (the sidecar may be launched from one). Removed from the child.
 */
const INHERITED_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

const ISOLATION_ENV: Record<string, string> = {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};

function isExecutableFile(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/**
 * Locate the Claude Code binary. `GEMDEX_CLAUDE_PATH` wins; then the native
 * installer locations; then `PATH`. Native locations come before `PATH`
 * because terminal multiplexers and IDEs often put wrapper scripts named
 * `claude` first on `PATH` that inject their own hooks, and a Finder-launched
 * desktop app has a minimal `PATH` anyway.
 */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
    const override = env.GEMDEX_CLAUDE_PATH ?? envManager.get('GEMDEX_CLAUDE_PATH');
    if (override && override.trim().length > 0) {
        return isExecutableFile(override.trim()) ? override.trim() : null;
    }
    const home = env.HOME ?? os.homedir();
    const candidates = [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'claude')),
    ];
    for (const candidate of candidates) {
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
}

function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...ISOLATION_ENV };
    for (const key of INHERITED_SESSION_ENV) delete env[key];
    return env;
}

interface SpawnResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/** Cap on captured child output; a digest or verdict list is a few KB. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function runProcess(
    command: string,
    args: string[],
    options: { stdin?: string; timeoutMs: number; cwd?: string; signal?: AbortSignal },
): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: childEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const kill = () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, options.timeoutMs);
        const onAbort = () => kill();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            if (stderr.length < 64 * 1024) stderr += chunk;
        });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            reject(error);
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            resolve({ code, signal, stdout, stderr, timedOut });
        });
        // EPIPE when the child exits before reading stdin surfaces via 'close'.
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.stdin ?? '');
    });
}

export interface ClaudeStructuredRequest {
    systemPrompt: string;
    /** User turn; piped over stdin so large transcripts never hit argv limits. */
    prompt: string;
    /** JSON Schema for the answer. The top level must be an object. */
    schema: Record<string, unknown>;
    model?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface ClaudeStructuredResult {
    output: unknown;
    /** Resolved model ids that served the request, from `modelUsage`. */
    models: string[];
    costUsd?: number;
}

export interface ClaudeCodeRunnerOptions {
    /** Absolute path to the CLI; resolved with {@link resolveClaudeBinary} when omitted. */
    binaryPath?: string;
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** First line of text, trimmed and capped, safe to surface in errors. */
function brief(text: string, max = 400): string {
    const line = text.trim().split('\n').find((l) => l.trim().length > 0) ?? '';
    return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Runs isolated `claude -p` structured-output calls. Stateless apart from the
 * resolved binary path; safe to share across concurrent calls.
 */
export class ClaudeCodeRunner {
    private readonly binaryPath?: string;
    private readonly timeoutMs: number;

    constructor(options: ClaudeCodeRunnerOptions = {}) {
        this.binaryPath = options.binaryPath;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    private binary(): string {
        const resolved = this.binaryPath ?? resolveClaudeBinary();
        if (!resolved) {
            throw new Error(
                'Claude Code CLI not found. Install it (https://docs.claude.com/en/docs/claude-code) '
                + 'or set GEMDEX_CLAUDE_PATH to the claude binary.',
            );
        }
        return resolved;
    }

    async runStructured(request: ClaudeStructuredRequest): Promise<ClaudeStructuredResult> {
        const model = request.model ?? DEFAULT_CLAUDE_MODEL;
        const info = assertSupportedModel(model);
        const args = [
            '-p',
            '--model', model,
            '--output-format', 'json',
            '--json-schema', JSON.stringify(request.schema),
            '--tools', '',
            '--setting-sources', '',
            '--settings', JSON.stringify({ disableAllHooks: true }),
            '--strict-mcp-config',
            '--mcp-config', JSON.stringify({ mcpServers: {} }),
            '--disable-slash-commands',
            '--no-session-persistence',
            '--system-prompt', request.systemPrompt,
        ];
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-claude-'));
        let result: SpawnResult;
        try {
            result = await runProcess(this.binary(), args, {
                stdin: request.prompt,
                timeoutMs: request.timeoutMs ?? this.timeoutMs,
                cwd,
                signal: request.signal,
            });
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
        if (request.signal?.aborted) throw new Error('Claude Code call cancelled');
        if (result.timedOut) throw new Error('Claude Code call timed out');
        return parseClaudeResult(result, info);
    }
}

function parseClaudeResult(result: SpawnResult, info: InferenceModelInfo): ClaudeStructuredResult {
    let envelope: Record<string, unknown> | null = null;
    try {
        const parsed = JSON.parse(result.stdout);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
    } catch {
        envelope = null;
    }
    if (!envelope) {
        const detail = brief(result.stderr) || brief(result.stdout) || `exit code ${result.code ?? result.signal}`;
        throw new Error(`Claude Code returned no JSON result: ${detail}`);
    }
    // The CLI exits 0 for API errors inside a run; `is_error` is authoritative.
    if (envelope.is_error === true || result.code !== 0) {
        const message = typeof envelope.result === 'string' ? brief(envelope.result) : '';
        throw new Error(`Claude Code call failed: ${message || brief(result.stderr) || 'unknown error'}`);
    }
    const models = envelope.modelUsage && typeof envelope.modelUsage === 'object'
        ? Object.keys(envelope.modelUsage as Record<string, unknown>)
        : [];
    // An unknown or unavailable --model silently falls back to the user's
    // default (often a far more expensive model). Refuse that result.
    if (models.length === 0 || models.some((id) => !id.includes(info.family))) {
        throw new Error(
            `Claude Code answered with ${models.join(', ') || 'an unknown model'} instead of ${info.family}; `
            + 'check that your Claude Code login can use this model.',
        );
    }
    let output: unknown = envelope.structured_output;
    if (output === undefined && typeof envelope.result === 'string') {
        try {
            output = JSON.parse(envelope.result);
        } catch {
            output = undefined;
        }
    }
    if (output === undefined || output === null) {
        throw new Error('Claude Code returned no structured output');
    }
    const cost = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : undefined;
    return { output, models, ...(cost !== undefined && { costUsd: cost }) };
}

export type ClaudeCodeStatus = 'ready' | 'missing' | 'unauthenticated' | 'error';

export interface ClaudeCodeReadiness {
    status: ClaudeCodeStatus;
    message?: string;
    version?: string;
    path?: string;
    checkedAt: number;
}

/**
 * Probe whether digestion/hygiene can run: the CLI exists, runs, and has a
 * login. Makes no model call (so it is free and fast); a login that cannot use
 * the model surfaces as a per-call error instead.
 */
export async function checkClaudeCode(options: { binaryPath?: string; timeoutMs?: number } = {}): Promise<ClaudeCodeReadiness> {
    const checkedAt = Date.now();
    const binary = options.binaryPath ?? resolveClaudeBinary();
    if (!binary) {
        return {
            status: 'missing',
            message: 'Claude Code CLI not found. Install it from https://docs.claude.com/en/docs/claude-code, '
                + 'or set GEMDEX_CLAUDE_PATH to the claude binary.',
            checkedAt,
        };
    }
    const timeoutMs = options.timeoutMs ?? 15_000;
    try {
        const version = await runProcess(binary, ['--version'], { timeoutMs });
        if (version.code !== 0) {
            return {
                status: 'error',
                path: binary,
                message: `claude --version failed: ${brief(version.stderr) || `exit code ${version.code}`}`,
                checkedAt,
            };
        }
        const versionText = brief(version.stdout, 80);
        const auth = await runProcess(binary, ['auth', 'status', '--json'], { timeoutMs });
        let loggedIn = false;
        let authMethod: string | undefined;
        try {
            const parsed = JSON.parse(auth.stdout) as Record<string, unknown>;
            loggedIn = parsed.loggedIn === true;
            authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
        } catch {
            return {
                status: 'error',
                path: binary,
                version: versionText,
                message: `claude auth status failed: ${brief(auth.stderr) || brief(auth.stdout) || `exit code ${auth.code}`}`,
                checkedAt,
            };
        }
        if (!loggedIn) {
            return {
                status: 'unauthenticated',
                path: binary,
                version: versionText,
                message: 'Claude Code is not logged in. Run `claude` in a terminal and sign in (or `claude auth login`).',
                checkedAt,
            };
        }
        return {
            status: 'ready',
            path: binary,
            version: versionText,
            ...(authMethod && { message: `Signed in (${authMethod})` }),
            checkedAt,
        };
    } catch (error) {
        return {
            status: 'error',
            path: binary,
            message: error instanceof Error ? error.message : String(error),
            checkedAt,
        };
    }
}
