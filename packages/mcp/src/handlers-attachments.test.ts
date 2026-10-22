import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    Embedding,
    EmbeddingContent,
    EmbeddingVector,
    FileBlobStore,
    LanceDBVectorDatabase,
    LocalMemoryBackend,
    MemoryStatsStore,
} from 'gemdex-core';
import { MemoryToolHandlers } from './handlers.js';

const DIM = 8;

/**
 * Multimodal like the local MLX embedding. Words (in text, or in media bytes
 * read as text) hash into the vector, so a file whose bytes say "red circle"
 * lands next to the text "red circle".
 */
class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;
    mediaPurposes: string[] = [];
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'Fake'; }
    isMultimodal(): boolean { return true; }
    async embed(text: string): Promise<EmbeddingVector> {
        const vector = new Array<number>(DIM).fill(0.01);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
            let hash = 0;
            for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
            vector[hash % DIM] += 1;
        }
        return { vector, dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embed(text)));
    }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return this.embedParts(contents, 'document');
    }
    async embedQueryContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return this.embedParts(contents, 'query');
    }
    private embedParts(contents: EmbeddingContent[], purpose: string): Promise<EmbeddingVector[]> {
        return Promise.all(contents.map((content) => {
            if (typeof content === 'string') return this.embed(content);
            this.mediaPurposes.push(`${purpose}:${content.inlineData.mimeType}`);
            return this.embed(Buffer.from(content.inlineData.data, 'base64').toString());
        }));
    }
}

let dir: string;
let embedding: FakeEmbedding;
let backend: LocalMemoryBackend;
let handlers: MemoryToolHandlers;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdex-handler-att-'));
    embedding = new FakeEmbedding();
    backend = new LocalMemoryBackend({
        embedding,
        vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(dir, 'lance') }),
        blobStore: new FileBlobStore(path.join(dir, 'blobs')),
    });
    handlers = new MemoryToolHandlers(backend, new MemoryStatsStore(path.join(dir, 'stats.json')));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : [])).join('\n');
}

function idOf(result: { content: Array<{ type: string; text?: string }> }): string {
    const match = text(result).match(/^id: (.+)$/m);
    assert.ok(match, text(result));
    return match[1];
}

function writeFile(name: string, contents: string | Buffer): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
}

const MEDIA: Array<[string, string, string]> = [
    ['screenshot.png', 'image/png', 'login screen screenshot'],
    ['photo.webp', 'image/webp', 'team offsite photo'],
    ['memo.m4a', 'audio/mp4', 'voice memo about pricing'],
    ['clip.mp3', 'audio/mp3', 'podcast clip on caching'],
    ['clip.mov', 'video/quicktime', 'screen recording of deploy'],
];

for (const [name, mimeType, bytes] of MEDIA) {
    test(`save_memory embeds a ${mimeType} path attachment and recall finds it by text`, async () => {
        const saved = await handlers.handleSaveMemory({ attachments: [{ path: writeFile(name, bytes) }] });
        assert.equal(saved.isError, undefined, text(saved));
        const id = idOf(saved);
        assert.deepEqual((await backend.get(id))?.attachments.map((a) => a.mimeType), [mimeType]);
        assert.deepEqual(embedding.mediaPurposes, [`document:${mimeType}`]);

        const recalled = await handlers.handleRecall({ query: bytes });
        assert.match(text(recalled), new RegExp(`id: ${id}`));
    });
}

test('recall searches by an example file, alone or with a query', async () => {
    const circle = idOf(await handlers.handleSaveMemory({ content: 'red circle logo draft' }));
    idOf(await handlers.handleSaveMemory({ content: 'blue square banner' }));

    const byFile = await handlers.handleRecall({ attachments: [{ path: writeFile('logo.png', 'red circle logo') }] });
    assert.equal(byFile.isError, undefined, text(byFile));
    assert.match(text(byFile), /for 1 file/);
    assert.equal(text(byFile).match(/id: (.+)/)?.[1], circle);
    assert.deepEqual(embedding.mediaPurposes, ['query:image/png']);

    const both = await handlers.handleRecall({ query: 'banner', attachments: [{ path: writeFile('logo2.png', 'red circle') }] });
    assert.match(text(both), /for "banner" \+ 1 file/);
});

test('recall needs a query or a file, and rejects a text file as the example', async () => {
    const empty = await handlers.handleRecall({});
    assert.equal(empty.isError, true);
    assert.match(text(empty), /provide 'query', at least one file/);

    await handlers.handleSaveMemory({ content: 'anything' });
    const byText = await handlers.handleRecall({ attachments: [{ path: writeFile('notes.txt', 'notes') }] });
    assert.equal(byText.isError, true);
    assert.match(text(byText), /Recall by text\/plain is not supported/);
});

test('read_attachment returns a stored image as viewable image content', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const id = idOf(await handlers.handleSaveMemory({ content: 'diagram', attachments: [{ path: writeFile('d.png', png) }] }));
    const read = await handlers.handleReadAttachment({ memory_id: id });
    assert.equal(read.isError, undefined, text(read));
    assert.match(text(read), /encoding: image/);
    assert.deepEqual(read.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
});

test('save_memory rejects a PDF attachment', async () => {
    const result = await handlers.handleSaveMemory({
        content: 'a pdf',
        attachments: [{ path: writeFile('spec.pdf', '%PDF-1.4 not really') }],
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /^Failed to save memory: Unsupported attachment mimeType 'application\/pdf'/);
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

test('update_memory embeds media it adds and keeps the memory text', async () => {
    const saved = await handlers.handleSaveMemory({
        content: 'keep this content',
        attachments: [{ path: writeFile('keep.txt', 'original attachment') }],
    });
    const id = idOf(saved);

    const result = await handlers.handleUpdateMemory({
        id,
        attachments: [{ path: writeFile('new.png', 'architecture whiteboard'), caption: 'whiteboard' }],
    });
    assert.equal(result.isError, undefined, text(result));

    const memory = await backend.get(id);
    assert.equal(memory?.content, 'keep this content');
    assert.deepEqual(memory?.attachments.map((a) => [a.mimeType, a.caption]), [['image/png', 'whiteboard']]);
    assert.deepEqual(embedding.mediaPurposes, ['document:image/png']);
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
