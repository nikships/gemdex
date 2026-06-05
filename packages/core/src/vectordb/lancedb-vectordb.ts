import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float32, FixedSizeList, Utf8, Int32 } from 'apache-arrow';
import {
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    VectorDatabase,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    HybridSubScores,
} from './types';

export interface LanceDBConfig {
    /** Filesystem path where LanceDB stores all tables. Defaults to `~/.gemdex/lance`. */
    uri?: string;
    /** Optional storage options passed through to LanceDB (rarely needed for local FS). */
    storageOptions?: Record<string, string>;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_RRF_K = 60;

// LanceDB's SQL parser (DataFusion) lowercases unquoted identifiers, so a
// filter like `relativePath == 'x'` fails with "No field named relativepath".
// Double-quoted identifiers also collide with string-literal matching in some
// query modes; backticks reliably reference case-sensitive column names.
const CAMEL_CASE_COLUMNS = ['relativePath', 'startLine', 'endLine', 'fileExtension'];

function translateFilter(expr: string): string {
    let out = expr;
    for (const col of CAMEL_CASE_COLUMNS) {
        // Match the column as a whole word so we don't quote substrings that
        // happen to appear inside string literals.
        const re = new RegExp(`(?<![\`"\\w])${col}(?![\`"\\w])`, 'g');
        out = out.replace(re, `\`${col}\``);
    }
    // Existing callers may pass Python-style `==` for equality; LanceDB /
    // DataFusion only recognise `=`. Translate while preserving `!=`, `<=`,
    // `>=`, `===` (left alone — not a valid operator), and the contents of
    // string literals (which may legitimately contain `==`).
    out = out.replace(
        /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|!=|<=|>=|===|==/g,
        match => (match === '==' ? '=' : match),
    );
    return out;
}

interface StoredRow extends Record<string, unknown> {
    id: string;
    vector: number[];
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    fileExtension: string;
    metadata: string;
    _distance?: number;
    _score?: number;
}

export class LanceDBVectorDatabase implements VectorDatabase {
    protected config: LanceDBConfig;
    private connectionPromise: Promise<lancedb.Connection>;
    /** Collections where the FTS index on `content` has been built (per process). */
    private ftsBuilt = new Set<string>();
    /** In-flight FTS index creation promises, keyed by collection. Deduplicates
     *  concurrent `ensureFtsIndex` calls so we don't race `createIndex`. */
    private ftsPromises = new Map<string, Promise<void>>();

    constructor(config: LanceDBConfig = {}) {
        const uri = config.uri ?? path.join(os.homedir(), '.gemdex', 'lance');
        this.config = { ...config, uri };
        fs.mkdirSync(uri, { recursive: true });
        console.log(`[LanceDB] 📁 Using local store at: ${uri}`);
        this.connectionPromise = lancedb.connect(uri, {
            storageOptions: this.config.storageOptions,
        } as Partial<lancedb.ConnectionOptions>);
    }

    protected async connection(): Promise<lancedb.Connection> {
        return this.connectionPromise;
    }

    private buildSchema(dimension: number): Schema {
        return new Schema([
            new Field('id', new Utf8(), false),
            new Field('vector', new FixedSizeList(dimension, new Field('item', new Float32(), true)), false),
            new Field('content', new Utf8(), false),
            new Field('relativePath', new Utf8(), false),
            new Field('startLine', new Int32(), false),
            new Field('endLine', new Int32(), false),
            new Field('fileExtension', new Utf8(), false),
            new Field('metadata', new Utf8(), false),
        ]);
    }

    private async ensureFtsIndex(table: lancedb.Table, collectionName: string): Promise<void> {
        if (this.ftsBuilt.has(collectionName)) return;
        let pending = this.ftsPromises.get(collectionName);
        if (!pending) {
            pending = (async () => {
                try {
                    const indices = await table.listIndices();
                    const hasFts = indices.some((idx: any) => {
                        const columns = idx?.columns ?? idx?.column ?? [];
                        const arr = Array.isArray(columns) ? columns : [columns];
                        return arr.includes('content');
                    });
                    if (!hasFts) {
                        console.log(`[LanceDB] 🔧 Creating FTS index on 'content' for '${collectionName}'...`);
                        await table.createIndex('content', { config: lancedb.Index.fts() });
                    }
                    this.ftsBuilt.add(collectionName);
                } catch (error) {
                    console.warn(`[LanceDB] ⚠️  Could not ensure FTS index on '${collectionName}':`, error);
                } finally {
                    this.ftsPromises.delete(collectionName);
                }
            })();
            this.ftsPromises.set(collectionName, pending);
        }
        return pending;
    }

    private rowToDocument(row: StoredRow): VectorDocument {
        let metadata: Record<string, any> = {};
        try {
            metadata = JSON.parse(row.metadata || '{}');
        } catch (error) {
            console.warn(`[LanceDB] Failed to parse metadata for row ${row.id}:`, error);
        }
        const vector = Array.isArray(row.vector)
            ? row.vector
            : Array.from(row.vector as unknown as Iterable<number>);
        return {
            id: row.id,
            vector,
            content: row.content,
            relativePath: row.relativePath,
            startLine: row.startLine,
            endLine: row.endLine,
            fileExtension: row.fileExtension,
            metadata,
        };
    }

    private documentToRow(doc: VectorDocument): StoredRow {
        return {
            id: doc.id,
            vector: doc.vector,
            content: doc.content,
            relativePath: doc.relativePath,
            startLine: doc.startLine,
            endLine: doc.endLine,
            fileExtension: doc.fileExtension,
            metadata: JSON.stringify(doc.metadata ?? {}),
        };
    }

    async createCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        const db = await this.connection();
        const existing = await db.tableNames();
        if (existing.includes(collectionName)) {
            console.log(`[LanceDB] ℹ️  Collection '${collectionName}' already exists; reusing.`);
            return;
        }
        const schema = this.buildSchema(dimension);
        console.log(`[LanceDB] 🔧 Creating collection '${collectionName}' (dim=${dimension}${description ? `, "${description}"` : ''})...`);
        await db.createEmptyTable(collectionName, schema, { existOk: true });
    }

    async createHybridCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        await this.createCollection(collectionName, dimension, description);
        // FTS index is created lazily on first hybrid search to avoid index
        // training on an empty table, which LanceDB rejects.
    }

    async dropCollection(collectionName: string): Promise<void> {
        const db = await this.connection();
        const existing = await db.tableNames();
        if (!existing.includes(collectionName)) return;
        await db.dropTable(collectionName);
        this.ftsBuilt.delete(collectionName);
        this.ftsPromises.delete(collectionName);
        console.log(`[LanceDB] 🗑️  Dropped collection '${collectionName}'.`);
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        const db = await this.connection();
        const names = await db.tableNames();
        return names.includes(collectionName);
    }

    async listCollections(): Promise<string[]> {
        const db = await this.connection();
        return db.tableNames();
    }

    async insert(collectionName: string, documents: VectorDocument[]): Promise<void> {
        if (documents.length === 0) return;
        const db = await this.connection();
        const table = await db.openTable(collectionName);
        const rows = documents.map(doc => this.documentToRow(doc));
        await table.add(rows);
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void> {
        // Storage is identical for dense and hybrid collections; the FTS index
        // is built lazily on first hybrid search, so inserts share one path.
        await this.insert(collectionName, documents);
    }

    async search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        const db = await this.connection();
        const table = await db.openTable(collectionName);
        const limit = options?.topK ?? DEFAULT_LIMIT;

        let query = table.query().nearestTo(queryVector).limit(limit);
        if (options?.filterExpr && options.filterExpr.trim().length > 0) {
            query = query.where(translateFilter(options.filterExpr));
        }

        const rows = (await query.toArray()) as StoredRow[];
        // LanceDB returns `_distance` (smaller = closer). Convert to a 0..1
        // similarity-like score so downstream threshold checks remain sensible.
        const results: VectorSearchResult[] = rows.map(row => {
            const distance = typeof row._distance === 'number' ? row._distance : 0;
            const score = 1 / (1 + distance);
            return { document: this.rowToDocument(row), score };
        });

        const threshold = options?.threshold;
        if (typeof threshold === 'number') {
            return results.filter(r => r.score >= threshold);
        }
        return results;
    }

    async hybridSearch(
        collectionName: string,
        searchRequests: HybridSearchRequest[],
        options?: HybridSearchOptions,
    ): Promise<HybridSearchResult[]> {
        const db = await this.connection();
        const table = await db.openTable(collectionName);

        const denseReq = searchRequests.find(r => Array.isArray(r.data));
        const sparseReq = searchRequests.find(r => typeof r.data === 'string');

        const limit = options?.limit ?? DEFAULT_LIMIT;
        // Fetch a wider candidate pool from each side so RRF has signal to fuse.
        const candidateLimit = Math.max(limit * 4, 40);

        const filter = options?.filterExpr?.trim() ? translateFilter(options.filterExpr) : undefined;
        const rrfK = options?.rerank?.params?.k ?? DEFAULT_RRF_K;

        // Kick off dense and FTS in parallel. The FTS branch lazily ensures
        // its index (deduped via `ftsPromises`) and degrades to an empty list
        // if the search itself fails (e.g. index not yet trained).
        let densePromise: Promise<StoredRow[]> = Promise.resolve([]);
        let ftsPromise: Promise<StoredRow[]> = Promise.resolve([]);

        if (denseReq) {
            const queryVector = denseReq.data as number[];
            let vecQuery = table.query().nearestTo(queryVector).limit(candidateLimit);
            if (filter) vecQuery = vecQuery.where(filter);
            densePromise = vecQuery.toArray() as Promise<StoredRow[]>;
        }

        if (sparseReq) {
            const queryText = sparseReq.data as string;
            ftsPromise = this.ensureFtsIndex(table, collectionName)
                .then(async () => {
                    let ftsQuery = table
                        .query()
                        .fullTextSearch(queryText, { columns: ['content'] })
                        .limit(candidateLimit);
                    if (filter) ftsQuery = ftsQuery.where(filter);
                    return (await ftsQuery.toArray()) as StoredRow[];
                })
                .catch(error => {
                    // FTS will fail if the index hasn't finished building yet (or the
                    // collection is empty). Degrade gracefully to dense-only.
                    console.warn(`[LanceDB] ⚠️  FTS search failed for '${collectionName}'; falling back to dense-only:`, error);
                    return [];
                });
        }

        const [denseRows, ftsRows] = await Promise.all([densePromise, ftsPromise]);

        // Capture per-branch rank + raw signal so callers can debug fused hits
        // without having to rerun the search. Rank is 1-based; missing entries
        // mean that branch didn't surface the chunk at all.
        const denseSub = new Map<string, { rank: number; distance?: number }>();
        denseRows.forEach((row, idx) => {
            if (!row.id) return;
            denseSub.set(row.id, {
                rank: idx + 1,
                distance: typeof row._distance === 'number' ? row._distance : undefined,
            });
        });
        const ftsSub = new Map<string, { rank: number; score?: number }>();
        ftsRows.forEach((row, idx) => {
            if (!row.id) return;
            ftsSub.set(row.id, {
                rank: idx + 1,
                score: typeof row._score === 'number' ? row._score : undefined,
            });
        });

        // Reciprocal Rank Fusion: score(id) = sum over rankings: 1 / (k + rank)
        const fused = new Map<string, { row: StoredRow; score: number }>();
        const addRanked = (rows: StoredRow[]) => {
            rows.forEach((row, idx) => {
                const id = row.id;
                if (!id) return;
                const contribution = 1 / (rrfK + idx + 1);
                const prior = fused.get(id);
                if (prior) {
                    prior.score += contribution;
                } else {
                    fused.set(id, { row, score: contribution });
                }
            });
        };
        addRanked(denseRows);
        addRanked(ftsRows);

        const sorted = Array.from(fused.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        return sorted.map(({ row, score }) => {
            const d = denseSub.get(row.id);
            const f = ftsSub.get(row.id);
            const subScores: HybridSubScores | undefined = (d ?? f) ? {
                ...(d && { denseRank: d.rank, ...(d.distance !== undefined && { denseDistance: d.distance }) }),
                ...(f && { ftsRank: f.rank, ...(f.score !== undefined && { ftsScore: f.score }) }),
            } : undefined;
            return {
                document: this.rowToDocument(row),
                score,
                ...(subScores && { subScores }),
            };
        });
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        const db = await this.connection();
        const table = await db.openTable(collectionName);
        const escaped = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
        await table.delete(`id IN (${escaped})`);
    }

    async query(
        collectionName: string,
        filter: string,
        outputFields: string[],
        limit?: number,
    ): Promise<Record<string, any>[]> {
        const db = await this.connection();
        const table = await db.openTable(collectionName);
        let q = table.query();
        if (filter && filter.trim() !== '') {
            q = q.where(translateFilter(filter));
        }
        // Always select the requested fields so we don't pay to ship the vector
        // back when the caller only needs ids/metadata.
        if (outputFields.length > 0) {
            q = q.select(outputFields);
        }
        if (typeof limit === 'number') {
            q = q.limit(limit);
        }
        return (await q.toArray()) as Record<string, any>[];
    }

    async getCollectionDescription(collectionName: string): Promise<string> {
        // LanceDB does not store a free-text description per table. Return a
        // synthetic placeholder so callers that log or hash on this value still
        // get a stable, non-empty string.
        const exists = await this.hasCollection(collectionName);
        return exists ? `LanceDB collection: ${collectionName}` : '';
    }

    async checkCollectionLimit(): Promise<boolean> {
        // LanceDB has no per-instance collection cap. Always allow creation.
        return true;
    }

    async getCollectionRowCount(collectionName: string): Promise<number> {
        try {
            const db = await this.connection();
            const names = await db.tableNames();
            if (!names.includes(collectionName)) return -1;
            const table = await db.openTable(collectionName);
            const n = await table.countRows();
            return Number.isFinite(n) && n >= 0 ? n : -1;
        } catch (error) {
            console.error(`[LanceDB] Error counting rows in '${collectionName}':`, error);
            return -1;
        }
    }
}
