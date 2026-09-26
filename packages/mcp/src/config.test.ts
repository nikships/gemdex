import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createConfig } from './config.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

function env(values: Record<string, string>): (name: string) => string | undefined {
    return (name) => values[name];
}

test('createConfig defaults the server name and package version with no store override', () => {
    const config = createConfig(env({}));
    assert.deepEqual(config, {
        name: 'Gemdex Memory MCP',
        version: PACKAGE_VERSION,
        lancedbPath: undefined,
    });
});

test('createConfig reads MCP_SERVER_NAME, MCP_SERVER_VERSION and LANCEDB_PATH', () => {
    const config = createConfig(env({
        MCP_SERVER_NAME: 'Custom',
        MCP_SERVER_VERSION: '9.9.9',
        LANCEDB_PATH: '/tmp/gemdex-lance',
    }));
    assert.equal(config.name, 'Custom');
    assert.equal(config.version, '9.9.9');
    assert.equal(config.lancedbPath, '/tmp/gemdex-lance');
});

test('empty name/version values fall back to the defaults', () => {
    const config = createConfig(env({ MCP_SERVER_NAME: '', MCP_SERVER_VERSION: '' }));
    assert.equal(config.name, 'Gemdex Memory MCP');
    assert.equal(config.version, PACKAGE_VERSION);
});

test('Gemini and remote-mode variables no longer shape the config', () => {
    const config = createConfig(env({
        GEMINI_API_KEY: 'AIza-real-key',
        GEMDEX_MODE: 'remote',
        GEMDEX_REMOTE_URL: 'https://memory.example.test',
        GEMDEX_REMOTE_TOKEN: 'remote-token',
        GEMDEX_EMBEDDING_PROVIDER: 'gemini',
    }));
    assert.deepEqual(Object.keys(config).sort(), ['lancedbPath', 'name', 'version']);
    assert.doesNotMatch(JSON.stringify(config), /AIza|remote-token|memory\.example/);
});
