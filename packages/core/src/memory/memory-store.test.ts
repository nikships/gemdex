import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LanceDBVectorDatabase } from '../vectordb';
import { Embedding, EmbeddingVector } from '../embedding';
import type { EmbeddingContent } from '../embedding';
import { MemoryStore } from './memory-store';
import { FileBlobStore } from './blob-store';

const DIM = 16;

function vectorizeTokens(text: string): number[] {
    const vec: number[] = [];
    for (let i = 0; i < DIM; i++) vec.push(0);
    let total = 0;
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        vec[hash % DIM] += 1;
        total += 1;
    }
    if (total === 0) vec[0] = 1;
    return vec;
}

/**
 * Deterministic offline embedding: hashes word tokens into a fixed-dim vector
 * so semantically-overlapping text lands near each other, without hitting the
 * Gemini API. Good enough to exercise dense ranking in tests.
 */
class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return DIM;
    }

    getDimension(): number {
        return DIM;
    }

    getProvider(): string {
        return 'Fake';
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: this.vectorize(text), dimension: DIM };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: this.vectorize(t), dimension: DIM }));
    }

    private vectorize(text: string): number[] {
        const vec: number[] = [];
        for (let i = 0; i < DIM; i++) vec.push(0);
        const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
        let total = 0;
        for (const token of tokens) {
            let hash = 0;
            for (let i = 0; i < token.length; i++) {
                hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
            }
            vec[hash % DIM] += 1;
            total += 1;
        }
        // Avoid an all-zero vector (cosine/L2 degenerate).
        if (total === 0) vec[0] = 1;
        return vec;
    }
}

describe('MemoryStore', () => {
    let tmpDir: string;
    let store: MemoryStore;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-memory-test-'));
        const db = new LanceDBVectorDatabase({ uri: tmpDir });
        store = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db });
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('saves a memory and returns an id + derived title', async () => {
        const mem = await store.save({ content: 'Notarize builds with the gemdex signing identity' });
        expect(mem.id).toBeTruthy();
        expect(mem.title).toBe('Notarize builds with the gemdex signing identity');
        expect(mem.createdAt).toBeGreaterThan(0);
        expect(mem.updatedAt).toBe(mem.createdAt);
    });

    it('uses an explicit title when provided', async () => {
        const mem = await store.save({ content: 'some content', title: 'My Title' });
        expect(mem.title).toBe('My Title');
    });

    it('gets a full memory back by id', async () => {
        const saved = await store.save({ content: 'the answer is 42', title: 'Answer' });
        const fetched = await store.get(saved.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.content).toBe('the answer is 42');
        expect(fetched!.title).toBe('Answer');
    });

    it('recall returns the FULL parent memory, never a fragment, for long content', async () => {
        // Build a long memory whose unique phrase sits deep inside it.
        const filler = 'general setup notes about the project environment\n'.repeat(120);
        const needle = 'the secret deployment token is alpha-bravo-charlie';
        const content = `${filler}\n${needle}\n${filler}`;
        const saved = await store.save({ content, title: 'Deployment playbook' });

        const results = await store.recall('secret deployment token', 5);
        expect(results.length).toBeGreaterThan(0);
        const hit = results.find((r) => r.id === saved.id);
        expect(hit).toBeDefined();
        // Full content stitched back — not just the matching chunk.
        expect(hit!.content).toBe(content);
        expect(hit!.content).toContain(needle);
    });

    it('recall dedupes by parent (one entry per memory)', async () => {
        const content = 'repeated keyword keyword keyword '.repeat(200);
        const saved = await store.save({ content, title: 'Repeated' });
        const results = await store.recall('keyword', 10);
        const matches = results.filter((r) => r.id === saved.id);
        expect(matches.length).toBe(1);
    });

    it('updates a memory in place under the same id and bumps updatedAt', async () => {
        const saved = await store.save({ content: 'original', title: 'T' });
        await new Promise((r) => setTimeout(r, 5));
        const updated = await store.update(saved.id, { content: 'revised content', title: 'T2' });
        expect(updated.id).toBe(saved.id);
        expect(updated.content).toBe('revised content');
        expect(updated.title).toBe('T2');
        expect(updated.createdAt).toBe(saved.createdAt);
        expect(updated.updatedAt).toBeGreaterThanOrEqual(saved.createdAt);

        const fetched = await store.get(saved.id);
        expect(fetched!.content).toBe('revised content');
    });

    it('update throws for an unknown id', async () => {
        await expect(store.update('does-not-exist', { content: 'x' })).rejects.toThrow(/not found/i);
    });

    it('lists memories sorted by updatedAt desc', async () => {
        const a = await store.save({ content: 'first memory' });
        await new Promise((r) => setTimeout(r, 5));
        const b = await store.save({ content: 'second memory' });
        const list = await store.list();
        expect(list.length).toBe(2);
        expect(list[0].id).toBe(b.id);
        expect(list[1].id).toBe(a.id);
        expect(list[0].preview).toContain('second memory');
    });

    it('deletes a memory', async () => {
        const saved = await store.save({ content: 'delete me' });
        await store.delete(saved.id);
        expect(await store.get(saved.id)).toBeNull();
        expect(await store.list()).toHaveLength(0);
    });

    it('exports and re-imports memories (upsert by id)', async () => {
        const a = await store.save({ content: 'export A', title: 'A' });
        const b = await store.save({ content: 'export B', title: 'B' });
        const records = await store.exportAll();
        expect(records.length).toBe(2);

        await store.delete(a.id);
        await store.delete(b.id);
        expect(await store.list()).toHaveLength(0);

        const { imported } = await store.importRecords(records);
        expect(imported).toBe(2);
        const restored = await store.get(a.id);
        expect(restored!.content).toBe('export A');
    });

    it('returns an empty attachments array for text-only memories', async () => {
        const mem = await store.save({ content: 'plain text memory' });
        expect(mem.attachments).toEqual([]);
        const fetched = await store.get(mem.id);
        expect(fetched!.attachments).toEqual([]);
    });
});

/**
 * Like FakeEmbedding, but advertises multimodal support and can embed inline
 * media (it hashes the mimeType + base64 payload into the same fixed-dim space).
 */
class FakeMultimodalEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'FakeMultimodal'; }
    isMultimodal(): boolean { return true; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: vectorizeTokens(text), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: vectorizeTokens(t), dimension: DIM }));
    }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return contents.map((c) => {
            const seed = typeof c === 'string' ? c : `${c.inlineData.mimeType}:${c.inlineData.data}`;
            return { vector: vectorizeTokens(seed), dimension: DIM };
        });
    }
}

describe('MemoryStore (attachments)', () => {
    let dbDir: string;
    let blobDir: string;
    let store: MemoryStore;

    const png = (s: string) => ({ mimeType: 'image/png', data: Buffer.from(s).toString('base64') });

    beforeEach(async () => {
        dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-mm-db-'));
        blobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-mm-blob-'));
        const db = new LanceDBVectorDatabase({ uri: dbDir });
        store = new MemoryStore({
            embedding: new FakeMultimodalEmbedding(),
            vectorDatabase: db,
            blobStore: new FileBlobStore(blobDir),
        });
    });

    afterEach(async () => {
        await fs.rm(dbDir, { recursive: true, force: true });
        await fs.rm(blobDir, { recursive: true, force: true });
    });

    it('saves a memory with an image attachment and returns its metadata', async () => {
        const mem = await store.save({
            content: 'design mock',
            attachments: [{ ...png('PNGDATA'), caption: 'login screen' }],
        });
        expect(mem.attachments).toHaveLength(1);
        expect(mem.attachments[0].kind).toBe('image');
        expect(mem.attachments[0].mimeType).toBe('image/png');
        expect(mem.attachments[0].byteLength).toBe(Buffer.from('PNGDATA').length);
        expect(mem.attachments[0].caption).toBe('login screen');

        const fetched = await store.get(mem.id);
        expect(fetched!.attachments).toHaveLength(1);
        expect(fetched!.content).toBe('design mock');
    });

    it('saves a media-only memory (no text content)', async () => {
        const mem = await store.save({ attachments: [png('AAAA')] });
        expect(mem.content).toBe('');
        expect(mem.attachments).toHaveLength(1);
        expect(mem.title).toBe('image attachment');

        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0].preview).toContain('📎');
        expect(list[0].attachments).toHaveLength(1);
    });

    it('reads attachment bytes back via readAttachment', async () => {
        const mem = await store.save({ content: 'x', attachments: [png('HELLO')] });
        const blob = await store.readAttachment(mem.id, mem.attachments[0].id);
        expect(blob).not.toBeNull();
        expect(blob!.mimeType).toBe('image/png');
        expect(blob!.data.toString()).toBe('HELLO');
        expect(await store.readAttachment(mem.id, 'no-such-att')).toBeNull();
    });

    it('rejects attachments when the embedding is not multimodal', async () => {
        const db = new LanceDBVectorDatabase({ uri: dbDir });
        const textStore = new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
            blobStore: new FileBlobStore(blobDir),
        });
        await expect(textStore.save({ content: 'x', attachments: [png('Q')] })).rejects.toThrow(/multimodal/i);
    });

    it('deletes attachment blobs along with the memory', async () => {
        const mem = await store.save({ attachments: [png('BYTES')] });
        const attId = mem.attachments[0].id;
        expect(await store.readAttachment(mem.id, attId)).not.toBeNull();
        await store.delete(mem.id);
        expect(await store.get(mem.id)).toBeNull();
        expect(await store.readAttachment(mem.id, attId)).toBeNull();
    });

    it('preserves attachments on update when omitted, replaces when provided', async () => {
        const mem = await store.save({ content: 'orig', attachments: [png('one')] });

        const kept = await store.update(mem.id, { content: 'updated text' });
        expect(kept.content).toBe('updated text');
        expect(kept.attachments).toHaveLength(1);
        const keptBlob = await store.readAttachment(mem.id, kept.attachments[0].id);
        expect(keptBlob!.data.toString()).toBe('one');

        const cleared = await store.update(mem.id, { content: 'no media now', attachments: [] });
        expect(cleared.attachments).toHaveLength(0);
    });

    it('round-trips attachments through export and import', async () => {
        const mem = await store.save({
            content: 'spec doc',
            attachments: [{ ...png('PDFISH'), caption: 'spec' }],
        });
        const records = await store.exportAll();
        expect(records[0].attachments).toHaveLength(1);

        await store.delete(mem.id);
        expect(await store.get(mem.id)).toBeNull();

        await store.importRecords(records);
        const restored = await store.get(mem.id);
        expect(restored!.attachments).toHaveLength(1);
        expect(restored!.attachments[0].caption).toBe('spec');
        const blob = await store.readAttachment(mem.id, restored!.attachments[0].id);
        expect(blob!.data.toString()).toBe('PDFISH');
    });

    it('recall returns attachment metadata on a matching memory', async () => {
        const mem = await store.save({
            content: 'kubernetes architecture diagram and rollout notes',
            attachments: [png('IMG')],
        });
        const results = await store.recall('kubernetes architecture diagram', 5);
        const hit = results.find((r) => r.id === mem.id);
        expect(hit).toBeDefined();
        expect(hit!.attachments).toHaveLength(1);
    });
});
