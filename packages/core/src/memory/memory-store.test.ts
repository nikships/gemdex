import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LanceDBVectorDatabase } from '../vectordb';
import { Embedding, EmbeddingVector } from '../embedding';
import { MemoryStore } from './memory-store';

const DIM = 16;

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
});
