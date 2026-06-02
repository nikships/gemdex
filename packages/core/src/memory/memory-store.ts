import * as crypto from 'crypto';
import { Embedding, EmbeddingVector } from '../embedding';
import {
    VectorDatabase,
    VectorDocument,
    HybridSearchRequest,
    HybridSearchResult,
} from '../vectordb';
import { envManager } from '../utils/env-manager';
import { chunkMemory, deriveTitle, ChunkOptions } from './chunker';
import {
    Memory,
    MemorySummary,
    MemoryRecallResult,
    SaveMemoryInput,
    UpdateMemoryInput,
    MemoryExportRecord,
} from './types';

const DEFAULT_COLLECTION = 'memories';
const DEFAULT_PREVIEW_LENGTH = 200;
const LIST_FETCH_LIMIT = 100000;

/**
 * Internal mapping between the memory model and the generic hybrid vector
 * store. Each retrieval chunk is one stored row. The generic store's columns
 * are reused as typed, filterable storage slots:
 *
 *   id            -> `${parentId}::${chunkIndex}`   (unique per chunk)
 *   vector        -> chunk embedding
 *   content       -> chunk text (the BM25 + dense target)
 *   relativePath  -> parentId        (filterable: get / list / delete grouping)
 *   startLine     -> chunkIndex
 *   endLine       -> chunkCount
 *   fileExtension -> "" (unused)
 *   metadata.json -> { title, fullContent, createdAt, updatedAt }
 *
 * Recall ranks chunks then resolves + dedupes back to whole parent memories,
 * so the caller never receives a fragment (the "parent document retriever"
 * pattern).
 */
interface ParentMeta {
    title: string;
    fullContent: string;
    createdAt: number;
    updatedAt: number;
}

export interface MemoryStoreConfig {
    embedding: Embedding;
    vectorDatabase: VectorDatabase;
    /** Override the single global table name. Defaults to `memories`. */
    collectionName?: string;
    /** Chunking parameters; sensible defaults applied when omitted. */
    chunkOptions?: ChunkOptions;
}

export class MemoryStore {
    private embedding: Embedding;
    private db: VectorDatabase;
    private collectionName: string;
    private chunkOptions: ChunkOptions;
    private collectionReady?: Promise<void>;

    constructor(config: MemoryStoreConfig) {
        this.embedding = config.embedding;
        this.db = config.vectorDatabase;
        this.collectionName = config.collectionName || DEFAULT_COLLECTION;
        this.chunkOptions = config.chunkOptions ?? {};
    }

    private getIsHybrid(): boolean {
        const isHybridEnv = envManager.get('HYBRID_MODE');
        if (isHybridEnv === undefined || isHybridEnv === null) return true;
        return isHybridEnv.toLowerCase() === 'true';
    }

    /** Ensure the single global collection exists (idempotent, deduped). */
    private async ensureCollection(): Promise<void> {
        if (!this.collectionReady) {
            this.collectionReady = (async () => {
                const dimension = this.embedding.getDimension();
                await this.db.createHybridCollection(this.collectionName, dimension, 'Gemdex memory layer');
            })();
        }
        return this.collectionReady;
    }

    private static newId(): string {
        return crypto.randomUUID();
    }

    private static chunkRowId(parentId: string, chunkIndex: number): string {
        return `${parentId}::${chunkIndex}`;
    }

    private static escapeLiteral(value: string): string {
        return value.replace(/'/g, "''");
    }

    private buildChunkRows(
        parentId: string,
        chunks: string[],
        vectors: EmbeddingVector[],
        meta: ParentMeta,
    ): VectorDocument[] {
        return chunks.map((chunk, index) => ({
            id: MemoryStore.chunkRowId(parentId, index),
            vector: vectors[index].vector,
            content: chunk,
            relativePath: parentId,
            startLine: index,
            endLine: chunks.length,
            fileExtension: '',
            metadata: {
                title: meta.title,
                fullContent: meta.fullContent,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
            },
        }));
    }

    private async embedChunks(chunks: string[]): Promise<EmbeddingVector[]> {
        return this.embedding.embedContentBatch(chunks);
    }

    private rowToParentMeta(metadata: Record<string, any>): ParentMeta {
        return {
            title: typeof metadata.title === 'string' ? metadata.title : '',
            fullContent: typeof metadata.fullContent === 'string' ? metadata.fullContent : '',
            createdAt: Number(metadata.createdAt) || 0,
            updatedAt: Number(metadata.updatedAt) || 0,
        };
    }

    /**
     * Persist a new memory: chunk -> embed each chunk -> store under a new
     * parent id. Returns the created memory (including the resolved title).
     */
    async save(input: SaveMemoryInput): Promise<Memory> {
        const content = input.content ?? '';
        if (content.trim().length === 0) {
            throw new Error('Cannot save an empty memory');
        }
        await this.ensureCollection();

        const id = MemoryStore.newId();
        const now = Date.now();
        const title = input.title?.trim() || deriveTitle(content);

        const chunks = chunkMemory(content, this.chunkOptions);
        const vectors = await this.embedChunks(chunks);
        const meta: ParentMeta = { title, fullContent: content, createdAt: now, updatedAt: now };
        const rows = this.buildChunkRows(id, chunks, vectors, meta);

        await this.db.insertHybrid(this.collectionName, rows);

        return { id, title, content, createdAt: now, updatedAt: now };
    }

    /**
     * Retrieve memories by natural-language query. Hybrid (or dense-only when
     * HYBRID_MODE=false) search over chunks, resolved to full parent memories
     * and deduplicated by parent id. Pure relevance ranking.
     */
    async recall(query: string, limit = 10): Promise<MemoryRecallResult[]> {
        const trimmed = (query ?? '').trim();
        if (trimmed.length === 0) return [];

        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return [];

        const queryEmbedding = await this.embedding.embed(trimmed);
        // Over-fetch chunks so that after dedupe-by-parent we still have enough
        // distinct memories to satisfy `limit`.
        const chunkLimit = Math.max(limit * 4, 20);

        let hits: HybridSearchResult[];
        if (this.getIsHybrid()) {
            const requests: HybridSearchRequest[] = [
                { data: queryEmbedding.vector, anns_field: 'vector', param: {}, limit: chunkLimit },
                { data: trimmed, anns_field: 'sparse_vector', param: {}, limit: chunkLimit },
            ];
            hits = await this.db.hybridSearch(this.collectionName, requests, {
                rerank: { strategy: 'rrf', params: { k: 100 } },
                limit: chunkLimit,
            });
        } else {
            const dense = await this.db.search(this.collectionName, queryEmbedding.vector, { topK: chunkLimit });
            hits = dense.map((r) => ({ document: r.document, score: r.score }));
        }

        // Resolve chunks to parents and dedupe, keeping the best-scoring chunk
        // per parent. Results stay ranked by fused relevance.
        const byParent = new Map<string, MemoryRecallResult>();
        for (const hit of hits) {
            const parentId = hit.document.relativePath;
            if (!parentId) continue;
            const meta = this.rowToParentMeta(hit.document.metadata);
            const existing = byParent.get(parentId);
            if (!existing || hit.score > existing.score) {
                byParent.set(parentId, {
                    id: parentId,
                    title: meta.title,
                    content: meta.fullContent,
                    createdAt: meta.createdAt,
                    updatedAt: meta.updatedAt,
                    score: hit.score,
                    ...(hit.subScores && { subScores: hit.subScores }),
                });
            }
        }

        return Array.from(byParent.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Revise an existing memory in place: delete its chunks -> re-chunk ->
     * re-embed -> re-insert under the same id. Bumps updatedAt, preserves
     * createdAt. Throws if the id does not exist.
     */
    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const content = input.content ?? '';
        if (content.trim().length === 0) {
            throw new Error('Cannot update a memory to empty content');
        }
        const existing = await this.get(id);
        if (!existing) {
            throw new Error(`Memory not found: ${id}`);
        }
        await this.ensureCollection();

        await this.deleteChunkRows(id);

        const now = Date.now();
        const title = input.title?.trim() || deriveTitle(content);
        const chunks = chunkMemory(content, this.chunkOptions);
        const vectors = await this.embedChunks(chunks);
        const meta: ParentMeta = {
            title,
            fullContent: content,
            createdAt: existing.createdAt,
            updatedAt: now,
        };
        const rows = this.buildChunkRows(id, chunks, vectors, meta);
        await this.db.insertHybrid(this.collectionName, rows);

        return { id, title, content, createdAt: existing.createdAt, updatedAt: now };
    }

    /** Fetch a single full memory by id, or null if absent. */
    async get(id: string): Promise<Memory | null> {
        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return null;
        const filter = `relativePath == '${MemoryStore.escapeLiteral(id)}'`;
        const rows = await this.db.query(
            this.collectionName,
            filter,
            ['relativePath', 'metadata', 'startLine'],
            LIST_FETCH_LIMIT,
        );
        if (rows.length === 0) return null;
        const meta = this.rowToParentMeta(this.parseMetadata(rows[0].metadata));
        return {
            id,
            title: meta.title,
            content: meta.fullContent,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
        };
    }

    /** List all memories (sorted by updatedAt desc) for browsing. */
    async list(): Promise<MemorySummary[]> {
        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return [];
        const rows = await this.db.query(
            this.collectionName,
            '',
            ['relativePath', 'metadata'],
            LIST_FETCH_LIMIT,
        );

        const byParent = new Map<string, ParentMeta>();
        for (const row of rows) {
            const parentId = row.relativePath as string;
            if (!parentId || byParent.has(parentId)) continue;
            byParent.set(parentId, this.rowToParentMeta(this.parseMetadata(row.metadata)));
        }

        return Array.from(byParent.entries())
            .map(([id, meta]) => ({
                id,
                title: meta.title,
                preview: this.makePreview(meta.fullContent),
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /** Delete a memory (all its chunk rows). No-op if absent. */
    async delete(id: string): Promise<void> {
        await this.deleteChunkRows(id);
    }

    /** Export all memories as portable records (sorted by updatedAt desc). */
    async exportAll(): Promise<MemoryExportRecord[]> {
        const summaries = await this.list();
        const records: MemoryExportRecord[] = [];
        for (const summary of summaries) {
            const memory = await this.get(summary.id);
            if (memory) {
                records.push({
                    id: memory.id,
                    title: memory.title,
                    content: memory.content,
                    createdAt: memory.createdAt,
                    updatedAt: memory.updatedAt,
                });
            }
        }
        return records;
    }

    /**
     * Import memories from portable records. Upsert by id (default merge
     * policy, §7.5): an existing id is replaced; a new id is inserted.
     * Re-embeds content via the configured embedding provider.
     */
    async importRecords(records: MemoryExportRecord[]): Promise<{ imported: number }> {
        await this.ensureCollection();
        let imported = 0;
        for (const record of records) {
            const content = record.content ?? '';
            if (content.trim().length === 0) continue;

            const id = record.id || MemoryStore.newId();
            await this.deleteChunkRows(id);

            const now = Date.now();
            const title = record.title?.trim() || deriveTitle(content);
            const chunks = chunkMemory(content, this.chunkOptions);
            const vectors = await this.embedChunks(chunks);
            const meta: ParentMeta = {
                title,
                fullContent: content,
                createdAt: Number(record.createdAt) || now,
                updatedAt: Number(record.updatedAt) || now,
            };
            const rows = this.buildChunkRows(id, chunks, vectors, meta);
            await this.db.insertHybrid(this.collectionName, rows);
            imported += 1;
        }
        return { imported };
    }

    private async deleteChunkRows(parentId: string): Promise<void> {
        const exists = await this.db.hasCollection(this.collectionName);
        if (!exists) return;
        const filter = `relativePath == '${MemoryStore.escapeLiteral(parentId)}'`;
        const rows = await this.db.query(this.collectionName, filter, ['id'], LIST_FETCH_LIMIT);
        const ids = rows.map((r) => r.id as string).filter(Boolean);
        if (ids.length > 0) {
            await this.db.delete(this.collectionName, ids);
        }
    }

    private parseMetadata(raw: unknown): Record<string, any> {
        if (raw && typeof raw === 'object') return raw as Record<string, any>;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw || '{}');
            } catch {
                return {};
            }
        }
        return {};
    }

    private makePreview(content: string, length = DEFAULT_PREVIEW_LENGTH): string {
        const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
        if (collapsed.length <= length) return collapsed;
        return collapsed.slice(0, length).trimEnd() + '…';
    }
}
