import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    Embedding,
    EmbeddingVector,
    FileBlobStore,
    LanceDBVectorDatabase,
    LocalMemoryBackend,
    MemoryStatsStore,
} from 'gemdex-core';
import { MemoryToolHandlers } from './handlers.js';

const DIM = 8;

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'Fake'; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: Array.from({ length: DIM }, (_, i) => (text.length * (i + 1)) % 11 + 1), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embed(text)));
    }
}

let dir: string;
let backend: LocalMemoryBackend;
let handlers: MemoryToolHandlers;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-handler-att-'));
    backend = new LocalMemoryBackend({
        embedding: new FakeEmbedding(),
        vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(dir, 'lance') }),
        blobStore: new FileBlobStore(path.join(dir, 'blobs')),
    });
    handlers = new MemoryToolHandlers(backend, new MemoryStatsStore(path.join(dir, 'stats.json')));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function text(result: { content: Array<{ text: string }> }): string {
    return result.content.map((part) => part.text).join('\n');
}

function idOf(result: { content: Array<{ text: string }> }): string {
    const match = text(result).match(/^id: (.+)$/m);
    assert.ok(match, text(result));
    return match[1];
}

function writeFile(name: string, contents: string | Buffer): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
}

const MEDIA: Array<[string, string, Buffer]> = [
    ['screenshot.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['photo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['clip.mp3', 'audio/mp3', Buffer.from('ID3fakeaudio')],
    ['clip.mp4', 'video/mp4', Buffer.from('fakevideo')],
];

for (const [name, mimeType, bytes] of MEDIA) {
    test(`save_memory rejects a ${mimeType} path attachment and stores nothing`, async () => {
        const result = await handlers.handleSaveMemory({
            content: 'note with media',
            attachments: [{ path: writeFile(name, bytes) }],
        });
        assert.equal(result.isError, true);
        assert.ok(text(result).includes(`Failed to save memory: ${mimeType} attachments are not supported`), text(result));
        assert.match(text(result), /text-only/);
        assert.deepEqual(await backend.list(), []);
    });
}

test('save_memory rejects inline media data', async () => {
    const result = await handlers.handleSaveMemory({
        content: 'inline image',
        attachments: [{ mimeType: 'image/png', data: Buffer.from('PNGBYTES').toString('base64') }],
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /image\/png attachments are not supported/);
    assert.deepEqual(await backend.list(), []);
});

test('save_memory rejects a PDF attachment', async () => {
    const result = await handlers.handleSaveMemory({
        content: 'a pdf',
        attachments: [{ mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 not really').toString('base64') }],
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /^Failed to save memory: /);
    assert.deepEqual(await backend.list(), []);
});

test('save_memory stores text and JSON path attachments, readable with read_attachment', async () => {
    const notes = 'Step 1: run the migration.\nStep 2: verify row counts.';
    const config = JSON.stringify({ region: 'us-east-1', replicas: 2 });
    const saved = await handlers.handleSaveMemory({
        content: 'database migration runbook',
        attachments: [
            { path: writeFile('runbook.txt', notes), caption: 'runbook' },
            { path: writeFile('config.json', config), caption: 'config' },
        ],
    });
    assert.equal(saved.isError, undefined, text(saved));
    assert.match(text(saved), /^Saved memory\./);
    assert.match(text(saved), /attachments: 2/);
    const id = idOf(saved);

    const memory = await backend.get(id);
    assert.deepEqual(memory?.attachments.map((a) => [a.kind, a.mimeType, a.caption]), [
        ['file', 'text/plain', 'runbook'],
        ['file', 'application/json', 'config'],
    ]);

    const readNotes = await handlers.handleReadAttachment({ memory_id: id, attachment_id: memory!.attachments[0].id });
    assert.equal(readNotes.isError, undefined, text(readNotes));
    assert.ok(text(readNotes).includes(notes));

    const readConfig = await handlers.handleReadAttachment({ memory_id: id, attachment_id: memory!.attachments[1].id });
    assert.ok(text(readConfig).includes(config));
});

test('save_memory accepts a JSONL transcript as the only content', async () => {
    const transcript = '{"role":"user","text":"hi"}\n{"role":"assistant","text":"hello"}\n';
    const saved = await handlers.handleSaveMemory({
        attachments: [{ path: writeFile('session.jsonl', transcript), caption: 'Full transcript (source file)' }],
    });
    assert.equal(saved.isError, undefined, text(saved));
    const id = idOf(saved);
    const read = await handlers.handleReadAttachment({ memory_id: id });
    assert.equal(read.isError, undefined, text(read));
    assert.ok(text(read).includes('"assistant"'));
});

test('update_memory rejects media and leaves the memory unchanged', async () => {
    const saved = await handlers.handleSaveMemory({
        content: 'keep this content',
        attachments: [{ path: writeFile('keep.txt', 'original attachment') }],
    });
    const id = idOf(saved);

    const result = await handlers.handleUpdateMemory({
        id,
        content: 'replacement that must not land',
        attachments: [{ path: writeFile('new.png', MEDIA[0][2]) }],
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /^Failed to update memory: image\/png attachments are not supported/);

    const memory = await backend.get(id);
    assert.equal(memory?.content, 'keep this content');
    assert.deepEqual(memory?.attachments.map((a) => a.mimeType), ['text/plain']);
});

test('update_memory replaces text attachments, keeps them when omitted, and clears them with []', async () => {
    const saved = await handlers.handleSaveMemory({
        content: 'attachment lifecycle',
        attachments: [{ path: writeFile('v1.txt', 'version one') }],
    });
    const id = idOf(saved);

    const replaced = await handlers.handleUpdateMemory({
        id,
        attachments: [{ mimeType: 'application/json', data: Buffer.from('{"v":2}').toString('base64') }],
    });
    assert.equal(replaced.isError, undefined, text(replaced));
    assert.deepEqual((await backend.get(id))?.attachments.map((a) => a.mimeType), ['application/json']);

    const retitled = await handlers.handleUpdateMemory({ id, title: 'Renamed' });
    assert.equal(retitled.isError, undefined, text(retitled));
    const afterRetitle = await backend.get(id);
    assert.equal(afterRetitle?.title, 'Renamed');
    assert.deepEqual(afterRetitle?.attachments.map((a) => a.mimeType), ['application/json']);

    const cleared = await handlers.handleUpdateMemory({ id, attachments: [] });
    assert.equal(cleared.isError, undefined, text(cleared));
    assert.deepEqual((await backend.get(id))?.attachments, []);
});

test('save_memory rejects a non-array attachments value before touching the store', async () => {
    const result = await handlers.handleSaveMemory({ content: 'x', attachments: { path: '/tmp/a.txt' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /'attachments' must be an array/);
    assert.deepEqual(await backend.list(), []);
});
