import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { envManager } from '../utils/env-manager';
import {
    ClaudeCodeRunner,
    DEFAULT_CLAUDE_MODEL,
    INFERENCE_MODELS,
    INFERENCE_PRICING_AS_OF,
    assertSupportedModel,
    checkClaudeCode,
    estimateCost,
    estimateTokensForChars,
    resolveClaudeBinary,
} from './claude-code';

/** What the fake CLI writes about each invocation. */
interface Invocation {
    argv: string[];
    stdin: string;
    cwd: string;
    env: Record<string, string | null>;
}

interface FakeClaudeBehavior {
    /** stdout for a `-p` call; objects are JSON-encoded. */
    stdout?: unknown;
    stderr?: string;
    exitCode?: number;
    /** Keep the `-p` call alive this long before answering. */
    sleepMs?: number;
    version?: { stdout?: string; stderr?: string; exitCode?: number };
    auth?: { stdout?: unknown; stderr?: string; exitCode?: number };
}

const RECORDED_ENV = [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
    'ENABLE_CLAUDEAI_MCP_SERVERS',
    'GEMDEX_FAKE_PASSTHROUGH',
];

let dir: string;
let recordPath: string;

function encode(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Write an executable node script that stands in for `claude`. It appends one
 * JSON line per invocation (argv, stdin, cwd, selected env) to `recordPath`
 * and prints the canned output for the subcommand it was called with.
 */
function writeFakeClaude(behavior: FakeClaudeBehavior = {}, name = 'claude'): string {
    const scriptPath = path.join(dir, 'bin', name);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    const config = {
        recordPath,
        recordedEnv: RECORDED_ENV,
        print: {
            stdout: encode(behavior.stdout ?? ''),
            stderr: behavior.stderr ?? '',
            exitCode: behavior.exitCode ?? 0,
            sleepMs: behavior.sleepMs ?? 0,
        },
        version: {
            stdout: behavior.version?.stdout ?? '2.1.0 (Claude Code)\n',
            stderr: behavior.version?.stderr ?? '',
            exitCode: behavior.version?.exitCode ?? 0,
        },
        auth: {
            stdout: encode(behavior.auth?.stdout ?? { loggedIn: true, authMethod: 'claude.ai' }),
            stderr: behavior.auth?.stderr ?? '',
            exitCode: behavior.auth?.exitCode ?? 0,
        },
    };
    const script = `#!${process.execPath}
const fs = require('fs');
const config = ${JSON.stringify(config)};
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
    const env = {};
    for (const key of config.recordedEnv) env[key] = key in process.env ? process.env[key] : null;
    fs.appendFileSync(config.recordPath, JSON.stringify({ argv, stdin, cwd: process.cwd(), env }) + '\\n');
    const mode = argv[0] === '--version' ? config.version : argv[0] === 'auth' ? config.auth : config.print;
    const finish = () => {
        process.stdout.write(mode.stdout);
        process.stderr.write(mode.stderr);
        process.exitCode = mode.exitCode;
    };
    if (mode.sleepMs) setTimeout(finish, mode.sleepMs); else finish();
});
`;
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
}

function invocations(): Invocation[] {
    if (!fs.existsSync(recordPath)) return [];
    return fs.readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Invocation);
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        structured_output: { answer: 42 },
        total_cost_usd: 0.0123,
        modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 5 } },
        ...overrides,
    };
}

const REQUEST = {
    systemPrompt: 'You answer in JSON.',
    prompt: 'What is the answer?\nLine two with "quotes" and ünïcode.',
    schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
};

const SAVED_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'GEMDEX_CLAUDE_PATH', 'GEMDEX_FAKE_PASSTHROUGH'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-claude-test-'));
    recordPath = path.join(dir, 'invocations.jsonl');
    for (const key of SAVED_ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    // Keep binary resolution off the user's real ~/.gemdex/.env.
    jest.spyOn(envManager, 'get').mockImplementation((name: string) => process.env[name]);
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const key of SAVED_ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('ClaudeCodeRunner.runStructured', () => {
    it('spawns claude -p with every isolation flag, in order', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope() });
        await new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST);

        const [call] = invocations();
        expect(call.argv).toEqual([
            '-p',
            '--model', 'haiku',
            '--output-format', 'json',
            '--json-schema', JSON.stringify(REQUEST.schema),
            '--tools', '',
            '--setting-sources', '',
            '--settings', '{"disableAllHooks":true}',
            '--strict-mcp-config',
            '--mcp-config', '{"mcpServers":{}}',
            '--disable-slash-commands',
            '--no-session-persistence',
            '--system-prompt', REQUEST.systemPrompt,
        ]);
        // The empty-string values are real, separate argv entries.
        expect(call.argv[call.argv.indexOf('--tools') + 1]).toBe('');
        expect(call.argv[call.argv.indexOf('--setting-sources') + 1]).toBe('');
        // The prompt never travels on argv.
        expect(call.argv.join('\n')).not.toContain(REQUEST.prompt);
    });

    it('pipes the prompt on stdin', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope() });
        const large = `${REQUEST.prompt}\n${'transcript line\n'.repeat(20_000)}`;
        await new ClaudeCodeRunner({ binaryPath }).runStructured({ ...REQUEST, prompt: large });
        expect(invocations()[0].stdin).toBe(large);
    });

    it('runs in a fresh temp dir that is removed afterwards, on success and on failure', async () => {
        const ok = writeFakeClaude({ stdout: envelope() }, 'claude-ok');
        await new ClaudeCodeRunner({ binaryPath: ok }).runStructured(REQUEST);
        const failing = writeFakeClaude({ stdout: envelope({ is_error: true, result: 'API Error: overloaded' }) }, 'claude-fail');
        await expect(new ClaudeCodeRunner({ binaryPath: failing }).runStructured(REQUEST)).rejects.toThrow();

        const calls = invocations();
        expect(calls).toHaveLength(2);
        const tmpRoot = fs.realpathSync(os.tmpdir());
        for (const call of calls) {
            expect(path.basename(call.cwd)).toMatch(/^gemdex-claude-/);
            expect(fs.realpathSync(path.dirname(call.cwd))).toBe(tmpRoot);
            expect(fs.existsSync(call.cwd)).toBe(false);
        }
        expect(calls[0].cwd).not.toBe(calls[1].cwd);
        expect(fs.realpathSync(process.cwd())).not.toBe(calls[0].cwd);
    });

    it('strips nested-session env vars and sets the isolation env', async () => {
        process.env.CLAUDECODE = '1';
        process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
        process.env.CLAUDE_CODE_SSE_PORT = '12345';
        process.env.GEMDEX_FAKE_PASSTHROUGH = 'kept';
        const binaryPath = writeFakeClaude({ stdout: envelope() });
        await new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST);

        expect(invocations()[0].env).toEqual({
            CLAUDECODE: null,
            CLAUDE_CODE_ENTRYPOINT: null,
            CLAUDE_CODE_SSE_PORT: null,
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
            ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
            GEMDEX_FAKE_PASSTHROUGH: 'kept',
        });
        // The parent's own env is untouched.
        expect(process.env.CLAUDECODE).toBe('1');
    });

    it('returns structured_output, the served models, and the cost', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope() });
        const result = await new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST);
        expect(result).toEqual({
            output: { answer: 42 },
            models: ['claude-haiku-4-5-20251001'],
            costUsd: 0.0123,
        });
    });

    it('prefers structured_output over the result text', async () => {
        const binaryPath = writeFakeClaude({
            stdout: envelope({ structured_output: { answer: 1 }, result: '{"answer":2}' }),
        });
        expect((await new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST)).output).toEqual({ answer: 1 });
    });

    it('falls back to parsing the result text when structured_output is absent', async () => {
        const binaryPath = writeFakeClaude({
            stdout: envelope({ structured_output: undefined, result: '{"answer":7}', total_cost_usd: undefined }),
        });
        const result = await new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST);
        expect(result.output).toEqual({ answer: 7 });
        expect(result.costUsd).toBeUndefined();
        expect('costUsd' in result).toBe(false);
    });

    it('throws when neither structured_output nor result holds JSON', async () => {
        const binaryPath = writeFakeClaude({
            stdout: envelope({ structured_output: undefined, result: 'Sure! The answer is 42.' }),
        });
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code returned no structured output');
        const nullOutput = writeFakeClaude({ stdout: envelope({ structured_output: null, result: 'null' }) }, 'claude-null');
        await expect(new ClaudeCodeRunner({ binaryPath: nullOutput }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code returned no structured output');
    });

    it('throws on is_error and surfaces the first line of the message', async () => {
        const binaryPath = writeFakeClaude({
            stdout: envelope({ is_error: true, result: '\nAPI Error: 529 overloaded\nretry later' }),
        });
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code call failed: API Error: 529 overloaded');
    });

    it('throws on a non-zero exit even when the envelope looks successful', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope({ result: '' }), stderr: 'fatal: boom\n', exitCode: 1 });
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code call failed: fatal: boom');
    });

    it('throws on non-JSON stdout, preferring stderr for the detail', async () => {
        const withStderr = writeFakeClaude({ stdout: 'not json at all', stderr: 'Error: Invalid API key\n', exitCode: 1 }, 'claude-a');
        await expect(new ClaudeCodeRunner({ binaryPath: withStderr }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code returned no JSON result: Error: Invalid API key');

        const stdoutOnly = writeFakeClaude({ stdout: 'plain text answer' }, 'claude-b');
        await expect(new ClaudeCodeRunner({ binaryPath: stdoutOnly }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code returned no JSON result: plain text answer');

        const silent = writeFakeClaude({ stdout: '', exitCode: 3 }, 'claude-c');
        await expect(new ClaudeCodeRunner({ binaryPath: silent }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code returned no JSON result: exit code 3');

        const arrayOut = writeFakeClaude({ stdout: '[1,2]' }, 'claude-d');
        await expect(new ClaudeCodeRunner({ binaryPath: arrayOut }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code returned no JSON result');
    });

    it('refuses a result served by a different model family (silent fallback guard)', async () => {
        const binaryPath = writeFakeClaude({
            stdout: envelope({ modelUsage: { 'claude-opus-4-1-20250805': { inputTokens: 10 } } }),
        });
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code answered with claude-opus-4-1-20250805 instead of haiku');
    });

    it('refuses a result when any served model is outside the family', async () => {
        const binaryPath = writeFakeClaude({
            stdout: envelope({ modelUsage: { 'claude-haiku-4-5': {}, 'claude-sonnet-4-5': {} } }),
        });
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST))
            .rejects.toThrow(/answered with claude-haiku-4-5, claude-sonnet-4-5 instead of haiku/);
    });

    it('refuses a result with empty or missing modelUsage', async () => {
        const empty = writeFakeClaude({ stdout: envelope({ modelUsage: {} }) }, 'claude-empty');
        await expect(new ClaudeCodeRunner({ binaryPath: empty }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code answered with an unknown model instead of haiku');

        const missing = writeFakeClaude({ stdout: envelope({ modelUsage: undefined }) }, 'claude-missing');
        await expect(new ClaudeCodeRunner({ binaryPath: missing }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code answered with an unknown model instead of haiku');
    });

    it('rejects an unknown model before spawning anything', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope() });
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured({ ...REQUEST, model: 'opus' }))
            .rejects.toThrow('Unsupported model "opus". Supported: haiku');
        expect(invocations()).toEqual([]);
    });

    it('kills a hung call at the per-request timeout', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope(), sleepMs: 30_000 });
        const started = Date.now();
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured({ ...REQUEST, timeoutMs: 300 }))
            .rejects.toThrow('Claude Code call timed out');
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(fs.existsSync(invocations()[0].cwd)).toBe(false);
    });

    it('honors the runner-level default timeout', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope(), sleepMs: 30_000 });
        await expect(new ClaudeCodeRunner({ binaryPath, timeoutMs: 300 }).runStructured(REQUEST))
            .rejects.toThrow('Claude Code call timed out');
    });

    it('stops the child when the abort signal fires', async () => {
        const binaryPath = writeFakeClaude({ stdout: envelope(), sleepMs: 30_000 });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured({ ...REQUEST, signal: controller.signal }))
            .rejects.toThrow('Claude Code call cancelled');
    });

    it('resolves the binary from GEMDEX_CLAUDE_PATH when binaryPath is omitted', async () => {
        process.env.GEMDEX_CLAUDE_PATH = writeFakeClaude({ stdout: envelope() });
        const result = await new ClaudeCodeRunner().runStructured(REQUEST);
        expect(result.output).toEqual({ answer: 42 });
        expect(invocations()).toHaveLength(1);
    });

    it('throws a not-found error when no binary resolves, without leaking the temp dir', async () => {
        process.env.GEMDEX_CLAUDE_PATH = path.join(dir, 'does-not-exist');
        const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('gemdex-claude-'));
        await expect(new ClaudeCodeRunner().runStructured(REQUEST))
            .rejects.toThrow(/Claude Code CLI not found.*GEMDEX_CLAUDE_PATH/);
        const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('gemdex-claude-'));
        expect(after.filter((name) => !before.includes(name))).toEqual([]);
    });

    it('rejects with the spawn error when an explicit binaryPath does not exist', async () => {
        const binaryPath = path.join(dir, 'missing-claude');
        await expect(new ClaudeCodeRunner({ binaryPath }).runStructured(REQUEST)).rejects.toThrow(/ENOENT/);
    });
});

describe('checkClaudeCode', () => {
    it('reports missing when nothing resolves', async () => {
        process.env.GEMDEX_CLAUDE_PATH = path.join(dir, 'nope');
        const readiness = await checkClaudeCode();
        expect(readiness.status).toBe('missing');
        expect(readiness.message).toMatch(/Claude Code CLI not found/);
        expect(readiness.path).toBeUndefined();
        expect(readiness.checkedAt).toBeGreaterThan(0);
    });

    it('reports error, not missing, when an explicit binaryPath is not executable', async () => {
        // An explicit binaryPath bypasses resolution, so the spawn failure is
        // reported as an error.
        const notExecutable = path.join(dir, 'claude-noexec');
        fs.writeFileSync(notExecutable, '#!/bin/sh\necho hi\n', { mode: 0o644 });
        const readiness = await checkClaudeCode({ binaryPath: notExecutable });
        expect(readiness.status).toBe('error');
        expect(readiness.path).toBe(notExecutable);
        expect(readiness.message).toMatch(/EACCES/);

        const absent = await checkClaudeCode({ binaryPath: path.join(dir, 'absent') });
        expect(absent.status).toBe('error');
        expect(absent.message).toMatch(/ENOENT/);
        expect(invocations()).toEqual([]);
    });

    it('reports ready with version, path, and auth method', async () => {
        const binaryPath = writeFakeClaude();
        const readiness = await checkClaudeCode({ binaryPath });
        expect(readiness).toEqual({
            status: 'ready',
            path: binaryPath,
            version: '2.1.0 (Claude Code)',
            message: 'Signed in (claude.ai)',
            checkedAt: expect.any(Number),
        });
        // Only the two free probes run; no model call.
        expect(invocations().map((call) => call.argv)).toEqual([['--version'], ['auth', 'status', '--json']]);
    });

    it('reports ready without a message when authMethod is absent', async () => {
        const binaryPath = writeFakeClaude({ auth: { stdout: { loggedIn: true } } });
        const readiness = await checkClaudeCode({ binaryPath });
        expect(readiness.status).toBe('ready');
        expect(readiness.message).toBeUndefined();
    });

    it('resolves via GEMDEX_CLAUDE_PATH when no binaryPath is given', async () => {
        const binaryPath = writeFakeClaude();
        process.env.GEMDEX_CLAUDE_PATH = binaryPath;
        const readiness = await checkClaudeCode();
        expect(readiness.status).toBe('ready');
        expect(readiness.path).toBe(binaryPath);
    });

    it('reports unauthenticated when auth status says loggedIn is false', async () => {
        const binaryPath = writeFakeClaude({ auth: { stdout: { loggedIn: false }, exitCode: 1 } });
        const readiness = await checkClaudeCode({ binaryPath });
        expect(readiness.status).toBe('unauthenticated');
        expect(readiness.version).toBe('2.1.0 (Claude Code)');
        expect(readiness.path).toBe(binaryPath);
        expect(readiness.message).toMatch(/not logged in/);
    });

    it('reports error when --version fails', async () => {
        const binaryPath = writeFakeClaude({ version: { stdout: '', stderr: 'dyld: missing library\n', exitCode: 1 } });
        const readiness = await checkClaudeCode({ binaryPath });
        expect(readiness.status).toBe('error');
        expect(readiness.message).toBe('claude --version failed: dyld: missing library');
        expect(invocations()).toHaveLength(1);
    });

    it('reports error when auth status prints non-JSON', async () => {
        const binaryPath = writeFakeClaude({ auth: { stdout: 'unknown command "auth"', stderr: '', exitCode: 1 } });
        const readiness = await checkClaudeCode({ binaryPath });
        expect(readiness.status).toBe('error');
        expect(readiness.version).toBe('2.1.0 (Claude Code)');
        expect(readiness.message).toBe('claude auth status failed: unknown command "auth"');
    });
});

describe('resolveClaudeBinary', () => {
    it('honors GEMDEX_CLAUDE_PATH (trimmed) when it points at an executable file', () => {
        const binaryPath = writeFakeClaude();
        expect(resolveClaudeBinary({ GEMDEX_CLAUDE_PATH: binaryPath })).toBe(binaryPath);
        expect(resolveClaudeBinary({ GEMDEX_CLAUDE_PATH: `  ${binaryPath}\n` })).toBe(binaryPath);
    });

    it('returns null for a GEMDEX_CLAUDE_PATH that is missing, not executable, or a directory', () => {
        const notExecutable = path.join(dir, 'claude-noexec');
        fs.writeFileSync(notExecutable, 'x', { mode: 0o644 });
        const home = path.join(dir, 'home');
        const other = writeFakeClaude();
        // An invalid override never falls through to other locations.
        const env = { HOME: home, PATH: path.dirname(other) };
        expect(resolveClaudeBinary({ ...env, GEMDEX_CLAUDE_PATH: path.join(dir, 'missing') })).toBeNull();
        expect(resolveClaudeBinary({ ...env, GEMDEX_CLAUDE_PATH: notExecutable })).toBeNull();
        expect(resolveClaudeBinary({ ...env, GEMDEX_CLAUDE_PATH: dir })).toBeNull();
    });

    it('reads GEMDEX_CLAUDE_PATH from the Gemdex env file when absent from env', () => {
        const binaryPath = writeFakeClaude();
        (envManager.get as jest.Mock).mockImplementation((name: string) =>
            name === 'GEMDEX_CLAUDE_PATH' ? binaryPath : undefined);
        expect(resolveClaudeBinary({})).toBe(binaryPath);
    });

    it('prefers the native installer location under HOME over PATH', () => {
        const home = path.join(dir, 'home');
        const native = path.join(home, '.local', 'bin', 'claude');
        fs.mkdirSync(path.dirname(native), { recursive: true });
        fs.writeFileSync(native, '#!/bin/sh\n', { mode: 0o755 });
        const onPath = writeFakeClaude();
        expect(resolveClaudeBinary({ HOME: home, PATH: path.dirname(onPath) })).toBe(native);

        fs.rmSync(native);
        const legacyNative = path.join(home, '.claude', 'local', 'claude');
        fs.mkdirSync(path.dirname(legacyNative), { recursive: true });
        fs.writeFileSync(legacyNative, '#!/bin/sh\n', { mode: 0o755 });
        expect(resolveClaudeBinary({ HOME: home, PATH: path.dirname(onPath) })).toBe(legacyNative);
    });
});

describe('models and cost estimates', () => {
    it('offers haiku only, as the default', () => {
        expect(DEFAULT_CLAUDE_MODEL).toBe('haiku');
        expect(Object.keys(INFERENCE_MODELS)).toEqual(['haiku']);
        expect(INFERENCE_MODELS.haiku.family).toBe('haiku');
        expect(INFERENCE_PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(assertSupportedModel('haiku')).toBe(INFERENCE_MODELS.haiku);
        expect(() => assertSupportedModel('gemini-3.5-flash-lite')).toThrow(/Unsupported model/);
    });

    it('estimateCost returns one { model, usd } entry per model at list price', () => {
        const { inputUsdPerMTok, outputUsdPerMTok } = INFERENCE_MODELS.haiku;
        expect(estimateCost(1_000_000, 1_000_000)).toEqual([{ model: 'haiku', usd: inputUsdPerMTok + outputUsdPerMTok }]);
        expect(estimateCost(0, 0)).toEqual([{ model: 'haiku', usd: 0 }]);
        const [small] = estimateCost(12_345, 678);
        expect(Object.keys(small).sort()).toEqual(['model', 'usd']);
        expect(small.usd).toBe(Number(((12_345 * inputUsdPerMTok + 678 * outputUsdPerMTok) / 1_000_000).toFixed(2)));
    });

    it('estimateTokensForChars rounds up at 4 chars per token', () => {
        expect(estimateTokensForChars(0)).toBe(0);
        expect(estimateTokensForChars(1)).toBe(1);
        expect(estimateTokensForChars(8)).toBe(2);
        expect(estimateTokensForChars(9)).toBe(3);
    });
});
