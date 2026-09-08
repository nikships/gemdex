import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ClientConfigStore } from './cli-config.js';
import { runCli } from './cli.js';
import { MCP_TOOL_NAMES } from './tool-names.js';

test('fresh Claude Code stdio connection discovers all six tools and each explains setup without writes', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-onboard-'));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url))],
        env: { PATH: process.env.PATH ?? '', HOME: home, GEMINI_API_KEY: '', GEMDEX_MODE: '', GEMDEX_EMBEDDING_PROVIDER: '' },
        stderr: 'pipe',
    });
    const client = new Client({ name: 'fresh-claude-code', version: '1' });
    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), [...MCP_TOOL_NAMES]);
        for (const name of MCP_TOOL_NAMES) {
            const result = await client.callTool({ name, arguments: {} });
            assert.equal(result.isError, true);
            const text = JSON.stringify(result.content);
            assert.match(text, /Ask the user directly/);
            assert.match(text, /npx gemdex-mcp setup gemini/);
            assert.match(text, /npx gemdex-mcp install/);
            assert.match(text, /npx gemdex-mcp init-remote/);
        }
        await assert.rejects(fs.access(path.join(home, '.gemdex', 'lance')));
        await assert.rejects(fs.access(path.join(home, '.gemdex', '.env')));
        // Repair in-place: incomplete remote config stays discoverable, not a crash.
        const store = new ClientConfigStore({ rootDir: path.join(home, '.gemdex') });
        store.setEnv('GEMDEX_MODE', 'remote');
        const incomplete = await client.callTool({ name: 'get_memory', arguments: { id: 'missing' } });
        assert.equal(incomplete.isError, true);
        assert.match(JSON.stringify(incomplete.content), /init-remote/);
        assert.equal((await client.listTools()).tools.length, 6);
        let requests = 0;
        const remote = createServer((req, res) => {
            assert.equal(req.headers.authorization, 'Bearer test-token');
            requests++;
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        });
        await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
        try {
            store.setEnvValues({ GEMDEX_REMOTE_URL: `http://127.0.0.1:${(remote.address() as AddressInfo).port}`, GEMDEX_REMOTE_TOKEN: 'test-token' });
            const repaired = await client.callTool({ name: 'get_memory', arguments: { id: 'missing' } });
            assert.equal(requests, 1);
            assert.doesNotMatch(JSON.stringify(repaired.content), /needs setup/);
        } finally {
            remote.closeAllConnections();
            await new Promise<void>((resolve) => remote.close(() => resolve()));
        }
    } finally {
        await client.close();
        await fs.rm(home, { recursive: true, force: true });
    }
});

test('Gemini setup validates before securely persisting and does not leak rejected credentials', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-setup-'));
    const store = new ClientConfigStore({ rootDir });
    // Isolate tests from developer credentials/launch overrides.
    const keys = ['GEMINI_API_KEY', 'GEMDEX_MODE', 'GEMDEX_EMBEDDING_PROVIDER'];
    const saved = keys.map((key) => process.env[key]);
    keys.forEach((key) => { delete process.env[key]; });
    const messages: string[] = [];
    const key = 'unit-test-secret';
    const io = { stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s), readSecret: async () => key };
    try {
        store.setEnv('UNRELATED', 'keep');
        const before = await fs.readFile(store.envPath, 'utf8');
        const failed = await runCli(['setup', 'gemini'], { store, io, validateGeminiKey: async () => { throw new Error(key); } });
        assert.equal(failed, 1);
        assert.equal(await fs.readFile(store.envPath, 'utf8'), before);
        assert.equal(messages.join('').includes(key), false);
        const succeeded = await runCli(['setup', 'gemini'], { store, io, validateGeminiKey: async (candidate) => { assert.equal(candidate, key); } });
        assert.equal(succeeded, 0);
        assert.equal(store.getEnv('GEMDEX_EMBEDDING_PROVIDER'), 'gemini');
        assert.equal(store.getEnv('GEMINI_API_KEY'), key);
        assert.equal(store.getEnv('UNRELATED'), 'keep');
        assert.equal((await fs.stat(store.envPath)).mode & 0o777, 0o600);
        assert.equal(messages.join('').includes(key), false);
        assert.equal(await runCli(['install', '--unknown'], { store, io }), 1);
        assert.equal(await runCli(['embedding', 'mlx'], { store, io }), 1);
        assert.equal(store.getEnv('GEMDEX_EMBEDDING_PROVIDER'), 'gemini');
        store.setEnv('GEMDEX_MODE', 'remote');
        assert.equal(await runCli(['install'], { store, io }), 1);
        assert.match(messages.join(''), /local-only/);
    } finally {
        keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
        await fs.rm(rootDir, { recursive: true, force: true });
    }
});
