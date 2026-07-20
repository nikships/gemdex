/**
 * Shared types for the memory-hygiene feature: clustering near-duplicate /
 * superseded / contradicted memories from the vectors already in LanceDB,
 * judging each cluster with a Gemini LLM, and persisting a report a human
 * reviews before any deletion is applied.
 */

import { ModelCostEstimate } from '../ingest/types';

/** The judge's verdict for one memory within a cluster. */
export type HygieneVerdictKind = 'keep' | 'duplicate' | 'superseded' | 'contradicted';

/** How much the judge would stake on a non-keep verdict. */
export type HygieneConfidence = 'high' | 'medium' | 'low';

/** One per-memory verdict produced by the LLM judge. */
export interface HygieneFinding {
    memoryId: string;
    verdict: HygieneVerdictKind;
    /** id of the newer memory that supersedes/contradicts this one */
    supersededBy?: string;
    /** short quoted evidence: the stale claim vs the newer contradicting claim */
    evidence?: string;
    confidence: HygieneConfidence;
}

/** Summary of one memory inside a candidate cluster. */
export interface HygieneClusterMember {
    memoryId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    contentLength: number;
}

/** A group of similar memories found by centroid clustering. */
export interface HygieneCluster {
    /** sha256 of the sorted member ids — stable identity for dismissals */
    clusterId: string;
    members: HygieneClusterMember[];
    /** max pairwise centroid cosine similarity within the cluster */
    similarity: number;
    findings?: HygieneFinding[];
    error?: string;
}

/** Result of a scan: clusters + cost estimates, before any LLM judging. */
export interface HygieneScanResult {
    scannedAt: number;
    threshold: number;
    memoryCount: number;
    /** Dismissed clusters already filtered out. */
    clusters: HygieneCluster[];
    dismissedCount: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimates: ModelCostEstimate[];
}

/** The persisted hygiene report (`~/.gemdex/hygiene.json`). */
export interface HygieneReport {
    version: 1;
    scannedAt: number;
    judgedAt?: number;
    model?: string;
    threshold: number;
    memoryCount: number;
    clusters: HygieneCluster[];
    /** ids deleted via apply(), appended over time */
    deletedIds: string[];
}

/** Live progress for an in-flight (or finished) hygiene judging run. */
export interface HygieneProgress {
    state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
    judged: number;
    failed: number;
    total: number;
    error?: string;
}
