import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import nodeOs from 'os';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import { LanceDBVectorDatabase } from '../vectordb';
import { Embedding, EmbeddingVector } from '../embedding';
import { LEGACY_GEMINI_COLLECTION, LOCAL_TEXT_COLLECTION, MemoryStore } from './memory-store';
import { LocalMemoryBackend } from './backend';
import { FileBlobStore, S3BlobStore } from './blob-store';
import { AttachmentValidationError } from './attachment-validator';
import type { MemoryAttachmentInput } from './types';

const DIM = 16;
/** A different vector space, standing in for the 3072-dim Gemini index. */
const LEGACY_DIM = 24;
const ROW_FIELDS = ['id', 'vector', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'];

/**
 * Deterministic offline embedding: hashes word tokens into a fixed-dim vector
 * so semantically-overlapping text lands near each other, without any model.
 * Text-only, like the local MLX embedding.
 */
class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;

    constructor(private readonly dimension = DIM) {
        super();
    }

    async detectDimension(): Promise<number> {
        return this.dimension;
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return 'Fake';
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: this.vectorize(text), dimension: this.dimension };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: this.vectorize(t), dimension: this.dimension }));
    }

    private vectorize(text: string): number[] {
        const vec = new Array<number>(this.dimension).fill(0);
        let total = 0;
        for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
            let hash = 0;
            for (let i = 0; i < token.length; i++) {
                hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
            }
            vec[hash % this.dimension] += 1;
            total += 1;
        }
        // Avoid an all-zero vector (cosine/L2 degenerate).
        if (total === 0) vec[0] = 1;
        return vec;
    }
}

/** Counts every embedding call so a test can prove a path performs none. */
class CountingEmbedding extends FakeEmbedding {
    embedCalls = 0;
    async embed(text: string): Promise<EmbeddingVector> {
        this.embedCalls += 1;
        return super.embed(text);
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.embedCalls += 1;
        return super.embedBatch(texts);
    }
}

/** An embedding whose calls always fail — simulates a crashed model worker mid-write. */
class ThrowingEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return 'Throwing'; }
    async embed(): Promise<EmbeddingVector> { throw new Error('embedding backend unavailable'); }
    async embedBatch(): Promise<EmbeddingVector[]> { throw new Error('embedding backend unavailable'); }
}

class FakeS3Client {
    readonly objects = new Map<string, Buffer>();

    async send(command: { constructor: { name: string }; input?: Record<string, any> }): Promise<Record<string, any>> {
        const input = command.input ?? {};
        const key = input.Key as string | undefined;
        if (command.constructor.name === 'PutObjectCommand') {
            this.objects.set(key!, Buffer.from(input.Body as Buffer));
            return {};
        }
        if (command.constructor.name === 'GetObjectCommand') {
            const object = this.objects.get(key!);
            if (!object) throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
            return { Body: object };
        }
        if (command.constructor.name === 'HeadObjectCommand') {
            if (!this.objects.has(key!)) throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
            return {};
        }
        if (command.constructor.name === 'ListObjectsV2Command') {
            const prefix = input.Prefix as string;
            const keys = Array.from(this.objects.keys()).filter((candidate) => candidate.startsWith(prefix));
            return { Contents: keys.map((candidate) => ({ Key: candidate })), IsTruncated: false };
        }
        if (command.constructor.name === 'DeleteObjectsCommand') {
            const objectsToDelete = (input.Delete?.Objects ?? []) as Array<{ Key?: string }>;
            for (const obj of objectsToDelete) {
                if (obj.Key) this.objects.delete(obj.Key);
            }
            return {};
        }
        throw new Error(`Unhandled command ${command.constructor.name}`);
    }
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const png = (s: string): MemoryAttachmentInput => ({ mimeType: 'image/png', data: b64(s) });
const textFile = (s: string, extra: Partial<MemoryAttachmentInput> = {}): MemoryAttachmentInput =>
    ({ mimeType: 'text/plain', data: b64(s), ...extra });

async function readRows(db: LanceDBVectorDatabase, collection: string): Promise<Record<string, any>[]> {
    if (!await db.hasCollection(collection)) return [];
    return (await db.query(collection, '', ROW_FIELDS, 10_000))
        .map((row) => ({ ...row, vector: Array.from(row.vector as Iterable<number>) }));
}

// Every store here must get an explicit temp LanceDB dir and FileBlobStore
// root. FileBlobStore and LanceDBVectorDatabase fall back to ~/.gemdex, so make
// any accidental default fail loudly instead of writing to the real store.
beforeEach(() => {
    jest.spyOn(nodeOs, 'homedir').mockImplementation(() => {
        throw new Error('test tried to use the real home directory (~/.gemdex); pass explicit temp paths');
    });
});

describe('home-directory guard', () => {
    it('makes a FileBlobStore without a root fail instead of defaulting to ~/.gemdex/blobs', () => {
        expect(() => new FileBlobStore()).toThrow(/real home directory/);
        expect(() => new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: {} as LanceDBVectorDatabase,
        })).toThrow(/real home directory/);
    });
});

async function listFilesRecursive(root: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
        return [];
    }
}

describe('MemoryStore', () => {
    let tmpDir: string;
    let db: LanceDBVectorDatabase;
    let store: MemoryStore;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-memory-test-'));
        db = new LanceDBVectorDatabase({ uri: path.join(tmpDir, 'lance') });
        store = new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
            blobStore: new FileBlobStore(path.join(tmpDir, 'blobs')),
        });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('saves a memory and returns an id + derived title', async () => {
        const mem = await store.save({ content: 'Notarize builds with the gemdex signing identity' });
        expect(mem.id).toBeTruthy();
        expect(mem.title).toBe('Notarize builds with the gemdex signing identity');
        expect(mem.createdAt).toBeGreaterThan(0);
        expect(mem.updatedAt).toBe(mem.createdAt);
    });

    it('writes to the local text collection by default', async () => {
        expect(LOCAL_TEXT_COLLECTION).toBe('memories_mlx_bge_m3_8bit');
        await store.save({ content: 'default collection' });
        expect(await readRows(db, LOCAL_TEXT_COLLECTION)).toHaveLength(1);
        expect(await db.hasCollection(LEGACY_GEMINI_COLLECTION)).toBe(false);
    });

    it('refuses a legacy collection with the same name as the main collection', () => {
        expect(() => new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
            collectionName: 'same',
            legacyCollectionName: 'same',
            blobStore: new FileBlobStore(path.join(tmpDir, 'blobs')),
        })).toThrow(/must differ/);
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

    it('recall returns [] for an empty query or an empty store', async () => {
        expect(await store.recall('anything', 5)).toEqual([]);
        await store.save({ content: 'something stored' });
        expect(await store.recall('', 5)).toEqual([]);
        expect(await store.recall('   ', 5)).toEqual([]);
        expect(await store.recall(undefined, 5)).toEqual([]);
    });

    it('recall by media throws (the local model is text-only), with or without a text query', async () => {
        await store.save({ content: 'rollout notes' });
        await expect(store.recall(undefined, 5, [png('IMG')])).rejects.toThrow(AttachmentValidationError);
        await expect(store.recall('rollout', 5, [png('IMG')])).rejects.toThrow(/Recall by media is not supported/);
        // An explicitly empty attachment list is plain text recall.
        expect((await store.recall('rollout', 5, [])).length).toBe(1);
    });

    it('recall uses embedQuery for the query text', async () => {
        const embedding = new FakeEmbedding();
        const queryStore = new MemoryStore({
            embedding,
            vectorDatabase: db,
            blobStore: new FileBlobStore(path.join(tmpDir, 'blobs')),
        });
        await queryStore.save({ content: 'offline text' });
        const embedQuery = jest.spyOn(embedding, 'embedQuery');
        await queryStore.recall('offline', 5);
        expect(embedQuery).toHaveBeenCalledWith('offline');
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

    it('importRecords collects per-record failures and imports the rest', async () => {
        const result = await store.importRecords([
            { id: 'import-ok-1', title: 'OK 1', content: 'first good record', createdAt: 1, updatedAt: 2 },
            {
                id: 'import-bad-type',
                title: 'Bad type',
                content: 'record whose attachment type is unsupported',
                createdAt: 3,
                updatedAt: 4,
                attachments: [{ mimeType: 'image/gif', data: b64('gif') }],
            },
            { id: 'import-ok-2', title: 'OK 2', content: 'second good record', createdAt: 5, updatedAt: 6 },
        ]);

        // The bad record throws inside writeMemory — it must be collected
        // without aborting the loop.
        expect(result.imported).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].index).toBe(1);
        expect(result.errors[0].id).toBe('import-bad-type');
        expect(result.errors[0].error).toMatch(/Unsupported attachment mimeType 'image\/gif'/);

        expect((await store.get('import-ok-1'))?.content).toBe('first good record');
        expect((await store.get('import-ok-2'))?.content).toBe('second good record');
        expect(await store.get('import-bad-type')).toBeNull();
    });

    it('lists parents with all their row vectors', async () => {
        const short = await store.save({ content: 'short memory', title: 'Short' });
        // Long enough to chunk into multiple rows (~1500 chars per chunk).
        const long = await store.save({ content: 'long filler line\n'.repeat(200), title: 'Long' });

        const parents = await store.listParentsWithVectors();
        expect(parents).toHaveLength(2);
        const shortParent = parents.find((p) => p.id === short.id)!;
        expect(shortParent.title).toBe('Short');
        expect(shortParent.fullContent).toBe('short memory');
        expect(shortParent.vectors).toHaveLength(1);
        expect(shortParent.vectors[0]).toHaveLength(DIM);
        expect(shortParent.createdAt).toBe(short.createdAt);

        const longParent = parents.find((p) => p.id === long.id)!;
        expect(longParent.vectors.length).toBeGreaterThan(1);
    });

    it('returns an empty attachments array for text-only memories', async () => {
        const mem = await store.save({ content: 'plain text memory' });
        expect(mem.attachments).toEqual([]);
        const fetched = await store.get(mem.id);
        expect(fetched!.attachments).toEqual([]);
    });

    it('embeds large parents in bounded batches without truncating the parent', async () => {
        const embedding = new FakeEmbedding();
        const chunky = new MemoryStore({
            embedding,
            vectorDatabase: db,
            blobStore: new FileBlobStore(path.join(tmpDir, 'blobs')),
            chunkOptions: { chunkSize: 20, chunkOverlap: 0 },
        });
        const embed = jest.spyOn(embedding, 'embedContentBatch');
        const content = 'Large memory paragraph.\n\n'.repeat(300);
        const saved = await chunky.save({ content });
        expect(embed.mock.calls.length).toBeGreaterThan(16);
        expect(embed.mock.calls.every(([batch]) => batch.length <= 16)).toBe(true);
        expect((await chunky.get(saved.id))?.content).toBe(content);
    });

    it('honors a write lock created by another OS process and never steals a stale lock', async () => {
        await store.save({ content: 'create the table first' });
        const lock = path.join(tmpDir, 'lance', '.gemdex-memory-write.lock');
        const child = spawnSync(process.execPath, ['-e', 'require("fs").mkdirSync(process.argv[1])', lock]);
        expect(child.status).toBe(0);
        await fs.utimes(lock, new Date(0), new Date(0));
        await expect(store.save({ content: 'blocked' })).rejects.toThrow('stop all Gemdex processes');
        await fs.rmdir(lock);
        expect((await store.save({ content: 'recovered' })).id).toBeTruthy();
    });
});

describe('MemoryStore (attachments)', () => {
    let dbDir: string;
    let blobDir: string;
    let db: LanceDBVectorDatabase;
    let store: MemoryStore;

    beforeEach(async () => {
        dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-att-db-'));
        blobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-att-blob-'));
        db = new LanceDBVectorDatabase({ uri: dbDir });
        store = new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
            blobStore: new FileBlobStore(blobDir),
        });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.rm(dbDir, { recursive: true, force: true });
        await fs.rm(blobDir, { recursive: true, force: true });
    });

    it.each([
        ['image/png', 'image'],
        ['image/jpeg', 'image'],
        ['audio/mpeg', 'audio'],
        ['video/mp4', 'video'],
    ])('rejects a %s save with AttachmentValidationError and writes nothing', async (mimeType) => {
        const embed = jest.spyOn(FakeEmbedding.prototype, 'embedBatch');
        const attempt = store.save({ content: 'design mock', attachments: [{ mimeType, data: b64('media bytes') }] });
        await expect(attempt).rejects.toThrow(AttachmentValidationError);
        await expect(store.save({ attachments: [{ mimeType, data: b64('media only') }] }))
            .rejects.toThrow(/attachments are not supported: the local embedding model is text-only/);

        expect(embed).not.toHaveBeenCalled();
        expect(await store.list()).toEqual([]);
        expect(await readRows(db, LOCAL_TEXT_COLLECTION)).toEqual([]);
        expect(await listFilesRecursive(blobDir)).toEqual([]);
    });

    it('rejects a PDF attachment and writes nothing', async () => {
        await expect(store.save({ content: 'spec', attachments: [{ mimeType: 'application/pdf', data: b64('not a pdf') }] }))
            .rejects.toThrow(AttachmentValidationError);
        expect(await store.list()).toEqual([]);
        expect(await listFilesRecursive(blobDir)).toEqual([]);
    });

    it('rejects a media save even when a file attachment rides along, keeping neither', async () => {
        await expect(store.save({ content: 'mixed', attachments: [textFile('notes'), png('IMG')] }))
            .rejects.toThrow(AttachmentValidationError);
        expect(await store.list()).toEqual([]);
        expect(await listFilesRecursive(blobDir)).toEqual([]);
    });

    it('rejects adding media on update and leaves the memory intact', async () => {
        const mem = await store.save({ content: 'orig', attachments: [textFile('one', { id: 'notes' })] });
        await expect(store.update(mem.id, { content: 'changed', attachments: [png('IMG')] }))
            .rejects.toThrow(AttachmentValidationError);
        const after = await store.get(mem.id);
        expect(after!.content).toBe('orig');
        expect(after!.attachments.map((a) => a.id)).toEqual(['notes']);
        expect((await store.readAttachment(mem.id, 'notes'))!.data.toString()).toBe('one');
    });

    it('keeps media from an import (older export) as an unembedded blob', async () => {
        const embedding = new CountingEmbedding();
        const importer = new MemoryStore({ embedding, vectorDatabase: db, blobStore: new FileBlobStore(blobDir) });
        const result = await importer.importRecords([{
            id: 'old-export',
            title: 'Old diagram',
            content: 'architecture notes',
            createdAt: 1,
            updatedAt: 2,
            attachments: [{ id: 'diagram', mimeType: 'image/png', data: b64('PNGDATA'), caption: 'login screen' }],
        }]);
        expect(result).toEqual({ imported: 1, failed: 0, errors: [] });

        const got = await importer.get('old-export');
        expect(got!.attachments).toEqual([
            { id: 'diagram', kind: 'image', mimeType: 'image/png', byteLength: 7, caption: 'login screen' },
        ]);
        expect((await importer.readAttachment('old-export', 'diagram'))!.data.toString()).toBe('PNGDATA');
        // Only the text chunk is embedded; there is no attachment row.
        const rows = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(rows.map((r) => r.id)).toEqual(['old-export::0']);
        expect(rows[0].content).toBe('architecture notes');
        expect(embedding.embedCalls).toBe(1);
    });

    it('stores file (transcript) attachments as blobs without embedding the body', async () => {
        const embedding = new CountingEmbedding();
        const fileStore = new MemoryStore({ embedding, vectorDatabase: db, blobStore: new FileBlobStore(blobDir) });
        const body = 'a'.repeat(5000);
        const mem = await fileStore.save({
            content: 'Digest summary only\n\n---\nFull transcript: /tmp/x.jsonl\n',
            title: 'Digest',
            attachments: [{
                mimeType: 'application/x-ndjson',
                data: b64(body),
                caption: 'Full transcript (source file)',
            }],
        });
        expect(mem.attachments).toHaveLength(1);
        expect(mem.attachments[0].kind).toBe('file');
        expect(mem.content).not.toContain(body);
        expect(mem.content).toContain('Digest summary only');

        const blob = await fileStore.readAttachment(mem.id, mem.attachments[0].id);
        expect(blob!.data.toString()).toBe(body);
        const rows = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(rows).toHaveLength(1);
        expect(rows.every((r) => !(r.content as string).includes(body))).toBe(true);

        const fileOnly = await fileStore.importRecords([{
            id: 'chat:factory:no-embed',
            title: 'T',
            content: 'summary',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            attachments: [{
                id: 'transcript',
                mimeType: 'text/plain',
                data: b64('transcript body'),
                caption: 'Full transcript (source file)',
            }],
        }]);
        expect(fileOnly.imported).toBe(1);
        const got = await fileStore.get('chat:factory:no-embed');
        expect(got?.attachments[0].kind).toBe('file');
        expect((await fileStore.readAttachment('chat:factory:no-embed', 'transcript'))?.data.toString())
            .toBe('transcript body');
    });

    it('indexes an attachment-only memory by a single title row', async () => {
        const mem = await store.save({ title: 'Session transcript', attachments: [textFile('the body', { id: 'transcript' })] });
        expect(mem.content).toBe('');
        expect(mem.title).toBe('Session transcript');
        const rows = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(`${mem.id}::0`);
        expect(rows[0].content).toBe('Session transcript');

        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0].preview).toBe('📎 1 file');

        const untitled = await store.save({ attachments: [textFile('x')] });
        expect(untitled.title).toBe('file attachment');
        const hits = await store.recall('Session transcript', 5);
        expect(hits[0].id).toBe(mem.id);
    });

    it('reads attachment bytes back via readAttachment', async () => {
        const mem = await store.save({ content: 'x', attachments: [textFile('HELLO')] });
        const blob = await store.readAttachment(mem.id, mem.attachments[0].id);
        expect(blob).not.toBeNull();
        expect(blob!.mimeType).toBe('text/plain');
        expect(blob!.data.toString()).toBe('HELLO');
        expect(await store.readAttachment(mem.id, 'no-such-att')).toBeNull();
        expect(await store.readAttachment('no-such-memory', '0')).toBeNull();
    });

    it('preserves caller-supplied attachment ids and de-duplicates collisions', async () => {
        const mem = await store.save({
            content: 'x',
            attachments: [textFile('a', { id: 'transcript' }), textFile('b', { id: 'transcript' })],
        });
        expect(mem.attachments.map((a) => a.id)).toEqual(['transcript', 'transcript-1']);
        expect((await store.readAttachment(mem.id, 'transcript-1'))!.data.toString()).toBe('b');
    });

    it('deletes attachment blobs along with the memory', async () => {
        const mem = await store.save({ attachments: [textFile('BYTES')] });
        const attId = mem.attachments[0].id;
        expect(await store.readAttachment(mem.id, attId)).not.toBeNull();
        await store.delete(mem.id);
        expect(await store.get(mem.id)).toBeNull();
        expect(await store.readAttachment(mem.id, attId)).toBeNull();
        expect(await listFilesRecursive(blobDir)).toEqual([]);
    });

    it('preserves attachments on update when omitted, replaces when provided', async () => {
        const mem = await store.save({ content: 'orig', attachments: [textFile('one')] });

        const kept = await store.update(mem.id, { content: 'updated text' });
        expect(kept.content).toBe('updated text');
        expect(kept.attachments).toHaveLength(1);
        const keptBlob = await store.readAttachment(mem.id, kept.attachments[0].id);
        expect(keptBlob!.data.toString()).toBe('one');

        const cleared = await store.update(mem.id, { content: 'no files now', attachments: [] });
        expect(cleared.attachments).toHaveLength(0);
    });

    it('round-trips attachments through export and import', async () => {
        const mem = await store.save({
            content: 'spec doc',
            attachments: [textFile('SPEC BODY', { caption: 'spec' })],
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
        expect(blob!.data.toString()).toBe('SPEC BODY');
    });

    it('round-trips attachment import/export through an S3-compatible blob store', async () => {
        const s3Client = new FakeS3Client();
        const s3DbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-s3-db-'));
        try {
            const s3Store = new MemoryStore({
                embedding: new FakeEmbedding(),
                vectorDatabase: new LanceDBVectorDatabase({ uri: s3DbDir }),
                blobStore: new S3BlobStore({ bucket: 'gemdex-test', prefix: 'blobs', client: s3Client }),
            });
            const mem = await s3Store.save({
                content: 's3 spec doc',
                attachments: [textFile('S3 SPEC', { caption: 's3 spec' })],
            });
            expect(s3Client.objects.has(`blobs/${mem.id}/0`)).toBe(true);

            const records = await s3Store.exportAll();
            await s3Store.delete(mem.id);
            expect(s3Client.objects.has(`blobs/${mem.id}/0`)).toBe(false);

            await s3Store.importRecords(records);
            const restored = await s3Store.get(mem.id);
            expect(restored!.attachments).toHaveLength(1);
            const blob = await s3Store.readAttachment(mem.id, restored!.attachments[0].id);
            expect(blob!.data.toString()).toBe('S3 SPEC');
        } finally {
            await fs.rm(s3DbDir, { recursive: true, force: true });
        }
    });

    it('recall returns attachment metadata on a matching memory', async () => {
        const mem = await store.save({
            content: 'kubernetes architecture diagram and rollout notes',
            attachments: [textFile('notes')],
        });
        const results = await store.recall('kubernetes architecture diagram', 5);
        const hit = results.find((r) => r.id === mem.id);
        expect(hit).toBeDefined();
        expect(hit!.attachments).toHaveLength(1);
        expect(hit!.attachments[0].kind).toBe('file');
    });

    it('preserves the existing memory when a re-embed fails mid-update', async () => {
        const mem = await store.save({ content: 'original text', attachments: [textFile('keepbytes', { caption: 'keep' })] });

        // A second store over the SAME db + blobs whose embedding always throws,
        // simulating a model failure during the update's re-embed step.
        const failing = new MemoryStore({
            embedding: new ThrowingEmbedding(),
            vectorDatabase: new LanceDBVectorDatabase({ uri: dbDir }),
            blobStore: new FileBlobStore(blobDir),
        });
        await expect(failing.update(mem.id, { content: 'replacement text' })).rejects.toThrow(/embedding backend/i);

        // The original memory and its attachment bytes must survive the failed update.
        const after = await store.get(mem.id);
        expect(after).not.toBeNull();
        expect(after!.content).toBe('original text');
        expect(after!.attachments).toHaveLength(1);
        const blob = await store.readAttachment(mem.id, after!.attachments[0].id);
        expect(blob!.data.toString()).toBe('keepbytes');
    });

    it('updateAttachmentCaptions changes a caption without re-embedding or touching blobs', async () => {
        const counting = new CountingEmbedding();
        const blobs = new FileBlobStore(blobDir);
        const captionStore = new MemoryStore({ embedding: counting, vectorDatabase: db, blobStore: blobs });
        const mem = await captionStore.save({
            content: 'design notes',
            attachments: [textFile('NOTES', { caption: 'old caption' })],
        });
        const attId = mem.attachments[0].id;
        const before = await readRows(db, LOCAL_TEXT_COLLECTION);
        const callsAfterSave = counting.embedCalls;
        expect(callsAfterSave).toBeGreaterThan(0);
        const put = jest.spyOn(blobs, 'put');
        const removeBlobs = jest.spyOn(blobs, 'deleteParent');

        await new Promise((r) => setTimeout(r, 5));
        const updated = await captionStore.updateAttachmentCaptions(mem.id, [
            { id: attId, caption: 'new caption' },
        ]);

        expect(counting.embedCalls).toBe(callsAfterSave);
        expect(put).not.toHaveBeenCalled();
        expect(removeBlobs).not.toHaveBeenCalled();
        expect(updated.attachments[0].caption).toBe('new caption');
        expect(updated.updatedAt).toBeGreaterThan(mem.updatedAt);
        expect(updated.createdAt).toBe(mem.createdAt);

        const fetched = await captionStore.get(mem.id);
        expect(fetched!.attachments[0].caption).toBe('new caption');
        expect(fetched!.updatedAt).toBe(updated.updatedAt);

        // Vectors and chunk text are reused verbatim; only metadata changed.
        const after = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(after.map((r) => [r.id, r.vector, r.content])).toEqual(before.map((r) => [r.id, r.vector, r.content]));
        expect(JSON.parse(after[0].metadata).attachments[0].caption).toBe('new caption');
    });

    it('updateAttachmentCaptions clears a caption with whitespace and keeps the memory recallable', async () => {
        const mem = await store.save({
            content: 'architecture diagram notes',
            title: 'Architecture diagram',
            attachments: [textFile('DIAGRAM', { caption: 'old' })],
        });
        const attId = mem.attachments[0].id;

        const cleared = await store.updateAttachmentCaptions(mem.id, [{ id: attId, caption: '   ' }]);
        expect(cleared.attachments[0].caption).toBeUndefined();

        const fetched = await store.get(mem.id);
        expect(fetched!.attachments[0].caption).toBeUndefined();

        const results = await store.recall('architecture diagram', 5);
        expect(results.some((r) => r.id === mem.id)).toBe(true);
    });

    it('updateAttachmentCaptions throws for an unknown attachment id', async () => {
        const mem = await store.save({ content: 'x', attachments: [textFile('Z')] });
        await expect(
            store.updateAttachmentCaptions(mem.id, [{ id: 'no-such-att', caption: 'nope' }]),
        ).rejects.toThrow(/not found/i);
    });

    it('updateAttachmentCaptions throws for an unknown memory id', async () => {
        await expect(
            store.updateAttachmentCaptions('does-not-exist', [{ id: '0', caption: 'x' }]),
        ).rejects.toThrow(/not found/i);
    });
});

describe('MemoryStore (save-time similar-memory detection)', () => {
    let tmpDir: string;
    let store: MemoryStore;
    const ENV_KEYS = ['GEMDEX_SIMILAR_ON_SAVE', 'GEMDEX_SIMILAR_THRESHOLD'] as const;
    const savedEnv: Record<string, string | undefined> = {};
    const blobStore = () => new FileBlobStore(path.join(tmpDir, 'blobs'));

    beforeEach(async () => {
        for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-similar-test-'));
        const db = new LanceDBVectorDatabase({ uri: path.join(tmpDir, 'lance') });
        store = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db, blobStore: blobStore() });
    });

    afterEach(async () => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    const NOTARIZE_A = 'Notarize builds with the gemdex signing identity and the xcrun notarytool submit command';
    const NOTARIZE_B = 'Notarize builds with the gemdex signing identity and the xcrun notarytool submit tool';
    const UNRELATED = 'The quick brown fox jumps over the lazy dog in the meadow near the river';

    it('the first save into an empty store has no similar candidates', async () => {
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.similar).toBeUndefined();
    });

    it('a near-identical save surfaces the earlier memory as similar (>= 0.90)', async () => {
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const b = await store.save({ content: NOTARIZE_B, title: 'Notarization B' });

        expect(b.similar).toBeDefined();
        expect(b.similar).toHaveLength(1);
        expect(b.similar![0].id).toBe(a.id);
        expect(b.similar![0].title).toBe('Notarization A');
        expect(b.similar![0].similarity).toBeGreaterThanOrEqual(0.90);
        expect(b.similar![0].updatedAt).toBe(a.updatedAt);
    });

    it('distinct content has no similar candidates', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const c = await store.save({ content: UNRELATED, title: 'Unrelated' });
        expect(c.similar).toBeUndefined();
    });

    it('GEMDEX_SIMILAR_ON_SAVE=false disables detection entirely', async () => {
        process.env.GEMDEX_SIMILAR_ON_SAVE = 'false';
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const b = await store.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(b.similar).toBeUndefined();
    });

    it('GEMDEX_SIMILAR_THRESHOLD loosens the match bar', async () => {
        process.env.GEMDEX_SIMILAR_THRESHOLD = '0.3';
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        // UNRELATED does not clear the default 0.90 bar, but does clear 0.3.
        const c = await store.save({ content: UNRELATED, title: 'Unrelated' });
        expect(c.similar).toBeDefined();
        expect(c.similar![0].id).toBe(a.id);
        expect(c.similar![0].similarity).toBeLessThan(0.90);
    });

    it('an invalid GEMDEX_SIMILAR_THRESHOLD fails fast with a clear error, but never breaks the save', async () => {
        process.env.GEMDEX_SIMILAR_THRESHOLD = 'not-a-number';
        // The save itself must still succeed — detection failure is advisory-only.
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.id).toBeTruthy();
        expect(a.similar).toBeUndefined();
    });

    it('a threshold outside (0, 1] is rejected the same way (never breaks the save)', async () => {
        process.env.GEMDEX_SIMILAR_THRESHOLD = '1.5';
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.id).toBeTruthy();
        expect(a.similar).toBeUndefined();
    });

    it('a db.search failure during detection never fails the save', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });

        // A second store over the SAME on-disk db whose `search` (the
        // detection step's ANN query) always throws, simulating a local
        // failure mid-detection. writeMemory's own collection plumbing
        // (query/insert/hasCollection) is untouched.
        const db = new LanceDBVectorDatabase({ uri: path.join(tmpDir, 'lance') });
        let searchCallCount = 0;
        db.search = async () => {
            searchCallCount += 1;
            throw new Error('simulated ANN failure');
        };
        const failingStore = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db, blobStore: blobStore() });

        const b = await failingStore.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(b.id).toBeTruthy();
        expect(b.similar).toBeUndefined();
        expect(searchCallCount).toBeGreaterThan(0);
    });

    it('costs zero extra embedding calls (reuses the vectors save already computed)', async () => {
        const counting = new CountingEmbedding();
        const db = new LanceDBVectorDatabase({ uri: path.join(tmpDir, 'lance') });
        const countingStore = new MemoryStore({ embedding: counting, vectorDatabase: db, blobStore: blobStore() });

        await countingStore.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const callsAfterFirstSave = counting.embedCalls;
        expect(callsAfterFirstSave).toBeGreaterThan(0);

        // The second save embeds its OWN content once (via embedBatch for its
        // chunk(s)) and detection must add nothing on top of that.
        await countingStore.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(counting.embedCalls).toBe(callsAfterFirstSave + 1);
    });

    it('only compares against the main collection, never the legacy one', async () => {
        const db = new LanceDBVectorDatabase({ uri: path.join(tmpDir, 'lance') });
        const legacyWriter = new MemoryStore({
            embedding: new FakeEmbedding(LEGACY_DIM),
            vectorDatabase: db,
            collectionName: LEGACY_GEMINI_COLLECTION,
            blobStore: blobStore(),
        });
        await legacyWriter.save({ content: NOTARIZE_A, title: 'Legacy notarization' });
        const withLegacy = new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
            legacyCollectionName: LEGACY_GEMINI_COLLECTION,
            blobStore: blobStore(),
        });
        const b = await withLegacy.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(b.similar).toBeUndefined();
    });

    it('update never reports similar candidates (detection is save-only)', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const b = await store.save({ content: NOTARIZE_B, title: 'Notarization B' });
        expect(b.similar).toBeDefined();

        // Updating B to be even MORE similar to A must not gain a `similar`
        // field — update() returns a plain Memory, which has no such field.
        const updated = await store.update(b.id, { content: NOTARIZE_A });
        expect((updated as { similar?: unknown }).similar).toBeUndefined();
    });

    it('importRecords never reports similar candidates (detection is save-only)', async () => {
        await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        const { imported } = await store.importRecords([
            {
                id: 'imported-near-dup',
                title: 'Imported near-dup',
                content: NOTARIZE_B,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        ]);
        expect(imported).toBe(1);
        // importRecords' return type has no `similar` field at all — the type
        // system already enforces this; this test documents the behavior.
    });

    it('a saved memory never reports itself as similar to itself', async () => {
        const a = await store.save({ content: NOTARIZE_A, title: 'Notarization A' });
        expect(a.similar).toBeUndefined();
    });
});

describe('MemoryStore (legacy collection + migrateLegacy)', () => {
    let dir: string;
    let db: LanceDBVectorDatabase;
    let blobs: FileBlobStore;
    let embedding: FakeEmbedding;
    let store: MemoryStore;
    let textId: string;
    const LONG_TEXT = `${'rotate the staging database credentials weekly\n'.repeat(60)}the vault path is secret/staging/db\n`;
    const MEDIA_ID = 'legacy-media';
    const MIXED_ID = 'legacy-mixed';
    const IMAGE_BYTES = Buffer.from('legacy image bytes');
    // A real PDF: preserved media is re-validated (page count) on update.
    let PDF_BYTES: Buffer;

    function legacyVector(seed: number): number[] {
        return Array.from({ length: LEGACY_DIM }, (_, index) => (index === seed % LEGACY_DIM ? 1 : 0.05));
    }

    /**
     * Seed the legacy table the way earlier Gemini releases wrote it: a
     * chunked text parent (via a MemoryStore in the legacy space), plus a
     * media-only parent and a text+media parent with `::att::` rows inserted
     * directly, since media can no longer be saved.
     */
    async function seedLegacy(): Promise<void> {
        const legacyWriter = new MemoryStore({
            embedding: new FakeEmbedding(LEGACY_DIM),
            vectorDatabase: db,
            collectionName: LEGACY_GEMINI_COLLECTION,
            blobStore: blobs,
        });
        textId = (await legacyWriter.save({ content: LONG_TEXT, title: 'Staging credentials' })).id;

        const imageRef = await blobs.put(MEDIA_ID, 'diagram', IMAGE_BYTES);
        const mediaMeta = {
            title: 'Architecture diagram',
            fullContent: '',
            createdAt: 10,
            updatedAt: 20,
            attachments: [{ id: 'diagram', kind: 'image', mimeType: 'image/png', byteLength: IMAGE_BYTES.length, caption: 'system overview', blobRef: imageRef }],
        };
        const pdf = await PDFDocument.create();
        pdf.addPage();
        PDF_BYTES = Buffer.from(await pdf.save());
        const pdfRef = await blobs.put(MIXED_ID, '0', PDF_BYTES);
        const mixedMeta = {
            title: 'Release checklist',
            fullContent: 'ship the release checklist before friday',
            createdAt: 30,
            updatedAt: 40,
            attachments: [{ id: '0', kind: 'pdf', mimeType: 'application/pdf', byteLength: PDF_BYTES.length, blobRef: pdfRef }],
        };
        await db.insertHybrid(LEGACY_GEMINI_COLLECTION, [
            { id: `${MEDIA_ID}::att::0`, vector: legacyVector(1), content: 'system overview', relativePath: MEDIA_ID, startLine: 0, endLine: 1, fileExtension: '', metadata: mediaMeta },
            { id: `${MIXED_ID}::0`, vector: legacyVector(2), content: mixedMeta.fullContent, relativePath: MIXED_ID, startLine: 0, endLine: 1, fileExtension: '', metadata: mixedMeta },
            { id: `${MIXED_ID}::att::0`, vector: legacyVector(3), content: 'Release checklist', relativePath: MIXED_ID, startLine: 0, endLine: 1, fileExtension: '', metadata: mixedMeta },
        ]);
    }

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-legacy-'));
        db = new LanceDBVectorDatabase({ uri: path.join(dir, 'lance') });
        blobs = new FileBlobStore(path.join(dir, 'blobs'));
        await seedLegacy();
        embedding = new FakeEmbedding();
        store = new MemoryStore({
            embedding,
            vectorDatabase: db,
            legacyCollectionName: LEGACY_GEMINI_COLLECTION,
            blobStore: blobs,
        });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('lists, gets, reads, and exports legacy memories before migration', async () => {
        const list = await store.list();
        expect(list.map((m) => m.id).sort()).toEqual([MEDIA_ID, MIXED_ID, textId].sort());
        expect(list.find((m) => m.id === MEDIA_ID)!.preview).toBe('📎 1 image');

        const text = await store.get(textId);
        expect(text!.content).toBe(LONG_TEXT);
        const media = await store.get(MEDIA_ID);
        expect(media!.attachments).toEqual([
            { id: 'diagram', kind: 'image', mimeType: 'image/png', byteLength: IMAGE_BYTES.length, caption: 'system overview' },
        ]);
        expect((await store.readAttachment(MEDIA_ID, 'diagram'))!.data.equals(IMAGE_BYTES)).toBe(true);

        const exported = await store.exportAll();
        expect(exported.map((r) => r.id).sort()).toEqual([MEDIA_ID, MIXED_ID, textId].sort());
        expect(exported.find((r) => r.id === MIXED_ID)!.attachments![0].data).toBe(PDF_BYTES.toString('base64'));
    });

    it('countLegacyMemories counts parents, not rows', async () => {
        const legacyRows = await readRows(db, LEGACY_GEMINI_COLLECTION);
        expect(legacyRows.length).toBeGreaterThan(3);
        expect(await store.countLegacyMemories()).toBe(3);
        expect(await new LocalMemoryBackend(store).countLegacyMemories()).toBe(3);

        const noLegacy = new MemoryStore({ embedding, vectorDatabase: db, blobStore: blobs });
        expect(await noLegacy.countLegacyMemories()).toBe(0);
        const missingLegacy = new MemoryStore({
            embedding, vectorDatabase: db, legacyCollectionName: 'never_created', blobStore: blobs,
        });
        expect(await missingLegacy.countLegacyMemories()).toBe(0);
    });

    it('recall and listParentsWithVectors throw a clear migrate error while legacy rows remain', async () => {
        await store.save({ content: 'a fresh local memory' });
        await expect(store.recall('staging credentials', 5)).rejects.toThrow(/Cannot search yet/);
        await expect(store.recall('staging credentials', 5)).rejects.toThrow(/npx gemdex-mcp migrate/);
        await expect(store.listParentsWithVectors()).rejects.toThrow(/Cannot check memory hygiene yet/);
        await expect(store.listParentsWithVectors()).rejects.toThrow(/legacy Gemini index/);
        // An empty query short-circuits before the legacy check.
        expect(await store.recall('', 5)).toEqual([]);
    });

    it('never searches or writes the legacy collection on save', async () => {
        const before = await readRows(db, LEGACY_GEMINI_COLLECTION);
        const saved = await store.save({ content: 'new local memory' });
        expect(await readRows(db, LEGACY_GEMINI_COLLECTION)).toEqual(before);
        expect((await readRows(db, LOCAL_TEXT_COLLECTION)).map((r) => r.relativePath)).toEqual([saved.id]);
    });

    it('moves a legacy memory into the main index when it is updated', async () => {
        const updated = await store.update(textId, { content: 'rotated to a new vault path' });
        expect(updated.content).toBe('rotated to a new vault path');
        expect((await readRows(db, LEGACY_GEMINI_COLLECTION)).some((r) => r.relativePath === textId)).toBe(false);
        const main = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(main.map((r) => r.id)).toEqual([`${textId}::0`]);
        expect(main[0].vector).toHaveLength(DIM);
        expect(await store.countLegacyMemories()).toBe(2);
    });

    it('restores the legacy rows when the main-index insert fails during an update', async () => {
        const before = await readRows(db, LEGACY_GEMINI_COLLECTION);
        jest.spyOn(db, 'insertHybrid').mockRejectedValueOnce(new Error('insert failed'));
        await expect(store.update(MIXED_ID, { content: 'changed' })).rejects.toThrow('insert failed');

        const sortById = (rows: Record<string, any>[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
        expect(sortById(await readRows(db, LEGACY_GEMINI_COLLECTION))).toEqual(sortById(before));
        expect(await readRows(db, LOCAL_TEXT_COLLECTION)).toEqual([]);
        expect((await store.get(MIXED_ID))!.content).toBe('ship the release checklist before friday');
        expect((await store.readAttachment(MIXED_ID, '0'))!.data.equals(PDF_BYTES)).toBe(true);
    });

    it('rewrites a legacy ::att:: row caption without re-embedding', async () => {
        const vectorBefore = (await readRows(db, LEGACY_GEMINI_COLLECTION)).find((r) => r.id === `${MEDIA_ID}::att::0`)!.vector;
        const embed = jest.spyOn(embedding, 'embedContentBatch');
        await store.updateAttachmentCaptions(MEDIA_ID, [{ id: 'diagram', caption: 'new overview' }]);
        const row = (await readRows(db, LEGACY_GEMINI_COLLECTION)).find((r) => r.id === `${MEDIA_ID}::att::0`)!;
        expect(row.content).toBe('new overview');
        expect(row.vector).toEqual(vectorBefore);
        expect(JSON.parse(row.metadata).attachments[0].caption).toBe('new overview');
        expect(embed).not.toHaveBeenCalled();
    });

    it('migrates text and media-only parents, drops ::att:: rows, and keeps blobs + metadata byte-for-byte', async () => {
        const legacyBefore = await readRows(db, LEGACY_GEMINI_COLLECTION);
        const metadataBefore = new Map(legacyBefore.map((r) => [r.relativePath as string, r.metadata as string]));
        const textRowIdsBefore = legacyBefore
            .filter((r) => !(r.id as string).includes('::att::'))
            .map((r) => r.id as string)
            .sort();
        const exportedBefore = await store.exportAll();

        const progress = jest.fn();
        await new LocalMemoryBackend(store).migrateLegacy(progress);
        expect(progress.mock.calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);

        expect(await readRows(db, LEGACY_GEMINI_COLLECTION)).toEqual([]);
        expect(await store.countLegacyMemories()).toBe(0);

        const main = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(main.every((r) => r.vector.length === DIM)).toBe(true);
        expect(main.some((r) => (r.id as string).includes('::att::'))).toBe(false);
        // Text rows keep their ids; the media-only parent gains one title row.
        expect(main.map((r) => r.id as string).sort()).toEqual([...textRowIdsBefore, `${MEDIA_ID}::0`].sort());
        const mediaRow = main.find((r) => r.relativePath === MEDIA_ID)!;
        expect(mediaRow.content).toBe('Architecture diagram');
        expect(main.filter((r) => r.relativePath === textId).length).toBeGreaterThan(1);
        for (const row of main) {
            expect(row.metadata).toBe(metadataBefore.get(row.relativePath as string));
        }

        expect(await store.exportAll()).toEqual(exportedBefore);
        expect((await store.readAttachment(MEDIA_ID, 'diagram'))!.data.equals(IMAGE_BYTES)).toBe(true);
        expect((await store.readAttachment(MIXED_ID, '0'))!.data.equals(PDF_BYTES)).toBe(true);
    });

    it('re-embeds with the main embedding only and makes recall + hygiene work afterwards', async () => {
        const embed = jest.spyOn(embedding, 'embedContentBatch');
        await store.migrateLegacy();
        expect(embed).toHaveBeenCalled();

        const vault = await store.recall('vault path staging', 5);
        expect(vault[0].id).toBe(textId);
        expect(vault[0].content).toBe(LONG_TEXT);
        const diagram = await store.recall('Architecture diagram', 5);
        expect(diagram.map((r) => r.id)).toContain(MEDIA_ID);
        expect(diagram.find((r) => r.id === MEDIA_ID)!.attachments[0].kind).toBe('image');
        const checklist = await store.recall('release checklist friday', 5);
        expect(checklist[0].id).toBe(MIXED_ID);

        const parents = await store.listParentsWithVectors();
        expect(parents.map((p) => p.id).sort()).toEqual([MEDIA_ID, MIXED_ID, textId].sort());
        expect(parents.every((p) => p.vectors.every((v) => v.length === DIM))).toBe(true);
    });

    it('reruns idempotently', async () => {
        await store.migrateLegacy();
        const after = await readRows(db, LOCAL_TEXT_COLLECTION);
        const progress = jest.fn();
        await store.migrateLegacy(progress);
        expect(progress.mock.calls).toEqual([[0, 0]]);
        expect(await readRows(db, LOCAL_TEXT_COLLECTION)).toEqual(after);

        const noLegacy = new MemoryStore({ embedding, vectorDatabase: db, blobStore: blobs });
        const noLegacyProgress = jest.fn();
        await noLegacy.migrateLegacy(noLegacyProgress);
        expect(noLegacyProgress.mock.calls).toEqual([[0, 0]]);
    });

    it('finishes parents split across capped read pages', async () => {
        const legacyRowCount = (await readRows(db, LEGACY_GEMINI_COLLECTION)).length;
        expect(legacyRowCount).toBeGreaterThan(3);
        const exportedBefore = await store.exportAll();
        const query = db.query.bind(db);
        // Shrink only the migration's page read so every parent spans pages.
        jest.spyOn(db, 'query').mockImplementation((collection, filter, fields, limit) =>
            query(collection, filter, fields,
                collection === LEGACY_GEMINI_COLLECTION && filter === '' && fields.includes('content') ? 1 : limit));

        const progress = jest.fn();
        await store.migrateLegacy(progress);

        expect(await readRows(db, LEGACY_GEMINI_COLLECTION)).toEqual([]);
        expect(progress.mock.calls[0]).toEqual([0, 3]);
        const [lastCompleted, lastTotal] = progress.mock.calls[progress.mock.calls.length - 1];
        expect(lastCompleted).toBe(lastTotal);
        const main = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(new Set(main.map((r) => r.id)).size).toBe(main.length);
        expect(main.some((r) => (r.id as string).includes('::att::'))).toBe(false);
        expect(main.filter((r) => r.relativePath === MEDIA_ID)).toHaveLength(1);
        expect(main.filter((r) => r.relativePath === textId).length).toBeGreaterThan(1);
        expect(await store.exportAll()).toEqual(exportedBefore);
        expect((await store.recall('vault path staging', 5))[0].id).toBe(textId);
    });

    it('keeps the source on a failed embed and recovers without duplicates after a failed source delete', async () => {
        const legacyBefore = await readRows(db, LEGACY_GEMINI_COLLECTION);
        const sortById = (rows: Record<string, any>[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

        jest.spyOn(embedding, 'embedContentBatch').mockRejectedValueOnce(new Error('embed failed'));
        await expect(store.migrateLegacy()).rejects.toThrow('embed failed');
        expect(sortById(await readRows(db, LEGACY_GEMINI_COLLECTION))).toEqual(sortById(legacyBefore));

        jest.spyOn(db, 'delete').mockRejectedValueOnce(new Error('delete failed'));
        await expect(store.migrateLegacy()).rejects.toThrow('delete failed');
        // The destination committed before the failed source delete.
        const mainAfterFailure = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(mainAfterFailure.length).toBeGreaterThan(0);
        expect(await store.countLegacyMemories()).toBe(3);

        await store.migrateLegacy();
        expect(await readRows(db, LEGACY_GEMINI_COLLECTION)).toEqual([]);
        const main = await readRows(db, LOCAL_TEXT_COLLECTION);
        expect(new Set(main.map((r) => r.id)).size).toBe(main.length);
        expect(main.filter((r) => r.relativePath === MEDIA_ID)).toHaveLength(1);
        expect(await store.list()).toHaveLength(3);
    });

    it('excludes competing writers while a migration is embedding', async () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const embed = embedding.embedContentBatch.bind(embedding);
        jest.spyOn(embedding, 'embedContentBatch').mockImplementationOnce(async (contents) => {
            entered();
            await gate;
            return embed(contents);
        });
        const second = new MemoryStore({
            embedding: new FakeEmbedding(),
            vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(dir, 'lance') }),
            legacyCollectionName: LEGACY_GEMINI_COLLECTION,
            blobStore: blobs,
        });
        const migration = store.migrateLegacy();
        await started;
        try {
            await expect(second.save({ content: 'racing' })).rejects.toThrow('busy');
            await expect(second.update(textId, { content: 'racing' })).rejects.toThrow('busy');
            await expect(second.delete(textId)).rejects.toThrow('busy');
            await expect(second.migrateLegacy()).rejects.toThrow('busy');
        } finally {
            release();
            await migration;
        }
        expect(await second.countLegacyMemories()).toBe(0);
    });

    it('refuses to migrate without cross-process write locking', async () => {
        const unlocked = Object.create(db) as LanceDBVectorDatabase;
        Object.defineProperty(unlocked, 'withMemoryWriteLock', { value: undefined });
        const noLock = new MemoryStore({
            embedding, vectorDatabase: unlocked, legacyCollectionName: LEGACY_GEMINI_COLLECTION, blobStore: blobs,
        });
        await expect(noLock.migrateLegacy()).rejects.toThrow(/write locking/);
    });

    it('preserves migrated legacy media on an update that omits attachments', async () => {
        await store.migrateLegacy();

        const updated = await store.update(MEDIA_ID, { content: 'now the diagram has notes' });
        expect(updated.content).toBe('now the diagram has notes');
        expect(updated.attachments).toEqual([
            { id: 'diagram', kind: 'image', mimeType: 'image/png', byteLength: IMAGE_BYTES.length, caption: 'system overview' },
        ]);
        expect((await store.readAttachment(MEDIA_ID, 'diagram'))!.data.equals(IMAGE_BYTES)).toBe(true);
        const rows = (await readRows(db, LOCAL_TEXT_COLLECTION)).filter((r) => r.relativePath === MEDIA_ID);
        expect(rows.map((r) => [r.id, r.content])).toEqual([[`${MEDIA_ID}::0`, 'now the diagram has notes']]);

        // Title-only edits keep it too.
        const retitled = await store.update(MEDIA_ID, { title: 'Renamed diagram' });
        expect(retitled.attachments.map((a) => a.id)).toEqual(['diagram']);
        expect((await store.readAttachment(MEDIA_ID, 'diagram'))!.data.equals(IMAGE_BYTES)).toBe(true);

        // Explicitly re-supplying media is a new media write and is refused.
        await expect(store.update(MEDIA_ID, {
            attachments: [{ id: 'diagram', mimeType: 'image/png', data: IMAGE_BYTES.toString('base64') }],
        })).rejects.toThrow(AttachmentValidationError);
        expect((await store.readAttachment(MEDIA_ID, 'diagram'))!.data.equals(IMAGE_BYTES)).toBe(true);

        // Explicitly clearing attachments removes the media.
        const cleared = await store.update(MEDIA_ID, { attachments: [] });
        expect(cleared.attachments).toEqual([]);
        expect(await store.readAttachment(MEDIA_ID, 'diagram')).toBeNull();
    });
});
