import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import {
    AttachmentBytes,
    AttachmentCaptionUpdate,
    chunkMemory,
    DEFAULT_ATTACHMENT_LIMITS,
    deriveTitle,
    Memory,
    MemoryAttachment,
    MemoryAttachmentInput,
    MemoryBackend,
    MemoryExportRecord,
    MemoryRecallResult,
    MemorySummary,
    SaveMemoryInput,
    UpdateMemoryInput,
    validateAttachments,
} from 'gemdex-core';
import { MIGRATIONS, SqlMigration } from './postgres-migrations.js';

export interface Queryable {
    query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DatabasePool extends Queryable {
    connect(): Promise<DatabaseClient>;
    end(): Promise<void>;
}

export interface DatabaseClient extends Queryable {
    release(): void;
}

export interface PostgresMemoryBackendOptions {
    pool: DatabasePool;
}

interface DocumentRow extends QueryResultRow {
    id: string;
    title: string;
    content: string;
    created_at: Date | string | number;
    updated_at: Date | string | number;
}

interface AttachmentRow extends QueryResultRow {
    id: string;
    kind: MemoryAttachment['kind'];
    mime_type: string;
    byte_length: number;
    caption: string | null;
}

interface AttachmentExportRow extends AttachmentRow {
    data: Buffer | Uint8Array | string | null;
}

interface StoredAttachmentInput extends MemoryAttachmentInput {
    id?: string;
}

interface PreparedAttachment {
    id: string;
    ordinal: number;
    kind: MemoryAttachment['kind'];
    mimeType: string;
    byteLength: number;
    data: Buffer;
    caption?: string;
}

export class MigrationError extends Error {
    constructor(public readonly version: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Migration ${version} failed: ${detail}`);
        this.name = 'MigrationError';
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

function checksum(sql: string): string {
    return createHash('sha256').update(sql).digest('hex');
}

export async function migrateDatabase(pool: DatabasePool, migrations: SqlMigration[] = MIGRATIONS): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
CREATE TABLE IF NOT EXISTS gemdex_schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

        for (const migration of migrations) {
            const sum = checksum(migration.sql);
            const existing = await client.query<{ checksum: string }>(
                'SELECT checksum FROM gemdex_schema_migrations WHERE version = $1',
                [migration.version],
            );
            if (existing.rows.length > 0) {
                if (existing.rows[0].checksum !== sum) {
                    throw new Error(
                        `Migration ${migration.version} checksum mismatch. ` +
                        'Refusing to continue; restore from backup or reconcile migration history.',
                    );
                }
                continue;
            }

            try {
                await client.query(migration.sql);
                await client.query(
                    'INSERT INTO gemdex_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
                    [migration.version, migration.name, sum],
                );
            } catch (error) {
                throw new MigrationError(migration.version, error);
            }
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export function createPostgresPool(config: PoolConfig | string): DatabasePool {
    return new Pool(typeof config === 'string' ? { connectionString: config } : config) as DatabasePool;
}

function timestampToMs(value: Date | string | number): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    return new Date(value).getTime();
}

function toDate(ms: number): Date {
    return new Date(ms);
}

function bytesFromDatabase(value: Buffer | Uint8Array | string | null): Buffer {
    if (value === null) return Buffer.alloc(0);
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
    return Buffer.from(value, 'base64');
}

/**
 * Build a comma-separated list of positional placeholders ($1, $2, ...) for an
 * `IN (...)` clause. We expand to scalar placeholders rather than `= ANY($1)`
 * with an array param: the array form is unsupported by the pg-mem engine used
 * in tests (it silently matches nothing), while expanded placeholders behave
 * identically on real Postgres and pg-mem.
 */
function inPlaceholders(count: number, start = 1): string {
    return Array.from({ length: count }, (_, index) => `$${start + index}`).join(', ');
}

async function loadAttachments(db: Queryable, memoryId: string): Promise<MemoryAttachment[]> {
    const result = await db.query<AttachmentRow>(
        `SELECT id, kind, mime_type, byte_length, caption
         FROM gemdex_memory_attachments
         WHERE memory_id = $1
         ORDER BY ordinal ASC`,
        [memoryId],
    );
    return result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        mimeType: row.mime_type,
        byteLength: Number(row.byte_length),
        ...(row.caption ? { caption: row.caption } : {}),
    }));
}

function attachmentTitle(attachments: PreparedAttachment[]): string {
    const captioned = attachments.find((a) => a.caption && a.caption.trim().length > 0);
    if (captioned?.caption) return deriveTitle(captioned.caption);
    if (attachments.length === 1) return `${attachments[0].kind} attachment`;
    return `${attachments.length} attachments`;
}

function resolveTitle(explicit: string | undefined, content: string, attachments: PreparedAttachment[]): string {
    const trimmed = explicit?.trim();
    if (trimmed) return trimmed;
    if (content.trim().length > 0) return deriveTitle(content);
    if (attachments.length > 0) return attachmentTitle(attachments);
    return deriveTitle(content);
}

export class PostgresMemoryBackend implements MemoryBackend {
    private pool: DatabasePool;

    constructor(options: PostgresMemoryBackendOptions) {
        this.pool = options.pool;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    async save(input: SaveMemoryInput): Promise<Memory> {
        const id = randomUUID();
        const now = Date.now();
        return this.writeMemory(id, input.content ?? '', input.title, input.attachments ?? [], now, now);
    }

    async recall(
        query?: string,
        limit?: number,
        queryAttachments?: MemoryAttachmentInput[],
    ): Promise<MemoryRecallResult[]> {
        if ((queryAttachments?.length ?? 0) > 0) {
            throw new Error('Postgres recall-by-media requires the pgvector/BM25 recall backend from GEM-11.');
        }
        const trimmed = (query ?? '').trim();
        if (trimmed.length === 0) return [];
        const max = Math.max(1, Math.min(limit ?? 10, 50));
        const result = await this.pool.query<DocumentRow>(
            `SELECT DISTINCT d.id, d.title, d.content, d.created_at, d.updated_at
             FROM gemdex_memory_documents d
             JOIN gemdex_memory_chunks c ON c.memory_id = d.id
             WHERE c.content ILIKE $1 OR d.title ILIKE $1
             ORDER BY d.id ASC
             LIMIT $2`,
            [`%${trimmed}%`, max],
        );
        const memories = await this.rowsToMemories(result.rows);
        return memories.map((memory) => ({ ...memory, score: 1 }));
    }

    async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
        const existing = await this.get(id);
        if (!existing) throw new Error(`Memory ${id} not found`);
        const content = input.content ?? existing.content;
        const title = input.title ?? existing.title;
        const attachments = input.attachments !== undefined
            ? input.attachments
            : await this.exportAttachmentsAsInputs(id);
        return this.writeMemory(id, content, title, attachments, existing.createdAt, Date.now());
    }

    async updateAttachmentCaptions(id: string, captions: AttachmentCaptionUpdate[]): Promise<Memory> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const exists = await client.query('SELECT id FROM gemdex_memory_documents WHERE id = $1', [id]);
            if (exists.rows.length === 0) throw new Error(`Memory ${id} not found`);

            for (const item of captions) {
                const caption = item.caption?.trim();
                const updated = await client.query(
                    `UPDATE gemdex_memory_attachments
                     SET caption = $3, updated_at = $4
                     WHERE memory_id = $1 AND id = $2`,
                    [id, item.id, caption && caption.length > 0 ? caption : null, new Date()],
                );
                if (updated.rowCount === 0) throw new Error(`Attachment ${item.id} not found`);
            }

            await this.rebuildAttachmentChunks(client, id);
            await client.query('COMMIT');
            const memory = await this.get(id);
            if (!memory) throw new Error(`Memory ${id} not found`);
            return memory;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async get(id: string): Promise<Memory | null> {
        const result = await this.pool.query<DocumentRow>(
            'SELECT id, title, content, created_at, updated_at FROM gemdex_memory_documents WHERE id = $1',
            [id],
        );
        if (result.rows.length === 0) return null;
        return this.rowToMemory(result.rows[0]);
    }

    async list(): Promise<MemorySummary[]> {
        const result = await this.pool.query<DocumentRow>(
            `SELECT id, title, content, created_at, updated_at
             FROM gemdex_memory_documents
             ORDER BY updated_at DESC, id ASC`,
        );
        const memories = await this.rowsToMemories(result.rows);
        return memories.map((memory) => ({
            id: memory.id,
            title: memory.title,
            preview: memory.content.slice(0, 100),
            attachments: memory.attachments,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
        }));
    }

    async delete(id: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const oldBlobs = await client.query<{ blob_ref_id: string }>(
                'SELECT blob_ref_id FROM gemdex_memory_attachments WHERE memory_id = $1',
                [id],
            );
            await client.query('DELETE FROM gemdex_memory_documents WHERE id = $1', [id]);
            if (oldBlobs.rows.length > 0) {
                const blobIds = oldBlobs.rows.map((oldBlob) => oldBlob.blob_ref_id);
                await client.query(`DELETE FROM gemdex_attachment_blobs WHERE id IN (${inPlaceholders(blobIds.length)})`, blobIds);
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async exportAll(): Promise<MemoryExportRecord[]> {
        const result = await this.pool.query<DocumentRow>(
            `SELECT id, title, content, created_at, updated_at
             FROM gemdex_memory_documents
             ORDER BY updated_at DESC, id ASC`,
        );
        return Promise.all(result.rows.map(async (row) => ({
            id: row.id,
            title: row.title,
            content: row.content,
            createdAt: timestampToMs(row.created_at),
            updatedAt: timestampToMs(row.updated_at),
            ...await this.exportAttachmentsRecord(row.id),
        })));
    }

    async importRecords(records: MemoryExportRecord[]): Promise<{ imported: number }> {
        let imported = 0;
        for (const record of records) {
            const content = record.content ?? '';
            const attachments = Array.isArray(record.attachments)
                ? record.attachments.map((attachment) => ({
                    id: attachment.id,
                    mimeType: attachment.mimeType,
                    data: attachment.data,
                    ...(attachment.caption !== undefined && { caption: attachment.caption }),
                }))
                : [];
            if (content.trim().length === 0 && attachments.length === 0) continue;
            const id = record.id || randomUUID();
            await this.writeMemory(
                id,
                content,
                record.title,
                attachments,
                Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
                Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
            );
            imported += 1;
        }
        return { imported };
    }

    async readAttachment(memoryId: string, attachmentId: string): Promise<AttachmentBytes | null> {
        const result = await this.pool.query<AttachmentExportRow>(
            `SELECT a.mime_type, a.byte_length, a.caption, b.data
             FROM gemdex_memory_attachments a
             JOIN gemdex_attachment_blobs b ON b.id = a.blob_ref_id
             WHERE a.memory_id = $1 AND a.id = $2`,
            [memoryId, attachmentId],
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        return {
            mimeType: row.mime_type,
            byteLength: Number(row.byte_length),
            ...(row.caption ? { caption: row.caption } : {}),
            data: bytesFromDatabase(row.data),
        };
    }

    private async writeMemory(
        id: string,
        content: string,
        explicitTitle: string | undefined,
        attachmentsInput: StoredAttachmentInput[],
        createdAt: number,
        updatedAt: number,
    ): Promise<Memory> {
        const text = content ?? '';
        const validated = await validateAttachments(attachmentsInput, DEFAULT_ATTACHMENT_LIMITS);
        if (text.trim().length === 0 && validated.length === 0) {
            throw new Error('Cannot persist an empty memory (no content and no attachments)');
        }

        const prepared: PreparedAttachment[] = validated.map((attachment, index) => ({
            id: attachmentsInput[index].id ?? String(index),
            ordinal: index,
            kind: attachment.kind,
            mimeType: attachment.mimeType,
            byteLength: attachment.byteLength,
            data: attachment.bytes,
            ...(attachment.caption && { caption: attachment.caption }),
        }));
        const title = resolveTitle(explicitTitle, text, prepared);
        const chunks = text.trim().length > 0 ? chunkMemory(text) : [];
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');
            const oldBlobs = await client.query<{ blob_ref_id: string }>(
                'SELECT blob_ref_id FROM gemdex_memory_attachments WHERE memory_id = $1',
                [id],
            );
            await client.query('DELETE FROM gemdex_memory_documents WHERE id = $1', [id]);
            if (oldBlobs.rows.length > 0) {
                const blobIds = oldBlobs.rows.map((oldBlob) => oldBlob.blob_ref_id);
                await client.query(`DELETE FROM gemdex_attachment_blobs WHERE id IN (${inPlaceholders(blobIds.length)})`, blobIds);
            }
            await client.query(
                `INSERT INTO gemdex_memory_documents (id, title, content, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, title, text, toDate(createdAt), toDate(updatedAt)],
            );

            for (let i = 0; i < chunks.length; i++) {
                await client.query(
                    `INSERT INTO gemdex_memory_chunks
                        (id, memory_id, chunk_index, chunk_kind, content, start_offset, end_offset, created_at, updated_at)
                     VALUES ($1, $2, $3, 'text', $4, NULL, NULL, $5, $6)`,
                    [randomUUID(), id, i, chunks[i], toDate(createdAt), toDate(updatedAt)],
                );
            }

            for (const attachment of prepared) {
                const blobId = randomUUID();
                const storageKey = `${id}/${attachment.id}`;
                const hash = createHash('sha256').update(attachment.data).digest('hex');
                await client.query(
                    `INSERT INTO gemdex_attachment_blobs (id, storage_key, sha256, byte_length, data)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [blobId, storageKey, hash, attachment.byteLength, attachment.data],
                );
                await client.query(
                    `INSERT INTO gemdex_memory_attachments
                        (memory_id, id, ordinal, kind, mime_type, byte_length, caption, blob_ref_id, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        id,
                        attachment.id,
                        attachment.ordinal,
                        attachment.kind,
                        attachment.mimeType,
                        attachment.byteLength,
                        attachment.caption ?? null,
                        blobId,
                        toDate(createdAt),
                        toDate(updatedAt),
                    ],
                );
            }
            await this.rebuildAttachmentChunks(client, id);

            await client.query('COMMIT');
            const memory = await this.get(id);
            if (!memory) throw new Error(`Memory ${id} not found after write`);
            return memory;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async rebuildAttachmentChunks(db: Queryable, id: string): Promise<void> {
        await db.query('DELETE FROM gemdex_memory_chunks WHERE memory_id = $1 AND chunk_kind = $2', [id, 'attachment']);
        const result = await db.query<AttachmentRow>(
            `SELECT id, kind, mime_type, byte_length, caption
             FROM gemdex_memory_attachments
             WHERE memory_id = $1
             ORDER BY ordinal ASC`,
            [id],
        );
        const doc = await db.query<DocumentRow>(
            'SELECT title, created_at, updated_at FROM gemdex_memory_documents WHERE id = $1',
            [id],
        );
        const title = doc.rows[0]?.title ?? '';
        const createdAt = doc.rows[0]?.created_at ?? new Date();
        const updatedAt = doc.rows[0]?.updated_at ?? new Date();
        for (let i = 0; i < result.rows.length; i++) {
            const attachment = result.rows[i];
            const text = attachment.caption?.trim() || title || `${attachment.kind} attachment`;
            await db.query(
                `INSERT INTO gemdex_memory_chunks
                    (id, memory_id, attachment_id, chunk_index, chunk_kind, content, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'attachment', $5, $6, $7)`,
                [randomUUID(), id, attachment.id, i, text, createdAt, updatedAt],
            );
        }
    }

    private async rowToMemory(row: DocumentRow): Promise<Memory> {
        return {
            id: row.id,
            title: row.title,
            content: row.content,
            attachments: await loadAttachments(this.pool, row.id),
            createdAt: timestampToMs(row.created_at),
            updatedAt: timestampToMs(row.updated_at),
        };
    }

    /**
     * Batch-load attachments for many documents in a single query, then map
     * each row to a Memory. Avoids the N+1 query pattern that arises when
     * list()/recall() call rowToMemory() (one attachment query per row) in a
     * loop.
     */
    private async rowsToMemories(rows: DocumentRow[]): Promise<Memory[]> {
        if (rows.length === 0) return [];
        const ids = rows.map((row) => row.id);
        const attachmentResult = await this.pool.query<AttachmentRow & { memory_id: string }>(
            `SELECT memory_id, id, kind, mime_type, byte_length, caption
             FROM gemdex_memory_attachments
             WHERE memory_id IN (${inPlaceholders(ids.length)})
             ORDER BY memory_id, ordinal ASC`,
            ids,
        );
        const attachmentsByMemoryId = new Map<string, MemoryAttachment[]>();
        for (const row of attachmentResult.rows) {
            const list = attachmentsByMemoryId.get(row.memory_id) ?? [];
            list.push({
                id: row.id,
                kind: row.kind,
                mimeType: row.mime_type,
                byteLength: Number(row.byte_length),
                ...(row.caption ? { caption: row.caption } : {}),
            });
            attachmentsByMemoryId.set(row.memory_id, list);
        }
        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            content: row.content,
            attachments: attachmentsByMemoryId.get(row.id) ?? [],
            createdAt: timestampToMs(row.created_at),
            updatedAt: timestampToMs(row.updated_at),
        }));
    }

    private async exportAttachmentsRecord(id: string): Promise<{ attachments?: MemoryExportRecord['attachments'] }> {
        const rows = await this.exportAttachmentRows(id);
        if (rows.length === 0) return {};
        return {
            attachments: rows.map((row) => ({
                id: row.id,
                mimeType: row.mime_type,
                data: bytesFromDatabase(row.data).toString('base64'),
                ...(row.caption ? { caption: row.caption } : {}),
            })),
        };
    }

    private async exportAttachmentsAsInputs(id: string): Promise<StoredAttachmentInput[]> {
        const rows = await this.exportAttachmentRows(id);
        return rows.map((row) => ({
            id: row.id,
            mimeType: row.mime_type,
            data: bytesFromDatabase(row.data).toString('base64'),
            ...(row.caption ? { caption: row.caption } : {}),
        }));
    }

    private async exportAttachmentRows(id: string): Promise<AttachmentExportRow[]> {
        const result = await this.pool.query<AttachmentExportRow>(
            `SELECT a.id, a.kind, a.mime_type, a.byte_length, a.caption, b.data
             FROM gemdex_memory_attachments a
             JOIN gemdex_attachment_blobs b ON b.id = a.blob_ref_id
             WHERE a.memory_id = $1
             ORDER BY a.ordinal ASC`,
            [id],
        );
        return result.rows;
    }
}
