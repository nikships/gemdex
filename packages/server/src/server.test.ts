import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { MemoryBackend } from 'gemdex-core';
import type {
    Memory,
    MemorySummary,
    MemoryRecallResult,
    MemoryExportRecord,
    AttachmentBytes,
    SaveMemoryInput,
    UpdateMemoryInput,
    AttachmentCaptionUpdate,
} from 'gemdex-core';
import { SUPPORTED_API_VERSION, SUPPORTED_PROTOCOL_VERSION } from 'gemdex-core';
import type { ServerVersionInfo } from 'gemdex-core';
import { createServer } from './server.js';

/**
 * Minimal in-memory MemoryBackend stub for testing the shared handler
 * integration without requiring a real database.
 */
class FakeMemoryBackend implements MemoryBackend {
    private memories: Map<string, Memory> = new Map();
    private counter = 0;

    async save(input: SaveMemoryInput): Promise<Memory> {
        const id = `mem_${++this.counter}`;
        const now = Date.now();
        const memory: Memory = {
            id,
            title: input.title ?? '',
            content: input.content ?? '',
            attachments: [],
            createdAt: now,
            updatedAt: now,
        };
        this.memories.set(id, memory);
        return memory;
    }

    async recall(_query?: string, limit?: number): Promise<MemoryRecallResult[]> {
        const items = [...this.memories.values()].slice(0, limit ?? 10);
        return items.map((m) => ({ ...m, score: 1.0 }));
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const existing = this.memories.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        const updated: Memory = {
            ...existing,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.title !== undefined && { title: input.title }),
            updatedAt: Date.now(),
        };
        this.memories.set(id, updated);
        return updated;
    }

    async updateAttachmentCaptions(id: string, _captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const existing = this.memories.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        return existing;
    }

    async get(id: string): Promise<Memory | null> {
        return this.memories.get(id) ?? null;
    }

    async list(): Promise<MemorySummary[]> {
        return [...this.memories.values()].map((m) => ({
            id: m.id,
            title: m.title,
            preview: m.content.slice(0, 100),
            attachments: [],
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
        }));
    }

    async delete(id: string): Promise<void> {
        this.memories.delete(id);
    }

    async exportAll(): Promise<MemoryExportRecord[]> {
        return [...this.memories.values()].map((m) => ({
            id: m.id,
            title: m.title,
            content: m.content,
            attachments: [],
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
        }));
    }

    async importRecords(records: MemoryExportRecord[]): Promise<{ imported: number }> {
        return { imported: records.length };
    }

    async readAttachment(_memoryId: string, _attachmentId: string): Promise<AttachmentBytes | null> {
        return null;
    }
}

async function withServer(
    store: MemoryBackend | null,
    fn: (base: string) => Promise<void>,
    options: { token?: string; unsafeDevNoAuth?: boolean; allowedOrigins?: string[] } = { token: 'test-token' },
): Promise<void> {
    const server = createServer({ store, ...options });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
        await fn(base);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test('GET /v1/health returns 200 { ok: true }', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/v1/health`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    });
});

test('GET /v1/version returns correct shape', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/v1/version`);
        assert.equal(res.status, 200);
        const body = await res.json() as ServerVersionInfo;
        assert.equal(body.name, 'gemdex-server');
        assert.equal(body.apiVersion, SUPPORTED_API_VERSION);
        assert.equal(body.protocolVersion, SUPPORTED_PROTOCOL_VERSION);
        assert.equal(body.minClientVersion, '0.3.0');
        assert.deepEqual(body.capabilities, {
            attachments: true,
            recallAttachments: true,
            importExport: true,
            auth: ['bearer'],
        });
    });
});

test('GET /v1/memories with no store returns 503', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(res.status, 503);
        const body = await res.json() as { error: string };
        assert.equal(typeof body.error, 'string');
        assert.ok(body.error.length > 0, 'error message should be non-empty');
    });
});

test('GET /v1/memories with a fake store returns 200 { memories: [] }', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(res.status, 200);
        const body = await res.json() as { memories: unknown[] };
        assert.deepEqual(body, { memories: [] });
    });
});

test('POST /v1/memories with fake store creates a memory and lists it', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const createRes = await fetch(`${base}/v1/memories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
            body: JSON.stringify({ content: 'test memory content', title: 'Test' }),
        });
        assert.equal(createRes.status, 201);
        const { memory } = await createRes.json() as { memory: { id: string; title: string } };
        assert.ok(memory.id);
        assert.equal(memory.title, 'Test');

        const listRes = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(listRes.status, 200);
        const { memories } = await listRes.json() as { memories: Array<{ id: string }> };
        assert.equal(memories.length, 1);
        assert.equal(memories[0].id, memory.id);
    });
});

test('health and version routes work even when store is null', async () => {
    await withServer(null, async (base) => {
        const health = await fetch(`${base}/v1/health`);
        assert.equal(health.status, 200);

        const version = await fetch(`${base}/v1/version`);
        assert.equal(version.status, 200);

        const memories = await fetch(`${base}/v1/memories`, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(memories.status, 503);
    });
});

test('unknown route returns 404', async () => {
    await withServer(null, async (base) => {
        const res = await fetch(`${base}/unknown-path`);
        assert.equal(res.status, 404);
    });
});


test('data routes require a bearer token', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const missing = await fetch(`${base}/v1/memories`);
        assert.equal(missing.status, 401);
        assert.deepEqual(await missing.json(), { error: 'Unauthorized' });

        const invalid = await fetch(`${base}/v1/memories`, {
            headers: { Authorization: 'Bearer wrong-token' },
        });
        assert.equal(invalid.status, 401);

        const malformed = await fetch(`${base}/v1/memories`, {
            headers: { Authorization: 'Basic test-token' },
        });
        assert.equal(malformed.status, 401);
    });
});

test('data routes accept the configured bearer token', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, {
            headers: { Authorization: 'Bearer test-token' },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { memories: [] });
    });
});

test('unsafe dev mode permits data routes without auth', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`);
        assert.equal(res.status, 200);
    }, { unsafeDevNoAuth: true });
});

test('CORS preflight allows a configured origin and Authorization header', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://app.example.test',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization, content-type',
            },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.test');
        assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
    }, { token: 'test-token', allowedOrigins: ['https://app.example.test'] });
});

test('CORS preflight rejects a disallowed origin', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const res = await fetch(`${base}/v1/memories`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://evil.example.test',
                'Access-Control-Request-Method': 'GET',
            },
        });
        assert.equal(res.status, 403);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    }, { token: 'test-token', allowedOrigins: ['https://app.example.test'] });
});

test('CORS actual requests include headers only for allowed origins', async () => {
    const store = new FakeMemoryBackend();
    await withServer(store, async (base) => {
        const allowed = await fetch(`${base}/v1/memories`, {
            headers: {
                Origin: 'https://app.example.test',
                Authorization: 'Bearer test-token',
            },
        });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');

        const disallowed = await fetch(`${base}/v1/memories`, {
            headers: {
                Origin: 'https://evil.example.test',
                Authorization: 'Bearer test-token',
            },
        });
        assert.equal(disallowed.status, 403);
        assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
    }, { token: 'test-token', allowedOrigins: ['https://app.example.test'] });
});
