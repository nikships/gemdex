import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LanceDBVectorDatabase } from './lancedb-vectordb';
import { VectorDocument } from './types';

const DIM = 8;

function makeVector(seed: number): number[] {
    // Deterministic, non-zero, normalized-ish vectors so cosine/L2 give
    // distinct distances. Avoid zeros (cosine distance is undefined on them).
    const out = new Array<number>(DIM);
    for (let i = 0; i < DIM; i++) {
        out[i] = Math.sin(seed + i) + 0.01 * (i + 1);
    }
    return out;
}

function makeDoc(id: string, seed: number, content: string, relativePath = `src/${id}.ts`): VectorDocument {
    return {
        id,
        vector: makeVector(seed),
        content,
        relativePath,
        startLine: 1,
        endLine: 10,
        fileExtension: '.ts',
        metadata: { language: 'typescript', seed },
    };
}

describe('LanceDBVectorDatabase', () => {
    let tmpDir: string;
    let db: LanceDBVectorDatabase;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-lance-test-'));
        db = new LanceDBVectorDatabase({ uri: tmpDir });
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates a collection, inserts vectors, and finds the nearest', async () => {
        const collection = 'test_dense';
        await db.createCollection(collection, DIM);
        expect(await db.hasCollection(collection)).toBe(true);

        const docs = [
            makeDoc('a', 1, 'first chunk'),
            makeDoc('b', 2, 'second chunk'),
            makeDoc('c', 3, 'third chunk'),
        ];
        await db.insert(collection, docs);

        expect(await db.getCollectionRowCount(collection)).toBe(3);

        // Querying with doc B's vector should rank B first.
        const results = await db.search(collection, makeVector(2), { topK: 3 });
        expect(results).toHaveLength(3);
        expect(results[0].document.id).toBe('b');
    });

    it('round-trips metadata as JSON', async () => {
        const collection = 'test_meta';
        await db.createCollection(collection, DIM);
        const doc = makeDoc('x', 1, 'hello', 'src/x.ts');
        doc.metadata = { language: 'ts', nested: { a: 1, b: [1, 2, 3] } };
        await db.insert(collection, [doc]);

        const results = await db.search(collection, makeVector(1), { topK: 1 });
        expect(results[0].document.metadata).toEqual({
            language: 'ts',
            nested: { a: 1, b: [1, 2, 3] },
        });
    });

    it('supports SQL-style filter expressions on search', async () => {
        const collection = 'test_filter';
        await db.createCollection(collection, DIM);
        await db.insert(collection, [
            makeDoc('a', 1, 'kept', 'src/a.ts'),
            makeDoc('b', 1, 'filtered out', 'src/b.ts'),
        ]);

        // Use camelCase identifier exactly as context.ts does in
        // production; the LanceDB impl auto-quotes known camelCase columns.
        const results = await db.search(collection, makeVector(1), {
            topK: 5,
            filterExpr: `relativePath == 'src/a.ts'`,
        });
        expect(results).toHaveLength(1);
        expect(results[0].document.id).toBe('a');
    });

    it('preserves == inside string literals when translating filters', async () => {
        const collection = 'test_string_literal_equals';
        await db.createCollection(collection, DIM);
        // A relativePath that contains '==' inside the literal value — the
        // filter translator must leave the literal alone and only rewrite
        // the operator.
        await db.insert(collection, [
            makeDoc('a', 1, 'kept', 'src/a==b.ts'),
            makeDoc('b', 1, 'other', 'src/b.ts'),
        ]);
        const results = await db.search(collection, makeVector(1), {
            topK: 5,
            filterExpr: `relativePath == 'src/a==b.ts'`,
        });
        expect(results).toHaveLength(1);
        expect(results[0].document.id).toBe('a');
    });

    it('deletes rows by id', async () => {
        const collection = 'test_delete';
        await db.createCollection(collection, DIM);
        await db.insert(collection, [
            makeDoc('a', 1, 'a'),
            makeDoc('b', 2, 'b'),
            makeDoc('c', 3, 'c'),
        ]);
        expect(await db.getCollectionRowCount(collection)).toBe(3);

        await db.delete(collection, ['a', 'c']);
        expect(await db.getCollectionRowCount(collection)).toBe(1);
    });

    it('lists collections and drops them', async () => {
        await db.createCollection('one', DIM);
        await db.createCollection('two', DIM);
        const names = await db.listCollections();
        expect(names.sort()).toEqual(['one', 'two']);

        await db.dropCollection('one');
        const after = await db.listCollections();
        expect(after).toEqual(['two']);
    });

    it('checkCollectionLimit is always true (LanceDB has no cap)', async () => {
        expect(await db.checkCollectionLimit()).toBe(true);
    });

    it('returns -1 row count for a missing collection', async () => {
        expect(await db.getCollectionRowCount('does_not_exist')).toBe(-1);
    });

    it('hybridSearch fuses dense and FTS rankings via RRF', async () => {
        const collection = 'test_hybrid';
        await db.createHybridCollection(collection, DIM);

        const docs = [
            makeDoc('a', 1, 'authentication token refresh handler', 'src/auth.ts'),
            makeDoc('b', 2, 'websocket reconnection logic', 'src/ws.ts'),
            makeDoc('c', 3, 'unrelated database migration', 'src/db.ts'),
        ];
        await db.insertHybrid(collection, docs);

        const results = await db.hybridSearch(
            collection,
            [
                { data: makeVector(2), anns_field: 'vector', param: {}, limit: 10 },
                { data: 'websocket reconnect', anns_field: 'sparse_vector', param: {}, limit: 10 },
            ],
            { limit: 3 },
        );

        expect(results.length).toBeGreaterThan(0);
        // Either dense (vector seed 2 == 'b') or FTS ('websocket reconnect' == 'b') should
        // put 'b' first.
        expect(results[0].document.id).toBe('b');
    }, 30000);

    it('hybridSearch reports per-branch sub-scores', async () => {
        const collection = 'test_hybrid_subscores';
        await db.createHybridCollection(collection, DIM);

        const docs = [
            makeDoc('a', 1, 'authentication token refresh handler', 'src/auth.ts'),
            makeDoc('b', 2, 'websocket reconnection logic', 'src/ws.ts'),
            makeDoc('c', 3, 'unrelated database migration', 'src/db.ts'),
        ];
        await db.insertHybrid(collection, docs);

        const results = await db.hybridSearch(
            collection,
            [
                { data: makeVector(2), anns_field: 'vector', param: {}, limit: 10 },
                { data: 'websocket reconnect', anns_field: 'sparse_vector', param: {}, limit: 10 },
            ],
            { limit: 3 },
        );

        const top = results[0];
        // 'b' should be surfaced by both branches (dense via seed 2, FTS via the
        // word 'websocket'), so both ranks must be populated.
        expect(top.subScores).toBeDefined();
        expect(top.subScores!.denseRank).toBe(1);
        expect(typeof top.subScores!.denseDistance).toBe('number');
        expect(top.subScores!.ftsRank).toBeGreaterThanOrEqual(1);
        // ftsScore depends on the LanceDB build; assert only when defined.
        if (top.subScores!.ftsScore !== undefined) {
            expect(typeof top.subScores!.ftsScore).toBe('number');
        }
    }, 30000);
});
