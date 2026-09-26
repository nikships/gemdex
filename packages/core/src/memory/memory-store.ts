import * as crypto from 'crypto';
import { Embedding, EmbeddingVector } from '../embedding';
import {
    VectorDatabase,
    VectorDocument,
    HybridSearchRequest,
    HybridSearchResult,
} from '../vectordb';
import { envManager } from '../utils/env-manager';
import { DEFAULT_HYGIENE_THRESHOLD, normalizedCentroid, cosine } from '../utils/centroid';
import { chunkMemory, deriveTitle, ChunkOptions } from './chunker';
import { BlobStore, FileBlobStore } from './blob-store';
import {
    AttachmentLimits,
    AttachmentValidationError,
    DEFAULT_ATTACHMENT_LIMITS,
    isEmbeddableAttachmentKind,
    mimeToKind,
    validateAttachments,
} from './attachment-validator';
import {
    AttachmentKind,
    AttachmentCaptionUpdate,
    ImportRecordError,
    ImportRecordsResult,
    Memory,
    MemoryAttachment,
    MemoryAttachmentInput,
    MemorySummary,
    MemoryRecallResult,
    SaveMemoryInput,
    SaveResult,
    SimilarMemoryRef,
    UpdateMemoryInput,
    MemoryExportRecord,
    MemoryExportAttachment,
    AttachmentBytes,
} from './types';
export type { AttachmentBytes } from './types';

/** The local text index (BGE-M3 via MLX, 1024 dimensions). */
export const LOCAL_TEXT_COLLECTION = 'memories_mlx_bge_m3_8bit';
/** The index written by earlier Gemini-embedded releases (3072 dimensions). */
export const LEGACY_GEMINI_COLLECTION = 'memories';
const DEFAULT_PREVIEW_LENGTH = 200;
const LIST_FETCH_LIMIT = 100000;
/** Reciprocal Rank Fusion constant for the hybrid (dense + BM25) text path. */
const RECALL_RRF_K = 100;
/** Texts per embedding request; the MLX worker caps a batch at 16. */
const EMBED_BATCH_SIZE = 16;
/**
 * Save-time similar-memory detection: how many ANN candidates to pull for
 * discovery (cheap, approximate — only used to shortlist parent ids) and how
 * many of those candidates get an exact centroid-vs-centroid rescoring (the
 * one authoritative "similarity" number reported back to the caller).
 */
const SIMILAR_ANN_CANDIDATES = 20;
const SIMILAR_MAX_RESCORED = 8;
const SIMILAR_MAX_RESULTS = 3;

/**
 * Internal mapping between the memory model and the generic hybrid vector
 * store. Each retrieval chunk is one stored row. The generic store's columns
 * are reused as typed, filterable storage slots:
 *
 *   id            -> `${parentId}::${chunkIndex}`
 *                    (legacy media rows: `${parentId}::att::${attachIndex}`)
 *   vector        -> chunk text embedding
 *   content       -> chunk text (the BM25 target)
 *   relativePath  -> parentId        (filterable: get / list / delete grouping)
 *   startLine     -> chunk/attachment index
 *   endLine       -> chunk/attachment count
 *   fileExtension -> "" (unused)
 *   metadata.json -> { title, fullContent, createdAt, updatedAt, attachments }
 *
 * Recall ranks chunks then resolves + dedupes back to whole parent memories,
 * so the caller never receives a fragment (the "parent document retriever"
 * pattern). Attachments are never embedded: their bytes live in the BlobStore
 * and only their metadata rides along in `metadata.attachments`.
 */
interface StoredAttachment {
    /** Stable within the parent memory (the attachment's index as a string). */
    id: string;
    kind: AttachmentKind;
    mimeType: string;
    byteLength: number;
    caption?: string;
    /** Opaque ref into the BlobStore where the raw bytes live. */
    blobRef: string;
}

interface ParentMeta {
    title: string;
    fullContent: string;
    createdAt: number;
    updatedAt: number;
    attachments: StoredAttachment[];
}

/**
 * One parent memory with every stored row vector it owns (text chunks +
 * attachments). Used by the hygiene feature to cluster similar memories
 * from the vectors already in LanceDB, without any embedding API calls.
 */
export interface ParentVectorData {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    fullContent: string;
    /** All row vectors for this parent (chunks + attachments). */
    vectors: number[][];
}

export interface MemoryStoreConfig {
    /** Text embedding for every write and query. */
    embedding: Embedding;
    vectorDatabase: VectorDatabase;
    /** Index table name. Defaults to {@link LOCAL_TEXT_COLLECTION}. */
    collectionName?: string;
    /**
     * An older index in a different embedding space (e.g. the Gemini
     * `memories` table). Its memories stay listable, readable, updatable,
     * deletable and exportable, and {@link MemoryStore.migrateLegacy} moves them
     * into the main index. It is never searched: its vectors cannot be compared
     * with the main embedding, so recall and hygiene refuse to run while it
     * still holds rows rather than silently omitting those memories.
     */
    legacyCollectionName?: string;
    /** Chunking parameters; sensible defaults applied when omitted. */
    chunkOptions?: ChunkOptions;
    /** Where attachment bytes are stored. Defaults to `~/.gemdex/blobs`. */
    blobStore?: BlobStore;
    /** Per-modality attachment limits. Defaults applied when omitted. */
    attachmentLimits?: AttachmentLimits;
}

export class MemoryStore {
    private embedding: Embedding;
    private db: VectorDatabase;
    private collectionName: string;
    private legacyCollectionName?: string;
    private chunkOptions: ChunkOptions;
    private blobStore: BlobStore;
    private attachmentLimits: AttachmentLimits;
    private collectionReady?: Promise<void>;

    constructor(config: MemoryStoreConfig) {
        this.embedding = config.embedding;
        this.db = config.vectorDatabase;
        this.collectionName = config.collectionName ?? LOCAL_TEXT_COLLECTION;
        this.legacyCollectionName = config.legacyCollectionName;
        if (this.legacyCollectionName === this.collectionName) {
            throw new Error('The legacy collection must differ from the main collection');
        }
        this.chunkOptions = config.chunkOptions ?? {};
        this.blobStore = config.blobStore ?? new FileBlobStore();
        this.attachmentLimits = config.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
    }

    private getIsHybrid(): boolean {
        return (envManager.get('HYBRID_MODE') ?? 'true').toLowerCase() === 'true';
    }

    /** Ensure the main collection exists (idempotent, deduped). */
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

    private get banks(): string[] {
        return this.legacyCollectionName ? [this.collectionName, this.legacyCollectionName] : [this.collectionName];
    }

    private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
        return this.db.withMemoryWriteLock ? this.db.withMemoryWriteLock(operation) : operation();
    }

    private async queryBanks(filter: string, fields: string[]): Promise<Record<string, any>[]> {
        const rows: Record<string, any>[] = [];
        for (const collection of this.banks) {
            if (!await this.db.hasCollection(collection)) continue;
            // Bulk operations must cover the entire bank, not silently stop at
            // the old 100k-row browse cap (one parent may own many chunks).
            for (const row of await this.db.query(collection, filter, fields)) {
                rows.push({ ...row, bank: collection });
            }
        }
        return rows;
    }

    private static chunkRowId(parentId: string, chunkIndex: number): string {
        return `${parentId}::${chunkIndex}`;
    }

    private static escapeLiteral(value: string): string {
        return value.replace(/'/g, "''");
    }

    private metaToRecord(meta: ParentMeta): Record<string, any> {
        return {
            title: meta.title,
            fullContent: meta.fullContent,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            attachments: meta.attachments,
        };
    }

    private buildChunkRows(
        parentId: string,
        chunks: string[],
        vectors: EmbeddingVector[],
        meta: ParentMeta,
    ): VectorDocument[] {
        const record = this.metaToRecord(meta);
        return chunks.map((chunk, index) => ({
            id: MemoryStore.chunkRowId(parentId, index),
            vector: vectors[index].vector,
            content: chunk,
            relativePath: parentId,
            startLine: index,
            endLine: chunks.length,
            fileExtension: '',
            metadata: record,
        }));
    }

    private async embedChunks(chunks: string[]): Promise<EmbeddingVector[]> {
        // A large parent can contain thousands of chunks. Keep each request
        // bounded without imposing the provider's batch cap on parents.
        const vectors: EmbeddingVector[] = [];
        for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
            vectors.push(...await this.embedding.embedContentBatch(chunks.slice(offset, offset + EMBED_BATCH_SIZE)));
        }
        return vectors;
    }

    private rowToParentMeta(metadata: Record<string, any>): ParentMeta {
        const attachments = Array.isArray(metadata.attachments)
            ? metadata.attachments
                .map((raw: unknown) => MemoryStore.normalizeStoredAttachment(raw))
                .filter((a: StoredAttachment | null): a is StoredAttachment => a !== null)
            : [];
        return {
            title: typeof metadata.title === 'string' ? metadata.title : '',
            fullContent: typeof metadata.fullContent === 'string' ? metadata.fullContent : '',
            createdAt: Number(metadata.createdAt) || 0,
            updatedAt: Number(metadata.updatedAt) || 0,
            attachments,
        };
    }

    private static normalizeStoredAttachment(raw: unknown): StoredAttachment | null {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, any>;
        if (typeof r.blobRef !== 'string' || typeof r.mimeType !== 'string') return null;
        const kinds: AttachmentKind[] = ['image', 'audio', 'video', 'pdf', 'file'];
        const kind = kinds.includes(r.kind) ? (r.kind as AttachmentKind) : mimeToKind(r.mimeType);
        if (!kind) return null;
        const caption = typeof r.caption === 'string' && r.caption.length > 0 ? r.caption : undefined;
        return {
            id: typeof r.id === 'string' ? r.id : '0',
            kind,
            mimeType: r.mimeType,
            byteLength: Number(r.byteLength) || 0,
            ...(caption && { caption }),
            blobRef: r.blobRef,
        };
    }

    private static toPublicAttachments(stored: StoredAttachment[]): MemoryAttachment[] {
        return stored.map((a) => ({
            id: a.id,
            kind: a.kind,
            mimeType: a.mimeType,
            byteLength: a.byteLength,
            ...(a.caption && { caption: a.caption }),
        }));
    }

    private static resolveTitle(
        explicit: string | undefined,
        content: string,
        attachments: { kind: AttachmentKind; caption?: string }[],
    ): string {
        const trimmed = explicit?.trim();
        if (trimmed) return trimmed;
        if (content.trim().length > 0) return deriveTitle(content);
        // Media-only memory: derive from the first caption, else a kind summary.
        const captioned = attachments.find((a) => a.caption && a.caption.trim().length > 0);
        if (captioned?.caption) return deriveTitle(captioned.caption);
        if (attachments.length === 1) return `${attachments[0].kind} attachment`;
        if (attachments.length > 1) return `${attachments.length} attachments`;
        return deriveTitle(content);
    }

    /**
     * The single write path shared by save/update/import. Overwrites any rows +
     * blobs already under `id` (in either index), then persists the supplied
     * text + attachments into the main index. Attachments are stored as blobs
     * and never embedded. Image/audio/video/PDF attachments are refused unless
     * `preserveMedia` is set, which only the update-preserve and import paths
     * use so media saved by earlier releases survives an edit or a restore.
     * Throws if the resulting memory would be completely empty.
     *
     * Also returns the chunk vectors it just computed so `save` can reuse them
     * for similar-memory detection with zero extra embedding calls.
     */
    private async writeMemory(
        id: string,
        content: string,
        explicitTitle: string | undefined,
        attachmentsInput: MemoryAttachmentInput[],
        createdAt: number,
        updatedAt: number,
        options: { preserveMedia?: boolean } = {},
    ): Promise<{ memory: Memory; chunkVectors: EmbeddingVector[] }> {
        const text = content ?? '';
        const validated = attachmentsInput.length > 0
            ? await validateAttachments(attachmentsInput, this.attachmentLimits)
            : [];

        if (!options.preserveMedia) {
            const media = validated.find((att) => isEmbeddableAttachmentKind(att.kind));
            if (media) {
                throw new AttachmentValidationError(
                    `${media.mimeType} attachments are not supported: the local embedding model is text-only. ` +
                    'Only text/JSON file attachments (e.g. transcripts) can be stored.',
                );
            }
        }

        // Guard BEFORE any destructive work: an empty payload must never wipe an
        // existing memory on an update/import overwrite.
        if (text.trim().length === 0 && validated.length === 0) {
            throw new Error('Cannot persist an empty memory (no content and no attachments)');
        }

        const title = MemoryStore.resolveTitle(explicitTitle, text, validated);

        // Embed FIRST — the failure-prone step. Computing the vectors before
        // deleting the prior rows/blobs means a failed update/import leaves the
        // existing memory intact instead of destroying it.
        let chunks = text.trim().length > 0 ? chunkMemory(text, this.chunkOptions) : [];
        // Attachment-only memories still need one row for get/list/delete
        // grouping — index the title only, never the attachment body.
        if (chunks.length === 0) chunks = [title];
        const chunkVectors = await this.embedChunks(chunks);
        await this.ensureCollection();

        // Keep a rollback snapshot when the prior rows may live in the legacy
        // index: neither table can transactionally commit the other's rows or
        // the blob store.
        const previous = this.legacyCollectionName ? await this.queryBanks(
            `relativePath == '${MemoryStore.escapeLiteral(id)}'`,
            ['id', 'vector', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
        ) : [];
        const previousMeta = previous.length ? this.rowToParentMeta(this.parseMetadata(previous[0].metadata)) : null;
        const previousBlobs = await Promise.all((previousMeta?.attachments ?? []).map(async att => ({
            id: att.id, bytes: await this.blobStore.get(att.blobRef),
        })));

        try {
            // Embedding succeeded — only now clear prior state.
            await this.deleteChunkRows(id);
            await this.blobStore.deleteParent(id);
            // Preserve caller-supplied attachment ids (e.g. "transcript") for idempotent re-import.
            const usedIds = new Set<string>();
            const stored: StoredAttachment[] = [];
            for (let i = 0; i < validated.length; i++) {
                const att = validated[i];
                const requestedId = attachmentsInput[i]?.id?.trim();
                let attachmentId = requestedId && requestedId.length > 0 ? requestedId : String(i);
                if (usedIds.has(attachmentId)) {
                    attachmentId = `${attachmentId}-${i}`;
                }
                usedIds.add(attachmentId);
                const blobRef = await this.blobStore.put(id, attachmentId, att.bytes);
                stored.push({
                    id: attachmentId,
                    kind: att.kind,
                    mimeType: att.mimeType,
                    byteLength: att.byteLength,
                    ...(att.caption && { caption: att.caption }),
                    blobRef,
                });
            }

            const meta: ParentMeta = { title, fullContent: text, createdAt, updatedAt, attachments: stored };
            await this.db.insertHybrid(this.collectionName, this.buildChunkRows(id, chunks, chunkVectors, meta));

            return {
                memory: {
                    id,
                    title,
                    content: text,
                    attachments: MemoryStore.toPublicAttachments(stored),
                    createdAt,
                    updatedAt,
                },
                chunkVectors,
            };
        } catch (error) {
            // Don't leave orphan blobs behind if blob writes or the insert failed.
            await this.deleteChunkRows(id).catch(() => undefined);
            await this.blobStore.deleteParent(id).catch(() => undefined);
            for (const blob of previousBlobs) await this.blobStore.put(id, blob.id, blob.bytes);
            for (const bank of this.banks) {
                const documents = previous.filter(row => row.bank === bank).map(row => ({
                    ...row,
                    vector: Array.from(row.vector as Iterable<number>),
                    metadata: this.parseMetadata(row.metadata),
                } as VectorDocument));
                if (documents.length) await this.db.insertHybrid(bank, documents);
            }
            throw error;
        }
    }

    /**
     * Persist a new memory. Text is chunked + embedded; attachments (text/JSON
     * files only) are stored as blobs on disk. Returns the
     * created memory (including the resolved title + attachment metadata) plus
     * advisory `similar` candidates when save-time detection finds any.
     *
     * Detection runs AFTER the write succeeds (the saved memory itself is the
     * priority, and this keeps `writeMemory`'s shared save/update/import
     * semantics untouched) and is wrapped in try/catch: a detection failure of
     * any kind can never fail or delay-fail the save — see `findSimilarParents`.
     */
    async save(input: SaveMemoryInput): Promise<SaveResult> {
        return this.withWriteLock(() => this.saveUnlocked(input));
    }

    private async saveUnlocked(input: SaveMemoryInput): Promise<SaveResult> {
        const content = input.content ?? '';
        const attachmentsInput = input.attachments ?? [];
        if (content.trim().length === 0 && attachmentsInput.length === 0) {
            throw new Error('Cannot save an empty memory (provide content or at least one attachment)');
        }
        const id = MemoryStore.newId();
        const now = Date.now();
        const { memory, chunkVectors } = await this.writeMemory(id, content, input.title, attachmentsInput, now, now);

        let similar: SimilarMemoryRef[] = [];
        try {
            similar = await this.findSimilarParents(chunkVectors.map(v => v.vector), id);
        } catch (error) {
            // Advisory only — never let detection failure taint a successful save.
            console.error('[MemoryStore] Save-time similar-memory detection failed:', error);
        }

        return { ...memory, ...(similar.length > 0 && { similar }) };
    }

    /** Read the `GEMDEX_SIMILAR_THRESHOLD` override, validating it fails fast. */
    private static resolveSimilarThreshold(): number {
        const raw = envManager.get('GEMDEX_SIMILAR_THRESHOLD');
        if (raw === undefined) return DEFAULT_HYGIENE_THRESHOLD;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
            throw new Error(
                `Invalid GEMDEX_SIMILAR_THRESHOLD '${raw}': must be a number in (0, 1].`,
            );
        }
        return parsed;
    }

    /**
     * Save-time similar-memory/conflict detection. Reuses the vectors `save`
     * already computed for the new memory — zero extra embedding/network
     * calls, one local ANN query plus a handful of filtered reads. Semantics
     * intentionally match memory hygiene (`hygiene/candidate-finder.ts`):
     * centroid-vs-centroid cosine similarity over a memory's row vectors, at
     * the same default threshold (`DEFAULT_HYGIENE_THRESHOLD`) — one mental
     * model for "similar" across the product.
     *
     * Disabled entirely when `GEMDEX_SIMILAR_ON_SAVE` is `'false'` (on by
     * default — purely additive). Returns `[]` on an empty/nonexistent
     * collection or when the new memory has no vectors (e.g. import paths
     * never call this at all). `excludeId` drops the just-saved memory itself
     * out of its own candidate list.
     */
    private async findSimilarParents(newVectors: number[][], excludeId: string): Promise<SimilarMemoryRef[]> {
        const collection = this.collectionName;
        const enabled = (envManager.get('GEMDEX_SIMILAR_ON_SAVE') ?? 'true').toLowerCase() !== 'false';
        if (!enabled || newVectors.length === 0) return [];

        const threshold = MemoryStore.resolveSimilarThreshold();

        const exists = await this.db.hasCollection(collection);
        if (!exists) return [];

        const centroid = normalizedCentroid(newVectors);

        // Candidate discovery: the ANN score itself is only used to shortlist
        // parent ids, never as the reported similarity (metric-agnostic — the
        // exact score always comes from the centroid-vs-centroid rescoring below).
        const annHits = await this.db.search(collection, centroid, { topK: SIMILAR_ANN_CANDIDATES });
        const candidateIds: string[] = [];
        const seen = new Set<string>();
        for (const hit of annHits) {
            const parentId = hit.document.relativePath;
            if (!parentId || parentId === excludeId || seen.has(parentId)) continue;
            seen.add(parentId);
            candidateIds.push(parentId);
            if (candidateIds.length >= SIMILAR_MAX_RESCORED) break;
        }
        if (candidateIds.length === 0) return [];

        // Exact scoring: rebuild each candidate's own centroid from ALL of its
        // row vectors (reusing the row-reading/vector-coercion pattern from
        // `listParentsWithVectors`/`updateAttachmentCaptions`) and compare.
        // Candidates are independent reads, so run them concurrently
        // (≤ `SIMILAR_MAX_RESCORED` at once) to keep the save path fast.
        const scored = await Promise.all(candidateIds.map(async (parentId): Promise<SimilarMemoryRef | null> => {
            const filter = `relativePath == '${MemoryStore.escapeLiteral(parentId)}'`;
            const rows = await this.db.query(
                collection,
                filter,
                ['vector', 'metadata'],
                LIST_FETCH_LIMIT,
            );
            if (rows.length === 0) return null;
            const parentVectors = rows.map((row) =>
                Array.isArray(row.vector) ? (row.vector as number[]) : Array.from(row.vector as Iterable<number>));
            const parentCentroid = normalizedCentroid(parentVectors);
            const similarity = cosine(centroid, parentCentroid);
            if (similarity < threshold) return null;
            const meta = this.rowToParentMeta(this.parseMetadata(rows[0].metadata));
            return { id: parentId, title: meta.title, similarity, updatedAt: meta.updatedAt };
        }));

        return scored
            .filter((r): r is SimilarMemoryRef => r !== null)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, SIMILAR_MAX_RESULTS);
    }

    /**
     * Retrieve memories by a natural-language query: hybrid (dense + BM25)
     * search over chunks, resolved to full parent memories and deduped by
     * parent id. Pure relevance ranking.
     *
     * `queryAttachments` exists for {@link MemoryBackend} parity; the local
     * text model cannot embed media, so supplying any throws. Throws while the
     * legacy index still holds memories, because they cannot be searched and
     * silently leaving them out of results would look like data loss.
     */
    async recall(
        query?: string,
        limit = 10,
        queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        if ((queryAttachments?.length ?? 0) > 0) {
            throw new AttachmentValidationError('Recall by media is not supported: the local embedding model is text-only.');
        }
        const trimmed = (query ?? '').trim();
        if (trimmed.length === 0) return [];
        await this.assertNoLegacyRows('search');

        if (!await this.db.hasCollection(this.collectionName) ||
            (await this.db.query(this.collectionName, '', ['id'], 1)).length === 0) return [];

        // Over-fetch chunks so that after dedupe-by-parent we still have enough
        // distinct memories to satisfy `limit`.
        const chunkLimit = Math.max(limit * 4, 20);
        const hits = await this.searchText(trimmed, chunkLimit);
        return this.resolveHitsToParents(hits, limit);
    }

    /** One text branch: hybrid (dense + BM25) when enabled, else dense-only. */
    private async searchText(trimmed: string, chunkLimit: number): Promise<HybridSearchResult[]> {
        const queryEmbedding = await this.embedding.embedQuery(trimmed);
        if (this.getIsHybrid()) {
            const requests: HybridSearchRequest[] = [
                { data: queryEmbedding.vector, anns_field: 'vector', param: {}, limit: chunkLimit },
                { data: trimmed, anns_field: 'sparse_vector', param: {}, limit: chunkLimit },
            ];
            return this.db.hybridSearch(this.collectionName, requests, {
                rerank: { strategy: 'rrf', params: { k: RECALL_RRF_K } },
                limit: chunkLimit,
            });
        }
        const dense = await this.db.search(this.collectionName, queryEmbedding.vector, { topK: chunkLimit });
        return dense.map((r) => ({ document: r.document, score: r.score }));
    }

    /** Number of parent memories still stored only in the legacy index. */
    async countLegacyMemories(): Promise<number> {
        const legacy = this.legacyCollectionName;
        if (!legacy || !await this.db.hasCollection(legacy)) return 0;
        const rows = await this.db.query(legacy, '', ['relativePath'], LIST_FETCH_LIMIT);
        return new Set(rows.map((row) => row.relativePath as string).filter(Boolean)).size;
    }

    private async assertNoLegacyRows(action: string): Promise<void> {
        const legacy = this.legacyCollectionName;
        if (!legacy || !await this.db.hasCollection(legacy)) return;
        if ((await this.db.query(legacy, '', ['id'], 1)).length === 0) return;
        throw new Error(
            `Cannot ${action} yet: some memories are still in the legacy Gemini index. ` +
            'Run `npx gemdex-mcp migrate` (or Settings → Migrate in the desktop app) to re-embed them locally.',
        );
    }

    /**
     * Resolve ranked chunk rows back to full parent memories,
     * keeping the best-scoring row per parent so a caller never receives a
     * fragment. Results stay ranked by fused relevance.
     */
    private resolveHitsToParents(hits: HybridSearchResult[], limit: number): MemoryRecallResult[] {
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
                    attachments: MemoryStore.toPublicAttachments(meta.attachments),
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
     * Revise an existing memory in place under the same id. Omitted fields are
     * preserved: leaving out `content` keeps the prior text, leaving out
     * `attachments` keeps the prior attachments (including media stored by
     * earlier releases). Bumps updatedAt, preserves createdAt. Throws if the id
     * does not exist.
     */
    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        return this.withWriteLock(() => this.updateUnlocked(id, input));
    }

    private async updateUnlocked(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const existing = await this.loadParentMeta(id);
        if (!existing) {
            throw new Error(`Memory not found: ${id}`);
        }

        const content = input.content ?? existing.fullContent;
        const preserveMedia = input.attachments === undefined;
        const attachmentsInput = input.attachments ?? await this.attachmentsToInput(existing.attachments);
        const title = input.title ?? existing.title;

        if ((content ?? '').trim().length === 0 && attachmentsInput.length === 0) {
            throw new Error('Cannot update a memory to empty content (provide content or at least one attachment)');
        }

        const now = Date.now();
        const { memory } = await this.writeMemory(
            id, content, title, attachmentsInput, existing.createdAt, now, { preserveMedia });
        return memory;
    }

    /**
     * Update only attachment captions without re-embedding. Editing a caption
     * is pure metadata, so this reads every stored row for the memory back WITH
     * its `vector` column, rewrites only the caption-derived fields (the BM25
     * `content` of legacy media rows + the shared `attachments`/`updatedAt`
     * metadata), and re-inserts the rows with their original vectors intact.
     * Blobs are never touched.
     *
     * Captions are matched by attachment id; an empty/whitespace caption clears
     * it (its BM25 text falls back to the title). Throws if the memory does not
     * exist, or if a supplied caption id matches no attachment.
     */
    async updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        return this.withWriteLock(() => this.updateAttachmentCaptionsUnlocked(id, captions));
    }

    private async updateAttachmentCaptionsUnlocked(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const filter = `relativePath == '${MemoryStore.escapeLiteral(id)}'`;
        const rows = await this.queryBanks(filter,
            ['id', 'vector', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata']);
        if (rows.length === 0) {
            throw new Error(`Memory not found: ${id}`);
        }

        const meta = this.rowToParentMeta(this.parseMetadata(rows[0].metadata));

        // Map attachment id -> trimmed new caption (empty string => clear).
        const updates = new Map<string, string | undefined>();
        const knownIds = new Set(meta.attachments.map((a) => a.id));
        for (const update of captions) {
            if (!knownIds.has(update.id)) {
                throw new Error(`Attachment not found on memory ${id}: ${update.id}`);
            }
            const trimmed = update.caption?.trim();
            updates.set(update.id, trimmed ? trimmed : undefined);
        }

        const attachments: StoredAttachment[] = meta.attachments.map((att) => {
            if (!updates.has(att.id)) return att;
            const caption = updates.get(att.id);
            // Rebuild without spreading `att` so an undefined caption clears it.
            return {
                id: att.id,
                kind: att.kind,
                mimeType: att.mimeType,
                byteLength: att.byteLength,
                ...(caption && { caption }),
                blobRef: att.blobRef,
            };
        });

        const newMeta: ParentMeta = { ...meta, attachments, updatedAt: Date.now() };
        const record = this.metaToRecord(newMeta);

        // Rebuild every row reusing its existing vector — NO embedding call.
        const rebuilt: VectorDocument[] = rows.map((row) => {
            const rowId = row.id as string;
            const vector = Array.isArray(row.vector)
                ? (row.vector as number[])
                : Array.from(row.vector as Iterable<number>);
            const isAttachmentRow = rowId.startsWith(`${id}::att::`);
            // Legacy media rows: BM25 text = new caption (resolved by the row's
            // attachment index, stored in startLine) or the title. Chunk rows: preserve the stored chunk text verbatim.
            const content = isAttachmentRow
                ? attachments[Number(row.startLine)]?.caption ?? newMeta.title
                : (row.content as string);
            return {
                id: rowId,
                vector,
                content,
                relativePath: row.relativePath as string,
                startLine: Number(row.startLine) || 0,
                endLine: Number(row.endLine) || 0,
                fileExtension: typeof row.fileExtension === 'string' ? row.fileExtension : '',
                metadata: record,
            };
        });

        try {
            for (const bank of this.banks) {
                const bankRows = rebuilt.filter((_, index) => rows[index].bank === bank);
                if (!bankRows.length) continue;
                await this.db.delete(bank, bankRows.map(row => row.id));
                await this.db.insertHybrid(bank, bankRows);
            }
        } catch (error) {
            // Restore every bank's original metadata if a later bank failed.
            for (const bank of this.banks) {
                const original = rows.filter(row => row.bank === bank).map(row => ({
                    ...row, vector: Array.from(row.vector as Iterable<number>),
                    metadata: this.parseMetadata(row.metadata),
                } as VectorDocument));
                if (!original.length) continue;
                await this.db.delete(bank, original.map(row => row.id));
                await this.db.insertHybrid(bank, original);
            }
            throw error;
        }

        return {
            id,
            title: newMeta.title,
            content: newMeta.fullContent,
            attachments: MemoryStore.toPublicAttachments(attachments),
            createdAt: newMeta.createdAt,
            updatedAt: newMeta.updatedAt,
        };
    }

    /** Fetch a single full memory by id, or null if absent. */
    async get(id: string): Promise<Memory | null> {
        const meta = await this.loadParentMeta(id);
        if (!meta) return null;
        return {
            id,
            title: meta.title,
            content: meta.fullContent,
            attachments: MemoryStore.toPublicAttachments(meta.attachments),
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
        };
    }

    /** Read the raw bytes of one attachment, or null if the memory/blob is gone. */
    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        const meta = await this.loadParentMeta(memoryId);
        if (!meta) return null;
        const att = meta.attachments.find((a) => a.id === attachmentId);
        if (!att) return null;
        try {
            const data = await this.blobStore.get(att.blobRef);
            return {
                mimeType: att.mimeType,
                byteLength: att.byteLength,
                ...(att.caption && { caption: att.caption }),
                data,
            };
        } catch {
            return null;
        }
    }

    /** Load the shared parent metadata for an id from any one of its rows. */
    private async loadParentMeta(id: string): Promise<ParentMeta | null> {
        const filter = `relativePath == '${MemoryStore.escapeLiteral(id)}'`;
        const rows = await this.queryBanks(filter, ['relativePath', 'metadata', 'startLine']);
        if (rows.length === 0) return null;
        return this.rowToParentMeta(this.parseMetadata(rows[0].metadata));
    }

    /** List all memories (sorted by updatedAt desc) for browsing. */
    async list(): Promise<MemorySummary[]> {
        const rows = await this.queryBanks('', ['relativePath', 'metadata']);

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
                preview: this.previewFor(meta),
                attachments: MemoryStore.toPublicAttachments(meta.attachments),
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /**
     * List every parent memory together with ALL of its stored row vectors.
     * Reads straight from LanceDB — no embedding calls — so hygiene clustering
     * can reuse the vectors already computed.
     */
    async listParentsWithVectors(): Promise<ParentVectorData[]> {
        await this.assertNoLegacyRows('check memory hygiene');
        if (!await this.db.hasCollection(this.collectionName)) return [];
        const rows = await this.db.query(this.collectionName, '', ['id', 'vector', 'relativePath', 'metadata'], LIST_FETCH_LIMIT);

        const byParent = new Map<string, ParentVectorData>();
        for (const row of rows) {
            const parentId = row.relativePath as string;
            if (!parentId) continue;
            // Vectors may round-trip as Arrow arrays — coerce like the caption path.
            const vector = Array.isArray(row.vector)
                ? (row.vector as number[])
                : Array.from(row.vector as Iterable<number>);
            const existing = byParent.get(parentId);
            if (existing) {
                existing.vectors.push(vector);
                continue;
            }
            const meta = this.rowToParentMeta(this.parseMetadata(row.metadata));
            byParent.set(parentId, {
                id: parentId,
                title: meta.title,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                fullContent: meta.fullContent,
                vectors: [vector],
            });
        }
        return Array.from(byParent.values());
    }

    /** Delete a memory (all its rows in either index and its blobs). No-op if absent. */
    async delete(id: string): Promise<void> {
        return this.withWriteLock(async () => {
            await this.deleteChunkRows(id);
            await this.blobStore.deleteParent(id);
        });
    }

    /**
     * Move every memory out of the legacy index into the main index. Text
     * chunks are re-embedded with the main embedding; a parent with no text
     * rows (media-only) gets a single title row. Legacy media rows are dropped
     * — the media is no longer searchable — but parent metadata and blobs are
     * kept byte-for-byte, so attachments stay readable. The destination commits
     * before the source rows are deleted and stable row ids make reruns
     * idempotent, including after a failed source delete. Progress counts
     * legacy parents.
     */
    async migrateLegacy(onProgress?: (completed: number, total: number) => void): Promise<void> {
        if (!this.db.withMemoryWriteLock) throw new Error('Migration requires cross-process write locking');
        return this.withWriteLock(() => this.migrateLegacyUnlocked(onProgress));
    }

    private async migrateLegacyUnlocked(onProgress?: (completed: number, total: number) => void): Promise<void> {
        const legacy = this.legacyCollectionName;
        if (!this.db.upsertHybrid) throw new Error('Migration requires atomic vector upsert support');
        if (!legacy || !await this.db.hasCollection(legacy)) {
            onProgress?.(0, 0);
            return;
        }
        // Rows are read in capped pages; a parent split across a page boundary
        // is finished on the next pass because its main-index rows already exist.
        let completed = 0;
        let total = await this.countLegacyMemories();
        onProgress?.(0, total);
        for (;;) {
            const rows = await this.db.query(legacy, '',
                ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'], LIST_FETCH_LIMIT);
            if (rows.length === 0) return;
            const parents = new Map<string, Record<string, any>[]>();
            for (const row of rows) {
                const parentId = row.relativePath as string;
                if (!parentId) continue;
                const parent = parents.get(parentId) ?? [];
                parent.push(row);
                parents.set(parentId, parent);
            }
            if (parents.size === 0) return;
            for (const [parentId, parentRows] of parents) {
                const unique = [...new Map(parentRows.map(row => [row.id as string, row])).values()];
                const textRows = unique.filter(row => !(row.id as string).startsWith(`${parentId}::att::`));
                const metadata = this.parseMetadata(unique[0].metadata);
                const inMain = await this.db.hasCollection(this.collectionName) && (await this.db.query(
                    this.collectionName, `relativePath == '${MemoryStore.escapeLiteral(parentId)}'`, ['id'], 1)).length > 0;
                const toEmbed = textRows.length > 0 || inMain ? textRows : [{
                    id: MemoryStore.chunkRowId(parentId, 0),
                    content: this.rowToParentMeta(metadata).title,
                    relativePath: parentId,
                    startLine: 0,
                    endLine: 1,
                    fileExtension: '',
                    metadata,
                }];
                if (toEmbed.length > 0) {
                    const vectors = await this.embedChunks(toEmbed.map(row => row.content as string));
                    const documents: VectorDocument[] = toEmbed.map((row, index) => ({
                        id: row.id as string,
                        content: row.content as string,
                        vector: vectors[index].vector,
                        relativePath: parentId,
                        startLine: Number(row.startLine),
                        endLine: Number(row.endLine),
                        fileExtension: typeof row.fileExtension === 'string' ? row.fileExtension : '',
                        metadata: this.parseMetadata(row.metadata),
                    }));
                    await this.ensureCollection();
                    await this.db.upsertHybrid(this.collectionName, documents);
                }
                await this.db.delete(legacy, unique.map(row => row.id as string));
                completed += 1;
                total = Math.max(total, completed);
                onProgress?.(completed, total);
            }
        }
    }

    /** Export all memories as portable records (sorted by updatedAt desc). */
    async exportAll(): Promise<MemoryExportRecord[]> {
        const summaries = await this.list();
        const records: MemoryExportRecord[] = [];
        for (const summary of summaries) {
            const meta = await this.loadParentMeta(summary.id);
            if (!meta) continue;
            const attachments = await this.exportAttachments(meta.attachments);
            records.push({
                id: summary.id,
                title: meta.title,
                content: meta.fullContent,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                ...(attachments.length > 0 && { attachments }),
            });
        }
        return records;
    }

    /**
     * Import memories from portable records. Upsert by id (default merge
     * policy, §7.5): an existing id is replaced; a new id is inserted.
     * Re-embeds content via the configured embedding. Media attachments in the
     * records (from exports of earlier releases) are kept as blobs, unembedded.
     * Per-record fault-tolerant: a record that throws is collected into
     * `errors` and the loop continues, so one bad record can't abort a large
     * restore midway.
     */
    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        return this.withWriteLock(() => this.importRecordsUnlocked(records));
    }

    private async importRecordsUnlocked(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        let imported = 0;
        const errors: ImportRecordError[] = [];
        for (let index = 0; index < records.length; index++) {
            const record = records[index];
            const content = record.content ?? '';
            const attachmentsInput: MemoryAttachmentInput[] = Array.isArray(record.attachments)
                ? record.attachments.map((a) => ({
                    ...(typeof a.id === 'string' && a.id.trim().length > 0 && { id: a.id.trim() }),
                    mimeType: a.mimeType,
                    data: a.data,
                    ...(a.caption && { caption: a.caption }),
                }))
                : [];
            if (content.trim().length === 0 && attachmentsInput.length === 0) continue;

            try {
                const id = record.id || MemoryStore.newId();
                const createdAt = Number(record.createdAt) || Date.now();
                const updatedAt = Number(record.updatedAt) || createdAt;
                await this.writeMemory(id, content, record.title, attachmentsInput, createdAt, updatedAt,
                    { preserveMedia: true });
                imported += 1;
            } catch (error) {
                errors.push({
                    index,
                    ...(record.id && { id: record.id }),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return { imported, failed: errors.length, errors };
    }

    /** Read stored attachments back into base64 inputs (for update preserve). */
    private async attachmentsToInput(stored: StoredAttachment[]): Promise<MemoryAttachmentInput[]> {
        const out: MemoryAttachmentInput[] = [];
        for (const att of stored) {
            try {
                const bytes = await this.blobStore.get(att.blobRef);
                out.push({
                    id: att.id,
                    mimeType: att.mimeType,
                    data: bytes.toString('base64'),
                    ...(att.caption && { caption: att.caption }),
                });
            } catch {
                // Blob missing on disk — drop it rather than fail the whole update.
            }
        }
        return out;
    }

    /** Read stored attachments back into portable export records (base64). */
    private async exportAttachments(stored: StoredAttachment[]): Promise<MemoryExportAttachment[]> {
        const out: MemoryExportAttachment[] = [];
        for (const att of stored) {
            try {
                const bytes = await this.blobStore.get(att.blobRef);
                out.push({
                    id: att.id,
                    mimeType: att.mimeType,
                    data: bytes.toString('base64'),
                    ...(att.caption && { caption: att.caption }),
                });
            } catch {
                // Skip an attachment whose blob is missing.
            }
        }
        return out;
    }

    private async deleteChunkRows(parentId: string): Promise<void> {
        const filter = `relativePath == '${MemoryStore.escapeLiteral(parentId)}'`;
        const rows = await this.queryBanks(filter, ['id']);
        for (const bank of this.banks) {
            const ids = rows.filter(row => row.bank === bank).map(row => row.id as string);
            if (ids.length) await this.db.delete(bank, ids);
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

    /** List preview: text excerpt, or an attachment badge for attachment-only memories. */
    private previewFor(meta: ParentMeta): string {
        const text = this.makePreview(meta.fullContent);
        if (text.length > 0) return text;
        if (meta.attachments.length > 0) return MemoryStore.attachmentBadge(meta.attachments);
        return text;
    }

    private static attachmentBadge(attachments: StoredAttachment[]): string {
        const counts = new Map<AttachmentKind, number>();
        for (const att of attachments) {
            counts.set(att.kind, (counts.get(att.kind) ?? 0) + 1);
        }
        const parts = Array.from(counts.entries()).map(([kind, n]) => `${n} ${kind}${n > 1 ? 's' : ''}`);
        return `📎 ${parts.join(', ')}`;
    }

    private makePreview(content: string, length = DEFAULT_PREVIEW_LENGTH): string {
        const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
        if (collapsed.length <= length) return collapsed;
        return collapsed.slice(0, length).trimEnd() + '…';
    }
}
