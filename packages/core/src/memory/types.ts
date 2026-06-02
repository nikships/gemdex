import { HybridSubScores } from '../vectordb';

/**
 * A stored memory as seen by callers (MCP tools, the desktop sidecar).
 * Only `content` and `title` are user-facing; the rest is system metadata
 * that is never used for ranking.
 */
export interface Memory {
    id: string;
    title: string;
    content: string;
    /** Epoch milliseconds. */
    createdAt: number;
    /** Epoch milliseconds. */
    updatedAt: number;
}

/** Lightweight memory shape for list/browse views (content truncated). */
export interface MemorySummary {
    id: string;
    title: string;
    preview: string;
    createdAt: number;
    updatedAt: number;
}

/** A recall hit: a full parent memory plus its fused relevance score. */
export interface MemoryRecallResult extends Memory {
    score: number;
    /** Per-branch (dense/BM25) rank breakdown from hybrid search, when available. */
    subScores?: HybridSubScores;
}

export interface SaveMemoryInput {
    content: string;
    title?: string;
}

export interface UpdateMemoryInput {
    content: string;
    title?: string;
}

/** Record shape used for export/import (§7.5). */
export interface MemoryExportRecord {
    id: string;
    title: string;
    content: string;
    createdAt: number;
    updatedAt: number;
}
