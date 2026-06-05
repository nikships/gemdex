import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from './config.js';

function env(values: Record<string, string>): (name: string) => string | undefined {
    return (name) => values[name];
}

test('MCP config defaults to local mode', () => {
    const config = createConfig(env({ GEMINI_API_KEY: 'local-key' }));
    assert.equal(config.mode, 'local');
    assert.equal(config.remote, undefined);
});

test('MCP remote mode resolves URL and token without GEMINI_API_KEY', () => {
    const config = createConfig(env({
        GEMDEX_MODE: 'remote',
        GEMDEX_REMOTE_URL: 'https://memory.example.test/',
        GEMDEX_REMOTE_TOKEN: 'remote-token',
        GEMDEX_REMOTE_NAME: 'production',
    }));
    assert.equal(config.mode, 'remote');
    assert.equal(config.remoteName, 'production');
    assert.deepEqual(config.remote, {
        url: 'https://memory.example.test',
        token: 'remote-token',
    });
    assert.equal(config.geminiApiKey, undefined);
});

test('MCP remote mode fails clearly when URL or token is missing', () => {
    assert.throws(
        () => createConfig(env({ GEMDEX_MODE: 'remote' })),
        /GEMDEX_REMOTE_URL/,
    );
    assert.throws(
        () => createConfig(env({
            GEMDEX_MODE: 'remote',
            GEMDEX_REMOTE_URL: 'https://memory.example.test',
        })),
        /GEMDEX_REMOTE_TOKEN/,
    );
});
