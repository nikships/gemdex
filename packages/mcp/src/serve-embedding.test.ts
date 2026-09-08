import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { LanceDBVectorDatabase, LocalMemoryBackend } from 'gemdex-core';
import { ClientConfigStore } from './cli-config.js';
import { createConfig } from './config.js';
import { createServer, ServeContext } from './serve.js';
import { LocalModelStatus } from './local-model.js';
import { UnconfiguredGeminiEmbedding } from './embedding.js';

test('local embedding settings remain tokened, repairable without a Gemini key, and remote-isolated', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-mlx-settings-'));
    const keys = ['GEMINI_API_KEY', 'GEMDEX_EMBEDDING_PROVIDER'];
    const saved = keys.map((key) => process.env[key]);
    keys.forEach((key) => { delete process.env[key]; });
    const ctx: ServeContext = {
        config: createConfig(() => undefined), store: null,
        token: 'private-test-token', allowedOrigin: 'zero://app',
        clientConfigStore: new ClientConfigStore({ rootDir }),
    };
    const server = createServer(ctx);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'X-Gemdex-Token': 'private-test-token', 'Content-Type': 'application/json' };
    const post = (route: string, body = {}) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
        assert.equal((await fetch(base + '/settings/embedding')).status, 401);
        assert.equal((await fetch(base + '/settings/embedding', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
        const status = await fetch(base + '/settings/embedding', { headers });
        assert.equal(status.status, 200);
        assert.equal(((await status.json()) as LocalModelStatus).status, 'not-installed');
        assert.equal((await post('/settings/embedding/provider', { provider: 'mlx' })).status, 400);
        assert.equal((await post('/settings/embedding/provider', { provider: 'gemini' })).status, 400);
        await assert.rejects(fs.access(path.join(rootDir, '.env')));
        ctx.config.embeddingProvider = 'mlx';
        ctx.store = new LocalMemoryBackend({ embedding: new UnconfiguredGeminiEmbedding(),
            vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(rootDir, 'lance') }) });
        const config = await (await fetch(base + '/config')).json() as { configured: boolean; needsKey: boolean };
        assert.equal(config.configured, true);
        assert.equal(config.needsKey, false);
        assert.equal((await fetch(base + '/memories', { headers })).status, 200);
        assert.equal((await fetch(base + '/memories')).status, 401);
        ctx.config.embeddingProvider = 'gemini';
        ctx.store = null;
        ctx.config.mode = 'remote';
        assert.equal((await post('/settings/embedding/install')).status, 400);
        assert.equal((await post('/settings/embedding/migrate')).status, 400);
        ctx.config.mode = 'local';
        ctx.localModelJob = { provider: 'gemini', installed: false, model: 'test', status: 'installing' };
        assert.equal((await post('/settings/embedding/install')).status, 409);
        assert.equal((await post('/settings/mode', { mode: 'remote' })).status, 409);
        ctx.localModelJob = undefined;
        if (process.platform !== 'darwin' || process.arch !== 'arm64') {
            assert.equal((await post('/settings/embedding/install')).status, 202);
            // Unsupported-platform refusal is an observable job failure, not silent Gemini fallback.
            for (let i = 0; i < 20; i++) {
                const job = await (await fetch(base + '/settings/embedding', { headers })).json() as LocalModelStatus;
                if (job.status === 'error') {
                    assert.match(job.message ?? '', /Apple Silicon|macOS/);
                    assert.equal(job.provider, 'gemini');
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const terminal = await (await fetch(base + '/settings/embedding', { headers })).json() as LocalModelStatus;
            assert.equal(terminal.status, 'error');
        }
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
        await fs.rm(rootDir, { recursive: true, force: true });
    }
});
