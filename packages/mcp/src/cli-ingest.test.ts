import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    INFERENCE_PRICING_AS_OF,
    IngestLedgerStore,
    IngestManager,
} from 'gemdex-core';
import type {
    AttachmentBytes,
    ClaudeCodeReadiness,
    Digester,
    ImportRecordsResult,
    IngestProgress,
    IngestRunOptions,
    IngestScanResult,
    IngestTarget,
    Memory,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    ParsedSession,
    SaveResult,
    SessionDigest,
    SessionFile,
} from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { runCli } from './cli.js';

let rootDir: string;
let savedHome: string | undefined;

beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-cli-ingest-'));
    savedHome = process.env.HOME;
});

afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(rootDir, { recursive: true, force: true });
});

/** Records digests the ingest pipeline writes; only importRecords is exercised. */
class RecordingBackend implements MemoryBackend {
    imported: MemoryExportRecord[] = [];
    async save(): Promise<SaveResult> { throw new Error('not implemented'); }
    async recall(): Promise<MemoryRecallResult[]> { return []; }
    async update(): Promise<Memory> { throw new Error('not implemented'); }
    async updateAttachmentCaptions(): Promise<Memory> { throw new Error('not implemented'); }
    async get(): Promise<Memory | null> { return null; }
    async list(): Promise<MemorySummary[]> { return []; }
    async delete(): Promise<void> {}
    async exportAll(): Promise<MemoryExportRecord[]> { return []; }
    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        this.imported.push(...records);
        return { imported: records.length, failed: 0, errors: [] };
    }
    async readAttachment(): Promise<AttachmentBytes | null> { return null; }
}

function sessionFile(index: number): SessionFile {
    return { source: 'claude', filePath: `/s/${index}.jsonl`, mtimeMs: 1, size: 1 };
}

interface FakeManagerState {
    scanResult: IngestScanResult;
    runResult: IngestProgress;
    runs: IngestRunOptions[];
    targets: IngestTarget[];
    /** Called inside run(), after it starts and before it resolves. */
    duringRun?: (state: FakeManagerState) => void;
    progress: IngestProgress;
}

function makeState(pendingCount: number): FakeManagerState {
    const files = Array.from({ length: pendingCount }, (_, index) => sessionFile(index));
    return {
        scanResult: {
            buckets: { newFiles: [...files], changedFiles: [], upToDate: [], skippedActive: [] },
            processableFiles: files,
            skippedTrivialFiles: [],
            pendingCount,
            estimatedInputTokens: 12_345,
            estimatedOutputTokens: 800 * pendingCount,
            estimates: [{ model: 'haiku', usd: 1.23 }],
        },
        runResult: { state: 'done', processed: pendingCount, failed: 0, skipped: 0, total: pendingCount },
        runs: [],
        targets: [],
        progress: { state: 'idle', processed: 0, failed: 0, skipped: 0, total: 0 },
    };
}

function fakeManager(state: FakeManagerState): IngestManager {
    const manager: Pick<IngestManager, 'scan' | 'run' | 'getProgress' | 'isRunning' | 'cancel'> = {
        scan: () => state.scanResult,
        run: async (options, target) => {
            state.runs.push(options);
            state.targets.push(target);
            state.duringRun?.(state);
            state.progress = state.runResult;
            return state.runResult;
        },
        getProgress: () => ({ ...state.progress }),
        isRunning: () => false,
        cancel: () => undefined,
    };
    return manager as IngestManager;
}

interface RunOptions {
    manager?: IngestManager;
    checkClaudeCode?: () => Promise<ClaudeCodeReadiness>;
    backend?: MemoryBackend;
}

interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    claudeChecks: number;
    backendsCreated: number;
}

const readyClaude = async (): Promise<ClaudeCodeReadiness> => ({ status: 'ready', version: '2.1.0', checkedAt: 1 });

async function run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    let stdout = '';
    let stderr = '';
    let claudeChecks = 0;
    let backendsCreated = 0;
    const checker = options.checkClaudeCode ?? readyClaude;
    const code = await runCli(args, {
        store: new ClientConfigStore({ rootDir }),
        io: {
            stdout: (message) => { stdout += message; },
            stderr: (message) => { stderr += message; },
        },
        ...(options.manager && { createIngestManager: () => options.manager! }),
        createBackend: () => {
            backendsCreated += 1;
            return options.backend ?? new RecordingBackend();
        },
        checkClaudeCode: () => {
            claudeChecks += 1;
            return checker();
        },
    });
    return { code, stdout, stderr, claudeChecks, backendsCreated };
}

test('ingest-history --dry-run prints the scan and list-price cost table without checking Claude Code', async () => {
    const state = makeState(3);
    const result = await run(['ingest-history', '--dry-run', '--source', rootDir], { manager: fakeManager(state) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Sessions — new: 3, previously ingested and changed \(skipped\): 0, up-to-date: 0, active \(skipped\): 0/);
    assert.match(result.stdout, /Estimated input tokens: ~12,345/);
    assert.ok(result.stdout.includes(`Cost at Anthropic API list price (as of ${INFERENCE_PRICING_AS_OF}):`));
    assert.match(result.stdout, /\* haiku\s+\$1\.23/);
    assert.match(result.stdout, /subscription login is not billed per token/);
    assert.equal(state.runs.length, 0);
    assert.equal(result.claudeChecks, 0);
    assert.equal(result.backendsCreated, 0);
});

test('ingest-history reports trivial candidates and never reprocesses changed sessions', async () => {
    const state = makeState(1);
    state.scanResult.skippedTrivialFiles.push(sessionFile(99));
    state.scanResult.buckets.changedFiles.push(sessionFile(50));
    state.scanResult.buckets.upToDate.push(sessionFile(51), sessionFile(52));
    state.scanResult.buckets.skippedActive.push(sessionFile(53));

    const result = await run(['ingest-history', '--dry-run', '--source', rootDir], { manager: fakeManager(state) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /new: 1, previously ingested and changed \(skipped\): 1, up-to-date: 2, active \(skipped\): 1/);
    assert.match(result.stdout, /Skipped trivial candidates: 1/);
    assert.match(result.stdout, /Previously ingested sessions are never reprocessed/);
});

test('ingest-history reports nothing to do without checking Claude Code', async () => {
    const state = makeState(0);
    const result = await run(['ingest-history', '--source', rootDir], { manager: fakeManager(state) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Nothing to ingest/);
    assert.doesNotMatch(result.stdout, /Cost at/);
    assert.equal(state.runs.length, 0);
    assert.equal(result.claudeChecks, 0);
});

for (const readiness of [
    { status: 'missing' as const, message: 'Claude Code CLI not found.', checkedAt: 1 },
    { status: 'unauthenticated' as const, message: 'Claude Code is not logged in.', path: '/opt/claude', checkedAt: 1 },
    { status: 'error' as const, message: 'claude --version failed: boom', checkedAt: 1 },
]) {
    test(`ingest-history refuses to digest when Claude Code is ${readiness.status}`, async () => {
        const state = makeState(2);
        const result = await run(['ingest-history', '--source', rootDir], {
            manager: fakeManager(state),
            checkClaudeCode: async () => readiness,
        });
        assert.equal(result.code, 1);
        assert.ok(
            result.stderr.includes(`Error: Claude Code is not ready: ${readiness.status} — ${readiness.message}`),
            result.stderr,
        );
        // The estimate is still shown so the user knows what they would run.
        assert.match(result.stdout, /Cost at Anthropic API list price/);
        assert.equal(result.claudeChecks, 1);
        assert.equal(state.runs.length, 0);
        assert.equal(result.backendsCreated, 0);
        assert.doesNotMatch(result.stderr, /\[ingest\]/);
    });
}

test('ingest-history runs through the local backend, ticks progress, and reports the summary', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const state = makeState(3);
    state.duringRun = (current) => {
        current.progress = { state: 'running', processed: 1, failed: 1, skipped: 0, total: 3 };
        t.mock.timers.tick(1000);
        current.progress = { state: 'running', processed: 2, failed: 1, skipped: 0, total: 3 };
        t.mock.timers.tick(1000);
    };
    state.runResult = { state: 'done', processed: 3, failed: 0, skipped: 2, total: 3 };
    const backend = new RecordingBackend();

    const result = await run(['ingest-history', '--source', rootDir, '--source', 'factory'], {
        manager: fakeManager(state),
        backend,
    });

    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes('\r[ingest] 2/3 (failed: 1)  '), JSON.stringify(result.stderr));
    assert.ok(result.stderr.includes('\r[ingest] 3/3 (failed: 1)  '), JSON.stringify(result.stderr));
    assert.match(result.stdout, /Done — Ingested: 3, Failed: 0, Skipped \(trivial\/unchanged\): 2\./);
    assert.equal(result.claudeChecks, 1);
    assert.equal(result.backendsCreated, 1);

    assert.equal(state.runs.length, 1);
    const [options] = state.runs;
    assert.equal(options.model, 'haiku');
    assert.deepEqual(options.folders[0], { source: 'custom', path: rootDir });
    assert.equal(options.folders[1].source, 'factory');
    assert.equal(state.targets[0], backend);
});

test('ingest-history stops ticking after the run finishes', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const state = makeState(1);
    const result = await run(['ingest-history', '--source', rootDir], { manager: fakeManager(state) });
    assert.equal(result.code, 0);
    const before = result.stderr;
    t.mock.timers.tick(5000);
    assert.equal(result.stderr, before);
    assert.doesNotMatch(before, /\[ingest\]/);
});

test('ingest-history exits 1 when any session fails', async () => {
    const state = makeState(2);
    state.runResult = { state: 'done', processed: 1, failed: 1, skipped: 0, total: 2 };
    const result = await run(['ingest-history', '--source', rootDir], { manager: fakeManager(state) });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Done — Ingested: 1, Failed: 1/);
});

test('ingest-history rejects unknown models before scanning', async () => {
    const state = makeState(2);
    let scanned = false;
    const manager = fakeManager(state);
    const scan = manager.scan.bind(manager);
    manager.scan = (folders) => { scanned = true; return scan(folders); };

    const result = await run(['ingest-history', '--model', 'gemini-3.5-flash-lite', '--source', rootDir], { manager });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unsupported model "gemini-3\.5-flash-lite"\. Supported: haiku/);
    assert.equal(scanned, false);
});

test('ingest-history accepts the default model explicitly and requires a --source value', async () => {
    const state = makeState(1);
    const explicit = await run(['ingest-history', '--model', 'haiku', '--source', rootDir], { manager: fakeManager(state) });
    assert.equal(explicit.code, 0);
    assert.equal(state.runs[0].model, 'haiku');

    const missing = await run(['ingest-history', '--source'], { manager: fakeManager(makeState(1)) });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--source value is required/);
});

test('ingest-history without --source fails clearly when no preset folders exist', async () => {
    process.env.HOME = rootDir;
    const result = await run(['ingest-history'], { manager: fakeManager(makeState(1)) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No session folders found/);
});

test('ingest-history without --source uses the preset folders that exist', async () => {
    process.env.HOME = rootDir;
    fs.mkdirSync(path.join(rootDir, '.factory', 'sessions'), { recursive: true });
    const state = makeState(1);
    const result = await run(['ingest-history'], { manager: fakeManager(state) });
    assert.equal(result.code, 0);
    assert.deepEqual(state.runs[0].folders, [{ source: 'factory', path: path.join(rootDir, '.factory', 'sessions') }]);
});

/** A Claude Code JSONL transcript with enough real conversation to be non-trivial. */
function writeSession(filePath: string, sessionId: string): void {
    const text = `Session ${sessionId}: configure the release pipeline to sign and notarize builds. `.repeat(4);
    const lines = [
        { type: 'user', sessionId, cwd: '/repo', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } },
        { type: 'assistant', sessionId, timestamp: '2026-01-01T00:05:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    // Older than the active-session window so the scanner treats it as finished.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(filePath, old, old);
}

class FakeDigester implements Digester {
    readonly model = 'haiku';
    digested: string[] = [];
    async digest(session: ParsedSession): Promise<SessionDigest> {
        this.digested.push(session.sessionId);
        return {
            title: `Digest of ${session.sessionId}`,
            whatWasDone: 'Configured signing and notarization.',
            howToReproduce: ['Run the release script'],
            toolsAndServices: ['notarytool'],
            credentialsAndConfig: [],
            gotchas: [],
        };
    }
}

test('ingest-history end to end: real manager with an injected digester writes one digest per session', async () => {
    const sessions = path.join(rootDir, 'sessions');
    writeSession(path.join(sessions, 'alpha.jsonl'), 'alpha');
    writeSession(path.join(sessions, 'beta.jsonl'), 'beta');
    const stub = path.join(sessions, 'stub.jsonl');
    fs.writeFileSync(stub, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(stub, old, old);

    const digester = new FakeDigester();
    const models: Array<string | undefined> = [];
    const ledger = new IngestLedgerStore({ rootDir: path.join(rootDir, 'gemdex') });
    const makeManager = () => new IngestManager({
        ledger,
        createDigester: (model) => { models.push(model); return digester; },
    });
    const backend = new RecordingBackend();

    const first = await run(['ingest-history', '--source', sessions], { manager: makeManager(), backend });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Sessions — new: 2/);
    assert.match(first.stdout, /Skipped trivial candidates: 1/);
    assert.match(first.stdout, /\* haiku\s+\$\d+\.\d{2}/);
    assert.match(first.stdout, /Done — Ingested: 2, Failed: 0/);
    assert.deepEqual(models, ['haiku']);
    assert.deepEqual(digester.digested.sort(), ['alpha', 'beta']);
    assert.deepEqual(backend.imported.map((record) => record.id).sort(), ['chat:custom:alpha', 'chat:custom:beta']);
    const alpha = backend.imported.find((record) => record.id === 'chat:custom:alpha')!;
    assert.equal(alpha.title, 'Digest of alpha');
    assert.equal(alpha.attachments?.[0]?.mimeType, 'text/plain');

    // Ingested sessions are recorded in the ledger and never digested again.
    const second = await run(['ingest-history', '--source', sessions], { manager: makeManager(), backend });
    assert.equal(second.code, 0);
    assert.match(second.stdout, /new: 0, previously ingested and changed \(skipped\): 0, up-to-date: 2/);
    assert.match(second.stdout, /Nothing to ingest/);
    assert.equal(digester.digested.length, 2);
    assert.equal(second.claudeChecks, 0);
});
