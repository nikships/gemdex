import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    Embedding,
    EmbeddingVector,
    FileBlobStore,
    LanceDBVectorDatabase,
    LEGACY_GEMINI_COLLECTION,
    LocalMemoryBackend,
    MLX_MODEL,
    TRANSCRIPT_ATTACHMENT_CAPTION,
    TRANSCRIPT_ATTACHMENT_ID,
    getMlxStatus,
} from 'gemdex-core';
import type {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    ClaudeCodeReadiness,
    ImportRecordsResult,
    Memory,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    SaveResult,
} from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { runCli } from './cli.js';

const DIM = 8;

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'Fake'; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: Array.from({ length: DIM }, (_, i) => (text.length + i) % 5 + 1), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embed(text)));
    }
}

/** In-memory backend covering what backfill-transcripts touches (list/get/importRecords). */
class BackfillBackend implements MemoryBackend {
    memories = new Map<string, Memory>();
    imported: MemoryExportRecord[] = [];
    rejectIds = new Set<string>();
    getFailures = new Set<string>();

    async save(): Promise<SaveResult> { throw new Error('not implemented'); }
    async recall(): Promise<MemoryRecallResult[]> { return []; }
    async update(): Promise<Memory> { throw new Error('not implemented'); }
    async updateAttachmentCaptions(_id: string, _captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        throw new Error('not implemented');
    }
    async get(id: string): Promise<Memory | null> {
        if (this.getFailures.has(id)) throw new Error('store read failed');
        return this.memories.get(id) ?? null;
    }
    async list(): Promise<MemorySummary[]> {
        return [...this.memories.values()].map((memory) => ({
            id: memory.id,
            title: memory.title,
            preview: memory.content.slice(0, 40),
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            attachments: memory.attachments,
        }));
    }
    async delete(): Promise<void> {}
    async exportAll(): Promise<MemoryExportRecord[]> {
        throw new Error('backfill must never export the whole pool');
    }
    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        const record = records[0];
        if (this.rejectIds.has(record.id)) {
            return { imported: 0, failed: 1, errors: [{ index: 0, id: record.id, error: 'rejected by store' }] };
        }
        this.imported.push(record);
        return { imported: 1, failed: 0, errors: [] };
    }
    async readAttachment(): Promise<AttachmentBytes | null> { return null; }
}

function digestMemory(id: string, content: string, attachments: Memory['attachments'] = []): Memory {
    return { id, title: id, content, attachments, createdAt: 1, updatedAt: 2 };
}

/** A Claude Code JSONL transcript with enough real conversation to be non-trivial. */
function writeClaudeSession(filePath: string, sessionId: string): void {
    const text = 'Explain how to notarize the macOS build with notarytool and staple the ticket. '.repeat(4);
    const lines = [
        { type: 'user', sessionId, cwd: '/repo', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } },
        { type: 'assistant', sessionId, timestamp: '2026-01-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

function markModelInstalled(rootDir: string): void {
    const status = getMlxStatus(rootDir);
    fs.mkdirSync(status.path, { recursive: true });
    fs.writeFileSync(path.join(status.path, 'installed'), path.basename(status.path));
}

/**
 * A stand-in `claude` executable: answers `--version` and `auth status --json`
 * and records every invocation, so the real probe runs without the real CLI.
 */
function writeFakeClaude(dir: string, loggedIn: boolean): { binary: string; log: string } {
    const binary = path.join(dir, 'fake-claude');
    const log = path.join(dir, 'fake-claude.log');
    fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
    process.stdout.write('9.8.7 (Claude Code)\\n');
} else if (args[0] === 'auth') {
    process.stdout.write(JSON.stringify({ loggedIn: ${loggedIn}, authMethod: 'claude.ai' }));
} else {
    process.stderr.write('unexpected invocation');
    process.exit(2);
}
`, { mode: 0o755 });
    return { binary, log };
}

const ENV_KEYS = ['LANCEDB_PATH', 'GEMDEX_CLAUDE_PATH'];
let rootDir: string;
let store: ClientConfigStore;
let savedEnv: Array<string | undefined>;

beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-cli-'));
    store = new ClientConfigStore({ rootDir });
    savedEnv = ENV_KEYS.map((key) => process.env[key]);
    ENV_KEYS.forEach((key) => { delete process.env[key]; });
    store.setEnv('LANCEDB_PATH', path.join(rootDir, 'lance'));
});

afterEach(() => {
    ENV_KEYS.forEach((key, index) => {
        if (savedEnv[index] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[index];
    });
    fs.rmSync(rootDir, { recursive: true, force: true });
});

interface RunOptions {
    backend?: MemoryBackend;
    checkClaudeCode?: () => Promise<ClaudeCodeReadiness>;
}

async function run(args: string[], options: RunOptions = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const code = await runCli(args, {
        store,
        io: {
            stdout: (message) => { stdout += message; },
            stderr: (message) => { stderr += message; },
        },
        createBackend: () => options.backend ?? new BackfillBackend(),
        ...(options.checkClaudeCode && { checkClaudeCode: options.checkClaudeCode }),
    });
    return { code, stdout, stderr };
}

const ready = async (): Promise<ClaudeCodeReadiness> => ({
    status: 'ready', version: '2.1.0', path: '/opt/claude', checkedAt: 1,
});

test('non-CLI arguments fall through to the MCP server, including removed remote/Gemini verbs', async () => {
    for (const args of [
        [],
        ['serve'],
        ['remote', 'list'],
        ['mode', 'local'],
        ['init-remote', 'prod', 'https://memory.example.test'],
        ['import-local-to-remote'],
        ['sync-history'],
        ['setup', 'gemini'],
        ['embedding', 'mlx'],
        ['migrate-text'],
    ]) {
        const result = await run(args);
        assert.equal(result.code, null, `${args.join(' ')} must not be handled by the CLI`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
    }
});

test('install and migrate reject extra arguments with a usage error', async () => {
    const install = await run(['install', '--force']);
    assert.equal(install.code, 1);
    assert.match(install.stderr, /Usage: npx gemdex-mcp install/);

    const migrate = await run(['migrate', 'now']);
    assert.equal(migrate.code, 1);
    assert.match(migrate.stderr, /Usage: npx gemdex-mcp migrate/);
});

test('install surfaces installer refusals and never reports success', async () => {
    // A live PID holding the lock makes the installer stop before any
    // download; a non-Apple-Silicon host fails on the platform check first.
    const lockDir = path.dirname(getMlxStatus(rootDir).path);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'install.lock'), `${process.pid}:held-by-test`);

    const result = await run(['install']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Error: .*(already in progress|Apple Silicon)/);
    assert.doesNotMatch(result.stdout, /Local model installed/);
});

test('migrate refuses before the local model is installed', async () => {
    const result = await run(['migrate']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Run npx gemdex-mcp install first/);
    assert.equal(result.stdout, '');
});

test('migrate with nothing in the legacy index reports completion', async () => {
    markModelInstalled(rootDir);
    const result = await run(['migrate']);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Migrating memories: 0\/0/);
    assert.match(result.stdout, /Migration complete/);
});

test('status reports store path, model state and Claude Code readiness', async () => {
    const result = await run(['status'], { checkClaudeCode: ready });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(`Store: ${path.join(rootDir, 'lance').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stdout, new RegExp(`Local model: not-installed \\(${MLX_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.doesNotMatch(result.stdout, /Legacy memories/);
    assert.match(result.stdout, /Claude Code \(ingestion \+ hygiene\): ready \(2\.1\.0\) at \/opt\/claude/);
});

test('status reports a missing or signed-out Claude Code with its message', async () => {
    const missing = await run(['status'], {
        checkClaudeCode: async () => ({ status: 'missing', message: 'Claude Code CLI not found.', checkedAt: 1 }),
    });
    assert.equal(missing.code, 0);
    assert.match(missing.stdout, /Claude Code \(ingestion \+ hygiene\): missing — Claude Code CLI not found\./);

    const signedOut = await run(['status'], {
        checkClaudeCode: async () => ({ status: 'unauthenticated', message: 'Not logged in.', checkedAt: 1 }),
    });
    assert.match(signedOut.stdout, /unauthenticated — Not logged in\./);
});

test('status points at migrate when legacy Gemini memories remain', async () => {
    markModelInstalled(rootDir);
    const legacy = new LocalMemoryBackend({
        embedding: new FakeEmbedding(),
        vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(rootDir, 'lance') }),
        collectionName: LEGACY_GEMINI_COLLECTION,
        blobStore: new FileBlobStore(path.join(rootDir, 'blobs')),
    });
    await legacy.save({ content: 'legacy memory about release signing' });
    await legacy.save({ content: 'legacy memory about staging deploys' });
    await legacy.save({ content: 'legacy memory about database backups' });

    const result = await run(['status'], { checkClaudeCode: ready });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Local model: installed/);
    assert.match(result.stdout, /Legacy memories awaiting migration: 3 — run npx gemdex-mcp migrate/);
});

test('status probes the configured claude binary when no checker is injected', async () => {
    const fake = writeFakeClaude(rootDir, true);
    process.env.GEMDEX_CLAUDE_PATH = fake.binary;

    const result = await run(['status']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Claude Code \(ingestion \+ hygiene\): ready \(9\.8\.7 \(Claude Code\)\)/);
    assert.ok(result.stdout.includes(`at ${fake.binary}`));
    const calls = fs.readFileSync(fake.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls, [['--version'], ['auth', 'status', '--json']]);
});

test('status reports a signed-out claude binary as unauthenticated', async () => {
    process.env.GEMDEX_CLAUDE_PATH = writeFakeClaude(rootDir, false).binary;
    const result = await run(['status']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Claude Code \(ingestion \+ hygiene\): unauthenticated — Claude Code is not logged in/);
});

test('backfill-transcripts attaches, skips and reports each digest category', async () => {
    const sessionsDir = path.join(rootDir, 'sessions');
    const present = path.join(sessionsDir, 'present.jsonl');
    writeClaudeSession(present, 'present');
    const absent = path.join(sessionsDir, 'absent.jsonl');

    const backend = new BackfillBackend();
    backend.memories.set('chat:custom:present', digestMemory('chat:custom:present', `Digest\n---\nFull transcript: ${present}\n`));
    backend.memories.set('chat:custom:absent', digestMemory('chat:custom:absent', `Digest\n---\nFull transcript: ${absent}\n`));
    backend.memories.set('chat:custom:nopath', digestMemory('chat:custom:nopath', 'Digest with no footer'));
    backend.memories.set('chat:custom:done', digestMemory('chat:custom:done', 'Digest', [
        { id: TRANSCRIPT_ATTACHMENT_ID, kind: 'file', mimeType: 'text/plain', byteLength: 10, caption: TRANSCRIPT_ATTACHMENT_CAPTION },
    ]));
    backend.memories.set('plain-note', digestMemory('plain-note', `Not a digest\nFull transcript: ${present}\n`));

    const result = await run(['backfill-transcripts'], { backend });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /attached: 1\n/);
    assert.match(result.stdout, /already had transcript: 1\n/);
    assert.match(result.stdout, /missing file: 1\n/);
    assert.match(result.stdout, /no path footer: 1\n/);
    assert.match(result.stdout, /failed: 0\n/);
    assert.ok(result.stderr.includes(`Missing transcript for chat:custom:absent: ${absent}`));

    assert.equal(backend.imported.length, 1);
    const [record] = backend.imported;
    assert.equal(record.id, 'chat:custom:present');
    assert.equal(record.attachments?.length, 1);
    const attachment = record.attachments![0];
    assert.equal(attachment.id, TRANSCRIPT_ATTACHMENT_ID);
    assert.equal(attachment.mimeType, 'text/plain');
    assert.match(Buffer.from(attachment.data, 'base64').toString('utf8'), /notarize the macOS build/);
});

test('backfill-transcripts --dry-run counts attachable digests without importing', async () => {
    const present = path.join(rootDir, 'sessions', 'present.jsonl');
    writeClaudeSession(present, 'present');
    const backend = new BackfillBackend();
    backend.memories.set('chat:custom:present', digestMemory('chat:custom:present', `Digest\nFull transcript: ${present}\n`));

    const result = await run(['backfill-transcripts', '--dry-run'], { backend });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /\[dry-run\] would attach transcript to chat:custom:present/);
    assert.match(result.stdout, /Backfill transcripts \(dry-run\):/);
    assert.match(result.stdout, /attached: 1\n/);
    assert.equal(backend.imported.length, 0);
});

test('backfill-transcripts --force re-attaches digests that already have a transcript', async () => {
    const present = path.join(rootDir, 'sessions', 'present.jsonl');
    writeClaudeSession(present, 'present');
    const backend = new BackfillBackend();
    backend.memories.set('chat:custom:present', digestMemory('chat:custom:present', `Digest\nFull transcript: ${present}\n`, [
        { id: TRANSCRIPT_ATTACHMENT_ID, kind: 'file', mimeType: 'text/plain', byteLength: 3, caption: TRANSCRIPT_ATTACHMENT_CAPTION },
    ]));

    const skipped = await run(['backfill-transcripts'], { backend });
    assert.match(skipped.stdout, /already had transcript: 1\n/);
    assert.equal(backend.imported.length, 0);

    const forced = await run(['backfill-transcripts', '--force'], { backend });
    assert.equal(forced.code, 0);
    assert.match(forced.stdout, /attached: 1\n/);
    assert.equal(backend.imported.length, 1);
});

test('backfill-transcripts exits 1 when a read or import fails', async () => {
    const present = path.join(rootDir, 'sessions', 'present.jsonl');
    writeClaudeSession(present, 'present');
    const backend = new BackfillBackend();
    backend.memories.set('chat:custom:rejected', digestMemory('chat:custom:rejected', `Digest\nFull transcript: ${present}\n`));
    backend.memories.set('chat:custom:unreadable', digestMemory('chat:custom:unreadable', 'Digest'));
    backend.rejectIds.add('chat:custom:rejected');
    backend.getFailures.add('chat:custom:unreadable');

    const result = await run(['backfill-transcripts'], { backend });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /failed: 2\n/);
    assert.match(result.stderr, /Failed chat:custom:rejected: rejected by store/);
    assert.match(result.stderr, /Failed chat:custom:unreadable: store read failed/);
});
