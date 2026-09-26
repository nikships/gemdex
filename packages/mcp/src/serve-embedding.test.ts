import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
    Embedding,
    EmbeddingVector,
    FileBlobStore,
    LanceDBVectorDatabase,
    LEGACY_GEMINI_COLLECTION,
    LocalMemoryBackend,
    MLX_MODEL,
    getMlxStatus,
} from 'gemdex-core';
import type { MemoryBackend } from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { createConfig } from './config.js';
import type { LocalModelStatus } from './local-model.js';
import { INSTALL_HINT } from './memory.js';
import { createServer, ServeContext } from './serve.js';

const TOKEN = 'embedding-test-token';
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

function markModelInstalled(rootDir: string): void {
    const status = getMlxStatus(rootDir);
    fs.mkdirSync(status.path, { recursive: true });
    fs.writeFileSync(path.join(status.path, 'installed'), path.basename(status.path));
}

async function seedLegacyMemories(rootDir: string, count: number): Promise<void> {
    const legacy = new LocalMemoryBackend({
        embedding: new FakeEmbedding(),
        vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(rootDir, 'lance') }),
        collectionName: LEGACY_GEMINI_COLLECTION,
        blobStore: new FileBlobStore(path.join(rootDir, 'blobs')),
    });
    for (let i = 0; i < count; i++) await legacy.save({ content: `legacy memory number ${i} about release signing` });
}

let savedHome: string | undefined;
let savedLancePath: string | undefined;
let fakeHome: string;

before(() => {
    savedHome = process.env.HOME;
    savedLancePath = process.env.LANCEDB_PATH;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-embedding-home-'));
    process.env.HOME = fakeHome;
    delete process.env.LANCEDB_PATH;
});

after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedLancePath === undefined) delete process.env.LANCEDB_PATH;
    else process.env.LANCEDB_PATH = savedLancePath;
    fs.rmSync(fakeHome, { recursive: true, force: true });
});

let rootDir: string;
let ctx: ServeContext;
let base: string;
let closeServer: () => Promise<void>;
let built: number;

beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-embedding-'));
    const clientConfigStore = new ClientConfigStore({ rootDir });
    // local-model.ts builds its own backends from the saved config; keep them in the temp root.
    clientConfigStore.setEnv('LANCEDB_PATH', path.join(rootDir, 'lance'));
    built = 0;
    ctx = {
        config: createConfig(() => undefined),
        store: null,
        token: TOKEN,
        allowedOrigin: 'zero://app',
        clientConfigStore,
        claudeCode: { status: 'ready', checkedAt: 1 },
        checkClaudeCode: async () => ({ status: 'ready', checkedAt: 2 }),
        isModelInstalled: () => getMlxStatus(rootDir).installed,
        createBackend: () => {
            built += 1;
            return { list: async () => [] } as unknown as MemoryBackend;
        },
    };
    const server = createServer(ctx);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
});

afterEach(async () => {
    await closeServer();
    fs.rmSync(rootDir, { recursive: true, force: true });
});

const headers = { 'X-Gemdex-Token': TOKEN, 'Content-Type': 'application/json' };

function post(route: string): Promise<Response> {
    return fetch(base + route, { method: 'POST', headers, body: '{}' });
}

async function getStatus(): Promise<LocalModelStatus> {
    const res = await fetch(base + '/settings/embedding', { headers });
    assert.equal(res.status, 200);
    return (await res.json()) as LocalModelStatus;
}

async function waitForJob(predicate: (status: LocalModelStatus) => boolean): Promise<LocalModelStatus> {
    for (let i = 0; i < 200; i++) {
        const status = await getStatus();
        if (predicate(status)) return status;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`job did not settle: ${JSON.stringify(await getStatus())}`);
}

test('GET /settings/embedding requires the token and a matching origin', async () => {
    assert.equal((await fetch(base + '/settings/embedding')).status, 401);
    assert.equal((await fetch(base + '/settings/embedding', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(base + '/settings/embedding', { headers: { ...headers, Origin: 'zero://app' } })).status, 200);
});

test('GET /settings/embedding reports not-installed without legacyMemories before install', async () => {
    assert.deepEqual(await getStatus(), { installed: false, model: MLX_MODEL, status: 'not-installed' });
});

test('GET /settings/embedding counts legacy memories once the model is installed', async () => {
    markModelInstalled(rootDir);
    assert.deepEqual(await getStatus(), { installed: true, model: MLX_MODEL, status: 'installed', legacyMemories: 0 });

    await seedLegacyMemories(rootDir, 2);
    const status = await getStatus();
    assert.equal(status.status, 'installed');
    assert.equal(status.legacyMemories, 2);
});

test('POST to an unknown local model action answers 404', async () => {
    const res = await post('/settings/embedding/provider');
    assert.equal(res.status, 404);
    assert.equal(ctx.localModelJob, undefined);
});

test('POST /settings/embedding/migrate answers 400 with the install hint before install', async () => {
    const res = await post('/settings/embedding/migrate');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: INSTALL_HINT });
    assert.equal(ctx.localModelJob, undefined);
});

test('install and migrate answer 409 while another local model job is running', async () => {
    for (const status of ['installing', 'migrating'] as const) {
        ctx.localModelJob = { installed: false, model: MLX_MODEL, status };
        assert.equal((await post('/settings/embedding/install')).status, 409);
        assert.equal((await post('/settings/embedding/migrate')).status, 409);
        // GET reports the running job verbatim.
        assert.equal((await getStatus()).status, status);
    }
});

test('a finished or failed job does not block a new operation', async () => {
    markModelInstalled(rootDir);
    ctx.localModelJob = { installed: true, model: MLX_MODEL, status: 'error', message: 'previous failure' };
    const res = await post('/settings/embedding/migrate');
    assert.equal(res.status, 202);
    await waitForJob((status) => status.status !== 'migrating');
});

test('a model installed outside the sidecar mounts the store even after a failed install job', async () => {
    ctx.localModelJob = { installed: false, model: MLX_MODEL, status: 'error', message: 'offline' };
    assert.equal((await fetch(base + '/memories', { headers })).status, 503);

    markModelInstalled(rootDir);
    const res = await fetch(base + '/memories', { headers });
    assert.equal(res.status, 200);
    assert.equal(built, 1);
    assert.equal(ctx.localModelJob, undefined);
    assert.equal((await getStatus()).status, 'installed');
});

test('migrate runs as a job, then mounts the store and reports the new status', async () => {
    markModelInstalled(rootDir);
    const res = await post('/settings/embedding/migrate');
    assert.equal(res.status, 202);
    const accepted = (await res.json()) as LocalModelStatus;
    assert.equal(accepted.status, 'migrating');
    assert.equal(accepted.installed, true);
    // An installed model mounts the store on the request itself.
    const builtAtStart = built;
    assert.equal(builtAtStart, 1);

    const done = await waitForJob((status) => status.status !== 'migrating');
    assert.equal(done.status, 'installed');
    assert.equal(done.message, 'Migration complete.');
    assert.equal(done.legacyMemories, 0);
    assert.equal(done.completed, undefined, 'the final status is rebuilt, not the running job');
    assert.equal(built, builtAtStart + 1, 'the store is rebuilt after migration');
    assert.notEqual(ctx.store, null);

    const config = (await (await fetch(base + '/config')).json()) as { configured: boolean; embedding: LocalModelStatus };
    assert.equal(config.configured, true);
    assert.equal(config.embedding.message, 'Migration complete.');
});

test('a migrate that cannot embed reports an error job and keeps legacy memories', async () => {
    // The marker says installed but no runtime files exist, so the first
    // re-embed fails its integrity check (or the platform check off macOS)
    // before any MLX process starts.
    markModelInstalled(rootDir);
    await seedLegacyMemories(rootDir, 2);

    assert.equal((await post('/settings/embedding/migrate')).status, 202);
    const builtAtStart = built;
    const failed = await waitForJob((status) => status.status !== 'migrating');
    assert.equal(failed.status, 'error');
    assert.ok((failed.message ?? '').length > 0);
    assert.equal(failed.total, 2, 'progress reached the job before the failure');
    assert.equal(built, builtAtStart, 'a failed migration does not rebuild the store');
    assert.equal(failed.installed, true);
    assert.equal(failed.legacyMemories, 2, 'the error job still reports legacy memories so the app can offer a retry');

    // The mounted store never clears the error job, so later polls must keep the count too.
    const polled = await getStatus();
    assert.equal(polled.status, 'error');
    assert.equal(polled.legacyMemories, 2);
});

test('install runs as a job and surfaces installer refusals without downloading', async () => {
    // A live PID in the install lock stops the installer before any network
    // work; off Apple Silicon the platform check refuses first.
    const lockDir = path.dirname(getMlxStatus(rootDir).path);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'install.lock'), `${process.pid}:held-by-test`);

    const res = await post('/settings/embedding/install');
    assert.equal(res.status, 202);
    assert.equal(((await res.json()) as LocalModelStatus).status, 'installing');

    const failed = await waitForJob((status) => status.status !== 'installing');
    assert.equal(failed.status, 'error');
    assert.match(failed.message ?? '', /already in progress|Apple Silicon/);
    assert.equal(ctx.store, null);
    assert.equal(built, 0);

    const blocked = await fetch(base + '/memories', { headers });
    assert.equal(blocked.status, 503);
});
