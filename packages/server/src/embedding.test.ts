import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerEmbedding } from './embedding.js';
import type { ServerConfig } from './config.js';

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
        host: '127.0.0.1',
        port: 8765,
        unsafeDevNoAuth: true,
        allowedOrigins: [],
        embeddingModel: 'gemini-embedding-2',
        blobStore: { kind: 'file' },
        ...overrides,
    };
}

test('server embedding uses Gemini defaults and output dimension config', () => {
    const embedding = createServerEmbedding(config({
        geminiApiKey: 'server-owned-key',
        embeddingDimension: 768,
    }));
    assert.equal(embedding.getProvider(), 'Gemini');
    assert.equal(embedding.getDimension(), 768);
    assert.equal(embedding.isMultimodal(), true);
});

test('missing server Gemini key fails clearly when embedding is attempted', async () => {
    const embedding = createServerEmbedding(config());
    await assert.rejects(
        () => embedding.embed('remote memory'),
        /GEMINI_API_KEY is required on gemdex-server/,
    );
});
