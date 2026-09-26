import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Embedding } from 'gemdex-core';
import { createPostgresPool } from '../dist/postgres.js';
import { createConfiguredStore, createServer } from '../dist/server.js';

const DATABASE_URL = process.env.BYOI_TEST_DATABASE_URL;
const TOKEN = 'byoi-integration-token';
const DIMENSION = 3072;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixturePath = path.join(repoRoot, 'packages/app/assets/brand/logo-mark-256.png');

if (!DATABASE_URL) {
    throw new Error(
        'BYOI_TEST_DATABASE_URL is required. Start Postgres with pgvector and ' +
        'set a dedicated test database URL.',
    );
}

function log(message) {
    process.stderr.write(`[byoi-integration] ${message}\n`);
}

function hash(value) {
    let result = 2166136261;
    for (const byte of Buffer.from(value)) {
        result ^= byte;
        result = Math.imul(result, 16777619);
    }
    return result >>> 0;
}

function vectorFor(value) {
    const vector = new Array(DIMENSION).fill(0);
    const first = hash(`a:${value}`) % DIMENSION;
    const second = hash(`b:${value}`) % DIMENSION;
    vector[first] = 1;
    vector[second] += 0.5;
    return { vector, dimension: DIMENSION };
}

class DeterministicEmbedding extends Embedding {
    maxTokens = 8192;

    async detectDimension() {
        return DIMENSION;
    }

    async embed(text) {
        return vectorFor(`text:${this.preprocessText(text).toLowerCase()}`);
    }

    async embedBatch(texts) {
        return Promise.all(texts.map((text) => this.embed(text)));
    }

    async embedContentBatch(contents) {
        return contents.map((content) => {
            if (typeof content === 'string') {
                return vectorFor(`text:${content.toLowerCase()}`);
            }
            return vectorFor(`media:${content.inlineData.mimeType}:${content.inlineData.data}`);
        });
    }

    getDimension() {
        return DIMENSION;
    }

    getProvider() {
        return 'deterministic-byoi-test';
    }

    isMultimodal() {
        return true;
    }
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
    if (!server?.listening) return;
    await new Promise((resolve) => server.close(resolve));
}

function api(baseUrl) {
    return async (route, options = {}) => {
        const response = await fetch(`${baseUrl}/v1${route}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
                ...options.headers,
            },
        });
        const body = response.headers.get('content-type')?.includes('application/json')
            ? await response.json()
            : Buffer.from(await response.arrayBuffer());
        assert.equal(
            response.ok,
            true,
            `${options.method ?? 'GET'} ${route} returned ${response.status}: ${JSON.stringify(body)}`,
        );
        return body;
    };
}

async function run() {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-byoi-'));
    const blobDir = path.join(tempRoot, 'blobs');
    const pool = createPostgresPool(DATABASE_URL);
    let server;

    try {
        log('creating real Postgres/pgvector backend with deterministic embedding');
        const store = await createConfiguredStore(
            {
                host: '127.0.0.1',
                port: 0,
                token: TOKEN,
                unsafeDevNoAuth: false,
                allowedOrigins: [],
                databaseUrl: DATABASE_URL,
                embeddingModel: 'deterministic-byoi-test',
                blobStore: { kind: 'file', directory: blobDir },
            },
            { pool, embedding: new DeterministicEmbedding() },
        );
        assert(store, 'configured BYOI backend was not created');

        server = createServer({ store, token: TOKEN });
        const baseUrl = await listen(server);
        const call = api(baseUrl);
        log(`server listening at ${baseUrl}`);

        const health = await fetch(`${baseUrl}/v1/health`);
        assert.deepEqual(await health.json(), { ok: true });
        const unauthorized = await fetch(`${baseUrl}/v1/memories`);
        assert.equal(unauthorized.status, 401, 'data routes must require auth');

        const fixtureBytes = await fs.readFile(fixturePath);
        const longContent = [
            'START-OF-PARENT: deployment handbook.',
            'a'.repeat(1800),
            'The deep retrieval marker is ORBITAL-CEDAR-9417.',
            'b'.repeat(1800),
            'END-OF-PARENT: recovery checklist.',
        ].join('\n\n');

        log('saving a long parent memory with an image attachment');
        const saved = await call('/memories', {
            method: 'POST',
            body: JSON.stringify({
                title: 'BYOI integration parent',
                content: longContent,
                attachments: [{
                    mimeType: 'image/png',
                    data: fixtureBytes.toString('base64'),
                    caption: 'Gemdex logo integration fixture',
                }],
            }),
        });
        const memoryId = saved.memory?.id;
        assert(memoryId);

        log('verifying a deep chunk hit returns the whole parent');
        const recalled = await call('/recall', {
            method: 'POST',
            body: JSON.stringify({ query: 'ORBITAL-CEDAR-9417', limit: 5 }),
        });
        assert.equal(recalled.results[0]?.id, memoryId);
        assert.equal(recalled.results[0]?.content, longContent);

        log('updating the memory title in place');
        await call(`/memories/${encodeURIComponent(memoryId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ title: 'BYOI integration parent updated' }),
        });
        const { memory: stored } = await call(`/memories/${encodeURIComponent(memoryId)}`);
        assert.equal(stored.title, 'BYOI integration parent updated');
        assert.equal(stored.content, longContent);
        assert.equal(stored.attachments.length, 1);

        log('recalling by media');
        const mediaResults = await call('/recall', {
            method: 'POST',
            body: JSON.stringify({
                limit: 5,
                attachments: [{ mimeType: 'image/png', data: fixtureBytes.toString('base64') }],
            }),
        });
        assert.equal(mediaResults.results[0]?.id, memoryId);

        const attachmentId = stored.attachments[0].id;
        const attachmentBytes = await call(
            `/memories/${encodeURIComponent(memoryId)}/attachments/${encodeURIComponent(attachmentId)}`,
        );
        assert.deepEqual(attachmentBytes, fixtureBytes);

        log('exporting, deleting, and importing');
        const exported = await call('/export');
        assert.equal(exported.records.length, 1);
        assert.equal(exported.records[0].attachments[0].data, fixtureBytes.toString('base64'));

        await call(`/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
        const missing = await fetch(`${baseUrl}/v1/memories/${encodeURIComponent(memoryId)}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(missing.status, 404);

        const imported = await call('/import', { method: 'POST', body: JSON.stringify(exported) });
        assert.deepEqual(imported, { imported: 1, failed: 0, errors: [] });
        const { memory: restored } = await call(`/memories/${encodeURIComponent(memoryId)}`);
        assert.equal(restored.content, longContent);
        const restoredBytes = await call(
            `/memories/${encodeURIComponent(memoryId)}/attachments/${encodeURIComponent(restored.attachments[0].id)}`,
        );
        assert.deepEqual(restoredBytes, fixtureBytes);

        const blobFiles = await fs.readdir(path.join(blobDir, memoryId), { recursive: true });
        assert(blobFiles.length > 0, 'file blob store did not persist attachment bytes');

        log('PASS: server, pgvector, and file blob flows completed');
    } catch (error) {
        log(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
        try {
            const dbState = await pool.query(`
                SELECT
                    (SELECT count(*) FROM gemdex_memory_documents) AS documents,
                    (SELECT count(*) FROM gemdex_memory_chunks) AS chunks,
                    (SELECT count(*) FROM gemdex_memory_attachments) AS attachments
            `);
            log(`database state: ${JSON.stringify(dbState.rows[0])}`);
        } catch (diagnosticError) {
            log(`database diagnostics failed: ${String(diagnosticError)}`);
        }
        throw error;
    } finally {
        await closeServer(server);
        await pool.end().catch(() => undefined);
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

await run();
