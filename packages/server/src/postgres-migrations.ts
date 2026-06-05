export interface SqlMigration {
    version: string;
    name: string;
    sql: string;
}

export const MIGRATIONS: SqlMigration[] = [
    {
        version: '001',
        name: 'initial_remote_memories',
        sql: `
CREATE TABLE IF NOT EXISTS gemdex_schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gemdex_memory_documents (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS gemdex_attachment_blobs (
    id UUID PRIMARY KEY,
    storage_provider TEXT NOT NULL DEFAULT 'postgres',
    storage_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS gemdex_memory_attachments (
    memory_id UUID NOT NULL REFERENCES gemdex_memory_documents(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'pdf')),
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    caption TEXT,
    blob_ref_id UUID NOT NULL REFERENCES gemdex_attachment_blobs(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (memory_id, id),
    UNIQUE (memory_id, ordinal),
    UNIQUE (blob_ref_id)
);

CREATE TABLE IF NOT EXISTS gemdex_memory_chunks (
    id UUID PRIMARY KEY,
    memory_id UUID NOT NULL REFERENCES gemdex_memory_documents(id) ON DELETE CASCADE,
    attachment_id TEXT,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_kind TEXT NOT NULL CHECK (chunk_kind IN ('text', 'attachment')),
    content TEXT NOT NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    embedding DOUBLE PRECISION[],
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    FOREIGN KEY (memory_id, attachment_id) REFERENCES gemdex_memory_attachments(memory_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS gemdex_memory_chunks_unique_text_idx
    ON gemdex_memory_chunks (memory_id, chunk_kind, chunk_index)
    WHERE attachment_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS gemdex_memory_chunks_unique_attachment_idx
    ON gemdex_memory_chunks (memory_id, attachment_id)
    WHERE attachment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS gemdex_memory_documents_updated_idx
    ON gemdex_memory_documents (updated_at DESC, id);

CREATE INDEX IF NOT EXISTS gemdex_memory_chunks_memory_idx
    ON gemdex_memory_chunks (memory_id);

CREATE INDEX IF NOT EXISTS gemdex_memory_attachments_memory_idx
    ON gemdex_memory_attachments (memory_id, ordinal);
`,
    },
];
