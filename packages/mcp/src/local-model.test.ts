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
    getMlxStatus,
} from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import {
    installLocalModel,
    localModelStatus,
    localModelStatusWithLegacy,
    migrateLegacyMemories,
} from './local-model.js';

const DIM = 8;

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'Fake'; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: Array.from({ length: DIM }, (_, i) => (text.length + i) % 7 + 1), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embed(text)));
    }
}

/**
 * Write the runtime's `installed` marker without downloading anything. The
 * marker content is the install id, which is the last segment of the runtime
 * path getMlxStatus reports.
 */
function markModelInstalled(rootDir: string): void {
    const status = getMlxStatus(rootDir);
    fs.mkdirSync(status.path, { recursive: true });
    fs.writeFileSync(path.join(status.path, 'installed'), path.basename(status.path));
}

/** Store memories in the legacy Gemini index the way earlier releases did. */
async function seedLegacyMemories(lanceDir: string, blobDir: string, contents: string[]): Promise<void> {
    const legacy = new LocalMemoryBackend({
        embedding: new FakeEmbedding(),
        vectorDatabase: new LanceDBVectorDatabase({ uri: lanceDir }),
        collectionName: LEGACY_GEMINI_COLLECTION,
        blobStore: new FileBlobStore(blobDir),
    });
    for (const content of contents) await legacy.save({ content });
}

let rootDir: string;
let store: ClientConfigStore;
let savedLancePath: string | undefined;

beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-local-model-'));
    store = new ClientConfigStore({ rootDir });
    savedLancePath = process.env.LANCEDB_PATH;
    delete process.env.LANCEDB_PATH;
    // Every backend built by local-model.ts must stay inside the temp root.
    store.setEnv('LANCEDB_PATH', path.join(rootDir, 'lance'));
});

afterEach(() => {
    if (savedLancePath === undefined) delete process.env.LANCEDB_PATH;
    else process.env.LANCEDB_PATH = savedLancePath;
    fs.rmSync(rootDir, { recursive: true, force: true });
});

test('localModelStatus reports not-installed with the pinned model for a fresh root', () => {
    assert.deepEqual(localModelStatus(store), {
        installed: false,
        model: MLX_MODEL,
        status: 'not-installed',
    });
});

test('localModelStatus reports installed once the runtime marker exists', () => {
    markModelInstalled(rootDir);
    assert.deepEqual(localModelStatus(store), {
        installed: true,
        model: MLX_MODEL,
        status: 'installed',
    });
});

test('localModelStatusWithLegacy omits legacyMemories until the model is installed', async () => {
    const status = await localModelStatusWithLegacy(store);
    assert.equal(status.status, 'not-installed');
    assert.equal('legacyMemories' in status, false);
    assert.equal(fs.existsSync(path.join(rootDir, 'lance')), false, 'no store is opened before install');
});

test('localModelStatusWithLegacy counts memories still in the legacy Gemini index', async () => {
    markModelInstalled(rootDir);
    assert.equal((await localModelStatusWithLegacy(store)).legacyMemories, 0);

    await seedLegacyMemories(path.join(rootDir, 'lance'), path.join(rootDir, 'blobs'), [
        'legacy memory one about deploys',
        'legacy memory two about signing',
    ]);
    const status = await localModelStatusWithLegacy(store);
    assert.equal(status.status, 'installed');
    assert.equal(status.legacyMemories, 2);
});

test('migrateLegacyMemories refuses to run before install', async () => {
    await assert.rejects(
        migrateLegacyMemories(store, () => undefined),
        /Run npx gemdex-mcp install first/,
    );
});

test('migrateLegacyMemories with an empty legacy index completes and reports 0/0', async () => {
    markModelInstalled(rootDir);
    const progress: Array<[number, number]> = [];
    await migrateLegacyMemories(store, (completed, total) => progress.push([completed, total]));
    assert.deepEqual(progress, [[0, 0]]);
});

test('installLocalModel refuses while another install holds the lock, without downloading', async () => {
    // A live PID in the lock makes the installer fail before any network work.
    // On non-Apple-Silicon hosts the platform check fails even earlier.
    const lockDir = path.dirname(getMlxStatus(rootDir).path);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'install.lock'), `${process.pid}:held-by-test`);
    await assert.rejects(
        installLocalModel(store, () => undefined),
        /already in progress|Apple Silicon/,
    );
    assert.equal(localModelStatus(store).installed, false);
});
