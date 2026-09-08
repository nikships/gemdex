import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Embedding, EmbeddingContent, EmbeddingVector } from '../embedding';
import { LanceDBVectorDatabase } from '../vectordb';
import { MemoryStore } from './memory-store';
import { LocalMemoryBackend } from './backend';
import { FileBlobStore } from './blob-store';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;
    constructor(private dimension: number, private media = false) { super(); }
    getDimension(): number { return this.dimension; }
    async detectDimension(): Promise<number> { return this.dimension; }
    getProvider(): string { return this.media ? 'gemini' : 'mlx'; }
    isMultimodal(): boolean { return this.media; }
    async embed(text: string): Promise<EmbeddingVector> {
        const vector = Array.from({ length: this.dimension }, (_, index) => index === text.length % this.dimension ? 1 : 0.1);
        return { vector, dimension: this.dimension };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> { return Promise.all(texts.map(text => this.embed(text))); }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        if (!this.media && contents.some(content => typeof content !== 'string')) throw new Error('MLX received media');
        return this.embedBatch(contents.map(content => typeof content === 'string' ? content : content.inlineData.data));
    }
}

const image = { id: 'diagram', mimeType: 'image/png', data: Buffer.from('image bytes').toString('base64'), caption: 'old' };
const fields = ['id', 'vector', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'];

describe('MemoryStore dual banks (real LanceDB, offline embeddings)', () => {
    let dir: string;
    let db: LanceDBVectorDatabase;
    let gemini: TestEmbedding;
    let mlx: TestEmbedding;
    let provider: 'mlx' | 'gemini';
    let store: MemoryStore;
    let blobs: FileBlobStore;
    const rows = async (bank: string): Promise<Record<string, any>[]> => await db.hasCollection(bank)
        ? (await db.query(bank, '', fields, 1000)).map(row => ({ ...row, vector: Array.from(row.vector as Iterable<number>) }))
        : [];

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-dual-'));
        db = new LanceDBVectorDatabase({ uri: path.join(dir, 'lance') });
        gemini = new TestEmbedding(16, true);
        mlx = new TestEmbedding(8);
        provider = 'mlx';
        blobs = new FileBlobStore(path.join(dir, 'blobs'));
        store = new MemoryStore({ embedding: gemini, textEmbedding: mlx, textProvider: () => provider,
            textCollectionName: 'memories_mlx', vectorDatabase: db, blobStore: blobs });
    });
    afterEach(async () => { jest.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

    it('uses the model-specific default collection and rejects sharing a vector space', async () => {
        const defaultStore = new MemoryStore({ embedding: gemini, textEmbedding: mlx, vectorDatabase: db, blobStore: blobs });
        await defaultStore.save({ content: 'default bank' });
        expect(await rows('memories_mlx_bge_m3_8bit')).toHaveLength(1);
        expect(() => new MemoryStore({ embedding: gemini, textEmbedding: mlx, vectorDatabase: db,
            textCollectionName: 'memories' })).toThrow('different names');
    });

    it('fresh MLX text save/recall/import/update never calls Gemini, even with an empty Gemini table', async () => {
        const network = jest.spyOn(gemini, 'embed').mockRejectedValue(new Error('Gemini unavailable'));
        await db.createHybridCollection('memories', 16);
        const query = jest.spyOn(mlx, 'embedQuery');
        const saved = await store.save({ content: 'offline text' });
        expect((await store.recall('offline'))[0].id).toBe(saved.id);
        expect(query).toHaveBeenCalledWith('offline');
        await store.update(saved.id, { content: 'changed' });
        const exported = await store.exportAll();
        expect(await store.importRecords(exported)).toEqual({ imported: 1, failed: 0, errors: [] });
        expect(await store.listParentsWithVectors()).toHaveLength(1);
        expect(network).not.toHaveBeenCalled();
        expect(await rows('memories')).toHaveLength(0);
    });

    it('splits mixed parents by dimension and recalls media-only, legacy and MLX after switch-back', async () => {
        provider = 'gemini';
        const legacy = await store.save({ content: 'legacy text' });
        const media = await store.save({ attachments: [image] });
        provider = 'mlx';
        const mixed = await store.save({ content: 'local text', attachments: [image] });
        expect((await rows('memories_mlx')).every(row => row.vector.length === 8 && !row.id.includes('::att::'))).toBe(true);
        expect((await rows('memories')).every(row => row.vector.length === 16)).toBe(true);
        provider = 'gemini';
        const fresh = await store.save({ content: 'switch back' });
        expect(new Set((await store.recall('text', 10)).map(hit => hit.id))).toEqual(new Set([legacy.id, media.id, mixed.id, fresh.id]));
        expect((await store.recall('text', 10, [image])).filter(hit => hit.id === mixed.id)).toHaveLength(1);
        await expect(store.listParentsWithVectors()).rejects.toThrow('single embedding space');
        await store.update(mixed.id, { content: 'now Gemini' });
        expect(await rows('memories_mlx')).toHaveLength(0);
        expect((await store.get(mixed.id))?.attachments[0].id).toBe('diagram');
    });

    it('does not silently suppress an unavailable populated Gemini bank', async () => {
        provider = 'gemini';
        await store.save({ content: 'legacy' });
        provider = 'mlx';
        await store.save({ content: 'local' });
        jest.spyOn(gemini, 'embedQuery').mockRejectedValue(new Error('Configure Gemini for legacy/media'));
        await expect(store.recall('query')).rejects.toThrow('Configure Gemini');
    });

    it('migrates only text, leaves attachment rows/vectors/blobs exact, and reruns without duplicates', async () => {
        provider = 'gemini';
        const mixed = await store.save({ content: 'text body', attachments: [image] });
        await store.save({ attachments: [image] });
        const attachments = (await rows('memories')).filter(row => row.id.includes('::att::'));
        const exported = await store.exportAll();
        const put = jest.spyOn(blobs, 'put');
        const remove = jest.spyOn(blobs, 'deleteParent');
        const network = jest.spyOn(gemini, 'embedContentBatch').mockRejectedValue(new Error('offline'));
        const progress = jest.fn();
        await new LocalMemoryBackend(store).migrateTextToMlx(progress);
        expect(progress.mock.calls).toEqual([[0, 1], [1, 1]]);
        await store.migrateTextToMlx();
        expect(await rows('memories')).toEqual(attachments);
        expect(await rows('memories_mlx')).toHaveLength(1);
        expect(await store.exportAll()).toEqual(exported);
        expect((await store.readAttachment(mixed.id, 'diagram'))?.data.toString()).toBe('image bytes');
        expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    });

    it('preserves source on failed migration embedding or upsert and recovers after failed source deletion', async () => {
        provider = 'gemini';
        await store.save({ content: 'source' });
        const original = await rows('memories');
        jest.spyOn(mlx, 'embedContentBatch').mockRejectedValueOnce(new Error('embed failed'));
        await expect(store.migrateTextToMlx()).rejects.toThrow('embed failed');
        expect(await rows('memories')).toEqual(original);
        jest.spyOn(db, 'upsertHybrid').mockRejectedValueOnce(new Error('upsert failed'));
        await expect(store.migrateTextToMlx()).rejects.toThrow('upsert failed');
        expect(await rows('memories')).toEqual(original);
        jest.spyOn(db, 'delete').mockRejectedValueOnce(new Error('delete failed'));
        await expect(store.migrateTextToMlx()).rejects.toThrow('delete failed');
        expect(await rows('memories')).toEqual(original);
        expect(await rows('memories_mlx')).toHaveLength(1);
        await store.migrateTextToMlx();
        expect(await rows('memories')).toHaveLength(0);
        expect(await rows('memories_mlx')).toHaveLength(1);
    });

    it('retains completed migration parents after a later embedding failure', async () => {
        provider = 'gemini';
        await store.save({ content: 'first' }); await store.save({ content: 'second' });
        const embed = mlx.embedContentBatch.bind(mlx);
        jest.spyOn(mlx, 'embedContentBatch').mockImplementationOnce(embed).mockRejectedValueOnce(new Error('second failed'));
        const progress = jest.fn();
        await expect(store.migrateTextToMlx(progress)).rejects.toThrow('second failed');
        expect(progress.mock.calls).toEqual([[0, 2], [1, 2]]);
        expect(await store.list()).toHaveLength(2);
        await store.migrateTextToMlx();
        expect(await rows('memories_mlx')).toHaveLength(2);
    });

    it('rewrites caption metadata in both banks without embedding and deletes both banks and blobs', async () => {
        const saved = await store.save({ content: 'body', attachments: [image] });
        const geminiRows = await rows('memories'); const mlxRows = await rows('memories_mlx');
        const network = jest.spyOn(gemini, 'embedContentBatch'); const local = jest.spyOn(mlx, 'embedContentBatch');
        await store.updateAttachmentCaptions(saved.id, [{ id: 'diagram', caption: 'new caption' }]);
        for (const [bank, before] of [['memories', geminiRows], ['memories_mlx', mlxRows]] as const) {
            const after = await rows(bank);
            expect(Array.from(after[0].vector)).toEqual(Array.from(before[0].vector));
            expect(JSON.parse(after[0].metadata).attachments[0].caption).toBe('new caption');
        }
        expect(network).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled();
        await store.delete(saved.id);
        expect(await store.list()).toEqual([]); expect(await store.readAttachment(saved.id, 'diagram')).toBeNull();
    });

    it('preserves original dual-bank state on embedding failure and rolls back second-bank insertion failure', async () => {
        const saved = await store.save({ content: 'original', attachments: [image] });
        const original = await store.exportAll();
        jest.spyOn(gemini, 'embedContentBatch').mockRejectedValueOnce(new Error('media failed'));
        await expect(store.update(saved.id, { content: 'changed' })).rejects.toThrow('media failed');
        expect(await store.exportAll()).toEqual(original);
        const insert = db.insertHybrid.bind(db);
        jest.spyOn(db, 'insertHybrid').mockImplementationOnce(insert).mockRejectedValueOnce(new Error('second bank failed'));
        await expect(store.update(saved.id, { content: 'changed' })).rejects.toThrow('second bank failed');
        expect(await store.exportAll()).toEqual(original);
        expect(await rows('memories')).toHaveLength(1); expect(await rows('memories_mlx')).toHaveLength(1);
    });

    it('rolls back both banks when the second caption write fails', async () => {
        const saved = await store.save({ content: 'original', attachments: [image] });
        const original = await store.exportAll();
        const insert = db.insertHybrid.bind(db);
        jest.spyOn(db, 'insertHybrid').mockImplementationOnce(insert).mockRejectedValueOnce(new Error('caption failed'));
        await expect(store.updateAttachmentCaptions(saved.id, [{ id: 'diagram', caption: 'new' }])).rejects.toThrow('caption failed');
        expect(await store.exportAll()).toEqual(original);
        for (const bank of ['memories', 'memories_mlx']) {
            expect(JSON.parse((await rows(bank))[0].metadata).attachments[0].caption).toBe('old');
        }
    });

    it('imports mixed and file-only parents idempotently with coherent full metadata', async () => {
        const mixed = await store.save({ content: 'mixed body', attachments: [image] });
        const file = await store.save({ title: 'transcript', attachments: [{ id: 'transcript',
            mimeType: 'text/plain', data: Buffer.from('not embedded').toString('base64') }] });
        const exported = await store.exportAll();
        await store.delete(mixed.id); await store.delete(file.id);
        const media = jest.spyOn(gemini, 'embedContentBatch');
        expect((await store.importRecords(exported)).imported).toBe(2);
        expect((await store.importRecords(exported)).imported).toBe(2);
        expect(media).toHaveBeenCalledTimes(2);
        expect(await store.exportAll()).toEqual(exported);
        expect(await rows('memories_mlx')).toHaveLength(2);
        expect(await rows('memories')).toHaveLength(1);
        const metas = [...await rows('memories'), ...await rows('memories_mlx')]
            .filter(row => row.relativePath === mixed.id).map(row => row.metadata);
        expect(new Set(metas).size).toBe(1);
    });

    it('computes save similarity only within each bank', async () => {
        const first = await store.save({ content: 'identical body', attachments: [image] });
        const second = await store.save({ content: 'identical body', attachments: [image] });
        expect(second.similar?.find(candidate => candidate.id === first.id)?.similarity).toBeCloseTo(1);
        expect(second.similar?.filter(candidate => candidate.id === first.id)).toHaveLength(1);
        expect(second.similar?.every(candidate => Number.isFinite(candidate.similarity))).toBe(true);
    });

    it('rejects mixed hygiene even for equal-sized but incompatible embedding spaces', async () => {
        store = new MemoryStore({ embedding: gemini, textEmbedding: new TestEmbedding(16),
            textProvider: () => provider, vectorDatabase: db, blobStore: blobs });
        provider = 'gemini';
        await store.save({ content: 'legacy' });
        expect(await store.listParentsWithVectors()).toHaveLength(1);
        provider = 'mlx';
        await store.save({ content: 'MLX' });
        await expect(store.listParentsWithVectors()).rejects.toThrow('single embedding space');
    });

    it('excludes every competing writer before its snapshot while migration is embedding', async () => {
        provider = 'gemini';
        const saved = await store.save({ content: 'source', attachments: [image] });
        const second = new MemoryStore({ embedding: gemini, textEmbedding: mlx,
            textCollectionName: 'memories_mlx', vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(dir, 'lance') }), blobStore: blobs });
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const embed = mlx.embedContentBatch.bind(mlx);
        jest.spyOn(mlx, 'embedContentBatch').mockImplementationOnce(async content => {
            entered(); await gate; return embed(content);
        });
        const migration = store.migrateTextToMlx();
        await started;
        try {
            await expect(second.update(saved.id, { content: 'racing' })).rejects.toThrow('busy');
            await expect(second.delete(saved.id)).rejects.toThrow('busy');
            await expect(second.save({ content: 'racing' })).rejects.toThrow('busy');
            await expect(second.importRecords(await store.exportAll())).rejects.toThrow('busy');
            await expect(second.updateAttachmentCaptions(saved.id, [{ id: 'diagram', caption: 'racing' }])).rejects.toThrow('busy');
            await expect(second.migrateTextToMlx()).rejects.toThrow('busy');
        } finally { release(); await migration; }
        await second.update(saved.id, { content: 'after migration' });
        expect((await store.get(saved.id))?.content).toBe('after migration');
        await second.delete(saved.id);
        await store.migrateTextToMlx();
        expect(await store.get(saved.id)).toBeNull();
    });

    it('honors a lock created by another OS process and never steals a stale lock', async () => {
        const lock = path.join(dir, 'lance', '.gemdex-memory-write.lock');
        const child = spawnSync(process.execPath, ['-e', 'require("fs").mkdirSync(process.argv[1])', lock]);
        expect(child.status).toBe(0);
        await fs.utimes(lock, new Date(0), new Date(0));
        await expect(store.save({ content: 'blocked' })).rejects.toThrow('stop all Gemdex processes');
        await fs.rmdir(lock);
        expect((await store.save({ content: 'recovered' })).id).toBeTruthy();
    });

    it('embeds large parents in bounded local batches without truncating the parent', async () => {
        store = new MemoryStore({ embedding: gemini, textEmbedding: mlx, vectorDatabase: db, blobStore: blobs,
            chunkOptions: { chunkSize: 20, chunkOverlap: 0 } });
        const embed = jest.spyOn(mlx, 'embedContentBatch');
        const content = 'Large memory paragraph.\n\n'.repeat(300);
        const saved = await store.save({ content });
        expect(embed.mock.calls.length).toBeGreaterThan(16);
        expect(embed.mock.calls.every(([batch]) => batch.length <= 16)).toBe(true);
        expect((await store.get(saved.id))?.content).toBe(content);
    });

    it('migrates imported ids containing attachment delimiters and does not cap bank enumeration', async () => {
        provider = 'gemini';
        const id = 'imported::att::parent';
        expect((await store.importRecords([{ id, title: 'Imported', content: 'body text',
            createdAt: 1, updatedAt: 1, attachments: [image] }])).imported).toBe(1);
        const query = jest.spyOn(db, 'query');
        await store.migrateTextToMlx();
        expect((await rows('memories_mlx'))[0].relativePath).toBe(id);
        expect((await rows('memories'))[0].id).toBe(`${id}::att::0`);
        await store.updateAttachmentCaptions(id, [{ id: 'diagram', caption: 'changed caption' }]);
        expect((await rows('memories_mlx'))[0].content).toBe('body text');
        expect(query.mock.calls.some(call => call[1] === '' && call[3] === undefined)).toBe(true);
    });
});
