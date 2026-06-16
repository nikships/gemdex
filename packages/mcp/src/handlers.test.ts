import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    Memory,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    MemoryAttachmentInput,
    SaveMemoryInput,
    UpdateMemoryInput,
} from 'gemdex-core';
import { MemoryToolHandlers } from './handlers.js';

/** Minimal in-memory backend that records update calls for assertions. */
class FakeBackend implements MemoryBackend {
    memory: Memory | null;
    lastUpdate?: { id: string; input: UpdateMemoryInput };
    recallResults: MemoryRecallResult[] = [];
    listResults: MemorySummary[] = [];

    constructor(initial: Memory | null) {
        this.memory = initial;
    }

    async save(_input: SaveMemoryInput): Promise<Memory> {
        throw new Error('not implemented');
    }

    async recall(): Promise<MemoryRecallResult[]> {
        return this.recallResults;
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        this.lastUpdate = { id, input };
        if (!this.memory || this.memory.id !== id) throw new Error(`Memory not found: ${id}`);
        this.memory = {
            ...this.memory,
            ...(input.content !== undefined && { content: input.content }),
            ...(input.title !== undefined && { title: input.title }),
            updatedAt: this.memory.updatedAt + 1,
        };
        return this.memory;
    }

    async updateAttachmentCaptions(_id: string, _captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        throw new Error('not implemented');
    }

    async get(id: string): Promise<Memory | null> {
        return this.memory && this.memory.id === id ? this.memory : null;
    }

    async list(): Promise<MemorySummary[]> {
        return this.listResults;
    }

    async delete(_id: string): Promise<void> {}

    async exportAll(): Promise<MemoryExportRecord[]> {
        return [];
    }

    async importRecords(_records: MemoryExportRecord[]): Promise<{ imported: number }> {
        return { imported: 0 };
    }

    async readAttachment(_memoryId: string, _attachmentId: string): Promise<AttachmentBytes | null> {
        return null;
    }
}

function makeMemory(content: string): Memory {
    return { id: 'mem-1', title: 'Note', content, attachments: [], createdAt: 1, updatedAt: 1 };
}

test('update_memory applies edits against current content via get → update', async () => {
    const backend = new FakeBackend(makeMemory('line one\nline two\nline three'));
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'line two', newText: 'LINE TWO' }],
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Updated memory/);
    assert.equal(backend.lastUpdate?.input.content, 'line one\nLINE TWO\nline three');
    // title/attachments untouched, so the store preserves them.
    assert.equal(backend.lastUpdate?.input.title, undefined);
    assert.equal(backend.lastUpdate?.input.attachments, undefined);
});

test('update_memory edits can be combined with a new title', async () => {
    const backend = new FakeBackend(makeMemory('alpha beta'));
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'beta', newText: 'gamma' }],
        title: 'Renamed',
    });

    assert.equal(result.isError, undefined);
    assert.equal(backend.lastUpdate?.input.content, 'alpha gamma');
    assert.equal(backend.lastUpdate?.input.title, 'Renamed');
});

test('update_memory rejects content and edits together', async () => {
    const backend = new FakeBackend(makeMemory('text'));
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        content: 'whole new text',
        edits: [{ oldText: 'text', newText: 'x' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not both/);
    assert.equal(backend.lastUpdate, undefined);
});

test('update_memory surfaces a clean error when an edit does not match', async () => {
    const backend = new FakeBackend(makeMemory('hello world'));
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'absent', newText: 'x' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found in memory content/);
    assert.equal(backend.lastUpdate, undefined);
});

test('update_memory with edits returns not-found for an unknown id', async () => {
    const backend = new FakeBackend(null);
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleUpdateMemory({
        id: 'missing',
        edits: [{ oldText: 'a', newText: 'b' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Memory not found: missing/);
    assert.equal(backend.lastUpdate, undefined);
});

test('update_memory rejects a malformed edits shape', async () => {
    const backend = new FakeBackend(makeMemory('text'));
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleUpdateMemory({
        id: 'mem-1',
        edits: [{ oldText: 'text' }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /string 'oldText' and 'newText'/);
    assert.equal(backend.lastUpdate, undefined);
});

test('update_memory requires at least one updatable field', async () => {
    const backend = new FakeBackend(makeMemory('text'));
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleUpdateMemory({ id: 'mem-1' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /'content', 'edits', 'title', or 'attachments'/);
});

function makeRecallHit(over: Partial<MemoryRecallResult>): MemoryRecallResult {
    return {
        id: 'mem-1',
        title: 'Note',
        content: 'the full content body',
        attachments: [],
        createdAt: 1,
        updatedAt: Date.now(),
        score: 0.5,
        ...over,
    };
}

test('recall surfaces relative age and attachment lines', async () => {
    const backend = new FakeBackend(null);
    backend.recallResults = [
        makeRecallHit({
            updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
            attachments: [{ id: '0', kind: 'image', mimeType: 'image/png', byteLength: 10, caption: 'login bug' }],
        }),
    ];
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleRecall({ query: 'login' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /updated: 3d ago/);
    assert.match(result.content[0].text, /attachments: image \(id 0: "login bug"\)/);
    assert.match(result.content[0].text, /the full content body/);
});

test('recall detail=summary returns a preview, not full content', async () => {
    const backend = new FakeBackend(null);
    const longBody = 'x'.repeat(500);
    backend.recallResults = [makeRecallHit({ content: longBody })];
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleRecall({ query: 'anything', detail: 'summary' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /summary mode/);
    assert.match(result.content[0].text, /…/);
    assert.ok(!result.content[0].text.includes(longBody), 'full body must not appear in summary mode');
});

test('list_memories renders summaries newest-first with age and media counts', async () => {
    const backend = new FakeBackend(null);
    backend.listResults = [
        {
            id: 'mem-a',
            title: 'Deploy playbook',
            preview: 'how we deploy the service',
            attachments: [{ id: '0', kind: 'image', mimeType: 'image/png', byteLength: 1 }],
            createdAt: 1,
            updatedAt: Date.now(),
        },
        {
            id: 'mem-b',
            title: 'Signing credentials',
            preview: 'notarization steps',
            attachments: [],
            createdAt: 1,
            updatedAt: Date.now() - 60 * 1000,
        },
    ];
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleListMemories({});

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /2 memories/);
    assert.match(result.content[0].text, /Deploy playbook/);
    assert.match(result.content[0].text, /id: mem-a/);
    assert.match(result.content[0].text, /1 image/);
});

test('list_memories filter is a case-insensitive substring over title + preview', async () => {
    const backend = new FakeBackend(null);
    backend.listResults = [
        { id: 'mem-a', title: 'Deploy playbook', preview: 'service rollout', attachments: [], createdAt: 1, updatedAt: 2 },
        { id: 'mem-b', title: 'Signing credentials', preview: 'notarization', attachments: [], createdAt: 1, updatedAt: 1 },
    ];
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleListMemories({ filter: 'DEPLOY' });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Deploy playbook/);
    assert.ok(!result.content[0].text.includes('Signing credentials'));
});

test('list_memories reports an empty store cleanly', async () => {
    const backend = new FakeBackend(null);
    const handlers = new MemoryToolHandlers(backend);

    const result = await handlers.handleListMemories({});

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Nothing stored yet/);
});
