import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getMlxStatus } from 'gemdex-core';
import { SETUP_GUIDANCE } from './onboarding.js';
import { MCP_TOOL_NAMES } from './tool-names.js';

test('setup guidance names the install and migrate commands and needs no API key', () => {
    assert.match(SETUP_GUIDANCE, /npx gemdex-mcp install/);
    assert.match(SETUP_GUIDANCE, /npx gemdex-mcp migrate/);
    assert.match(SETUP_GUIDANCE, /npx gemdex-mcp status/);
    assert.match(SETUP_GUIDANCE, /No API key is needed/);
    assert.match(SETUP_GUIDANCE, /approval/);
    assert.doesNotMatch(SETUP_GUIDANCE, /GEMINI_API_KEY|setup gemini|init-remote/);
});

test('fresh stdio connection discovers all seven tools, each explains setup, and an install is picked up in place', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-onboard-'));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url))],
        env: { PATH: process.env.PATH ?? '', HOME: home },
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
            assert.deepEqual(result.content, [{ type: 'text', text: SETUP_GUIDANCE }]);
        }
        // Setup guidance never opens or creates the store.
        await assert.rejects(fs.access(path.join(home, '.gemdex', 'lance')));

        // Simulate `npx gemdex-mcp install` finishing in another terminal: the
        // next call builds the backend without a reconnect.
        const runtime = getMlxStatus(path.join(home, '.gemdex')).path;
        await fs.mkdir(runtime, { recursive: true });
        await fs.writeFile(path.join(runtime, 'installed'), path.basename(runtime));

        const repaired = await client.callTool({ name: 'get_memory', arguments: { id: 'missing-id' } });
        assert.equal(repaired.isError, true);
        const text = JSON.stringify(repaired.content);
        assert.doesNotMatch(text, /one-time setup/);
        assert.match(text, /Memory not found: missing-id/);
        assert.equal((await client.listTools()).tools.length, 7);
    } finally {
        await client.close();
        await fs.rm(home, { recursive: true, force: true });
    }
});
