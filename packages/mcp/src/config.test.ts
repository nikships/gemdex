import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, isLocalGeminiApiKey, LOCAL_GEMINI_API_KEY_SENTINEL } from './config.js';

function env(values: Record<string, string>): (name: string) => string | undefined {
    return (name) => values[name];
}

test('MCP config defaults to local mode', () => {
    const config = createConfig(env({ GEMINI_API_KEY: 'local-key' }));
    assert.equal(config.mode, 'local');
    assert.equal(config.remote, undefined);
    assert.equal(config.embeddingProvider, 'gemini');
    assert.equal(config.geminiApiKey, 'local-key');
});

test('GEMINI_API_KEY=local (exact) activates MLX and strips the sentinel from geminiApiKey', () => {
    assert.equal(LOCAL_GEMINI_API_KEY_SENTINEL, 'local');
    assert.equal(isLocalGeminiApiKey('local'), true);
    assert.equal(isLocalGeminiApiKey('Local'), false);
    assert.equal(isLocalGeminiApiKey('LOCAL'), false);
    assert.equal(isLocalGeminiApiKey('local '), false);
    assert.equal(isLocalGeminiApiKey(''), false);
    assert.equal(isLocalGeminiApiKey(undefined), false);

    const config = createConfig(env({ GEMINI_API_KEY: 'local' }));
    assert.equal(config.mode, 'local');
    assert.equal(config.embeddingProvider, 'mlx');
    assert.equal(config.geminiApiKey, undefined);
});

test('GEMDEX_EMBEDDING_PROVIDER=mlx alone does not activate local LLM', () => {
    const withoutKey = createConfig(env({ GEMDEX_EMBEDDING_PROVIDER: 'mlx' }));
    assert.equal(withoutKey.embeddingProvider, 'gemini');
    assert.equal(withoutKey.geminiApiKey, undefined);

    const withRealKey = createConfig(env({
        GEMDEX_EMBEDDING_PROVIDER: 'mlx',
        GEMINI_API_KEY: 'AIza-real-key',
    }));
    assert.equal(withRealKey.embeddingProvider, 'gemini');
    assert.equal(withRealKey.geminiApiKey, 'AIza-real-key');
});

test('empty or missing GEMINI_API_KEY does not fall through to local LLM', () => {
    const missing = createConfig(env({}));
    assert.equal(missing.embeddingProvider, 'gemini');
    assert.equal(missing.geminiApiKey, undefined);

    const empty = createConfig(env({ GEMINI_API_KEY: '' }));
    assert.equal(empty.embeddingProvider, 'gemini');
    assert.equal(empty.geminiApiKey, '');
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
    assert.equal(config.embeddingProvider, 'gemini');
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
