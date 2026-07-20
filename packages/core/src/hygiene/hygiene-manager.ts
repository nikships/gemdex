import type { MemoryBackend } from '../memory/backend';
import type { MemoryStore, ParentVectorData } from '../memory/memory-store';
import { estimateCost, estimateTokensForChars } from '../ingest/digester';
import { DEFAULT_HYGIENE_THRESHOLD, findCandidateClusters } from './candidate-finder';
import { ClusterJudge, JudgeMemberInput, buildJudgePrompt } from './judge';
import { HygieneReportStore } from './hygiene-report';
import {
    HygieneCluster,
    HygieneFinding,
    HygieneProgress,
    HygieneReport,
    HygieneScanResult,
} from './types';

/** Concurrent judge requests during a run. */
const RUN_CONCURRENCY = 4;
/** Retry attempts per cluster. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/** Output budget assumed per cluster for cost estimates. */
export const ESTIMATED_OUTPUT_TOKENS_PER_CLUSTER = 400;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HygieneManagerConfig {
    apiKey: string;
    geminiBaseUrl?: string;
    reportStore?: HygieneReportStore;
    /** Injectable for tests. */
    createJudge?: (model: string | undefined) => ClusterJudge;
}

export interface HygieneRunOptions {
    model?: string;
    threshold?: number;
}

/**
 * Orchestrates memory hygiene: cluster similar memories from the vectors
 * already in LanceDB (zero API calls), judge each cluster with a Gemini LLM
 * for duplicate/superseded/contradicted verdicts, and persist the report at
 * `~/.gemdex/hygiene.json`. Deletion is applied later by a human via
 * {@link apply}; clusters can be permanently dismissed via {@link dismiss}.
 *
 * One run at a time; progress is polled via {@link getProgress}.
 */
export class HygieneManager {
    private readonly config: HygieneManagerConfig;
    private readonly reportStore: HygieneReportStore;
    private progress: HygieneProgress = { state: 'idle', judged: 0, failed: 0, total: 0 };
    private cancelRequested = false;
    private running = false;

    constructor(config: HygieneManagerConfig) {
        this.config = config;
        this.reportStore = config.reportStore ?? new HygieneReportStore();
    }

    getProgress(): HygieneProgress {
        return { ...this.progress };
    }

    /** The persisted report from the last completed run, or null when none exists. */
    getReport(): HygieneReport | null {
        return this.reportStore.getReport() ?? null;
    }

    isRunning(): boolean {
        return this.running;
    }

    cancel(): void {
        this.cancelRequested = true;
    }

    /**
     * Cluster similar memories and estimate the cost of judging them. No LLM
     * calls — clustering runs entirely on the vectors already in LanceDB.
     * Dismissed clusters are filtered out.
     */
    async scan(store: MemoryStore, threshold?: number): Promise<HygieneScanResult> {
        const effectiveThreshold = threshold ?? DEFAULT_HYGIENE_THRESHOLD;
        const parents = await store.listParentsWithVectors();
        const { clusters, dismissedCount } = this.deriveClusters(parents, effectiveThreshold);

        const contentById = new Map(parents.map((p) => [p.id, p]));
        let promptChars = 0;
        for (const cluster of clusters) {
            promptChars += buildJudgePrompt(this.judgeInputs(cluster, contentById)).length;
        }
        const estimatedInputTokens = estimateTokensForChars(promptChars);
        const estimatedOutputTokens = clusters.length * ESTIMATED_OUTPUT_TOKENS_PER_CLUSTER;

        return {
            scannedAt: Date.now(),
            threshold: effectiveThreshold,
            memoryCount: parents.length,
            clusters,
            dismissedCount,
            estimatedInputTokens,
            estimatedOutputTokens,
            estimates: estimateCost(estimatedInputTokens, estimatedOutputTokens),
        };
    }

    /**
     * Judge every candidate cluster with the LLM and persist the findings as
     * a {@link HygieneReport}. Re-derives clusters from the live store so the
     * report reflects current memories. Resolves when the run completes.
     */
    async run(options: HygieneRunOptions, store: MemoryStore): Promise<HygieneProgress> {
        if (this.running) throw new Error('A hygiene run is already in progress.');
        this.running = true;
        this.cancelRequested = false;
        try {
            const threshold = options.threshold ?? DEFAULT_HYGIENE_THRESHOLD;
            const parents = await store.listParentsWithVectors();
            const { clusters } = this.deriveClusters(parents, threshold);
            const contentById = new Map(parents.map((p) => [p.id, p]));

            this.progress = { state: 'running', judged: 0, failed: 0, total: clusters.length };

            const judge = this.createJudge(options.model);
            const scannedAt = Date.now();
            const previousDeleted = this.reportStore.getReport()?.deletedIds ?? [];

            if (clusters.length > 0) {
                const queue = [...clusters];
                const workers = Array.from({ length: Math.min(RUN_CONCURRENCY, queue.length) }, async () => {
                    for (;;) {
                        if (this.cancelRequested) return;
                        const cluster = queue.shift();
                        if (!cluster) return;
                        try {
                            cluster.findings = await this.judgeWithRetry(judge, this.judgeInputs(cluster, contentById));
                            this.progress.judged += 1;
                        } catch (error) {
                            cluster.error = error instanceof Error ? error.message : String(error);
                            this.progress.failed += 1;
                            console.error(`[hygiene] failed to judge cluster ${cluster.clusterId}: ${cluster.error}`);
                        }
                    }
                });
                await Promise.all(workers);
            }

            const report: HygieneReport = {
                version: 1,
                scannedAt,
                judgedAt: Date.now(),
                model: judge.model,
                threshold,
                memoryCount: parents.length,
                clusters,
                deletedIds: previousDeleted,
            };
            this.reportStore.setReport(report);

            this.progress.state = this.cancelRequested ? 'cancelled' : 'done';
            return this.getProgress();
        } catch (error) {
            this.progress = {
                ...this.progress,
                state: 'failed',
                error: error instanceof Error ? error.message : String(error),
            };
            throw error;
        } finally {
            this.running = false;
        }
    }

    /**
     * Delete the given memory ids via the backend (sequentially) and record
     * them in the report. Successful deletions are recorded even when a later
     * one fails; the failure is then rethrown.
     */
    async apply(ids: string[], backend: MemoryBackend): Promise<{ deleted: number }> {
        const deleted: string[] = [];
        try {
            for (const id of ids) {
                await backend.delete(id);
                deleted.push(id);
            }
        } catch (error) {
            this.reportStore.recordDeleted(deleted);
            throw error;
        }
        this.reportStore.recordDeleted(deleted);
        return { deleted: deleted.length };
    }

    /** Permanently dismiss clusters (by stable cluster id) and prune them from the stored report. */
    dismiss(clusterIds: string[]): void {
        this.reportStore.addDismissed(clusterIds);
    }

    private deriveClusters(
        parents: ParentVectorData[],
        threshold: number,
    ): { clusters: HygieneCluster[]; dismissedCount: number } {
        const all = findCandidateClusters(parents, threshold);
        const dismissed = this.reportStore.getDismissed();
        const clusters = all.filter((c) => !dismissed.has(c.clusterId));
        return { clusters, dismissedCount: all.length - clusters.length };
    }

    private judgeInputs(
        cluster: HygieneCluster,
        contentById: Map<string, ParentVectorData>,
    ): JudgeMemberInput[] {
        return cluster.members.map((member) => ({
            memoryId: member.memoryId,
            title: member.title,
            createdAt: member.createdAt,
            updatedAt: member.updatedAt,
            content: contentById.get(member.memoryId)?.fullContent ?? '',
        }));
    }

    private createJudge(model: string | undefined): ClusterJudge {
        if (this.config.createJudge) return this.config.createJudge(model);
        return new ClusterJudge({
            apiKey: this.config.apiKey,
            model,
            baseURL: this.config.geminiBaseUrl,
        });
    }

    private async judgeWithRetry(judge: ClusterJudge, members: JudgeMemberInput[]): Promise<HygieneFinding[]> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (this.cancelRequested) {
                throw new Error('Hygiene run cancelled');
            }
            try {
                return await judge.judge(members);
            } catch (error) {
                lastError = error;
                if (attempt < MAX_ATTEMPTS && !this.cancelRequested) {
                    await sleep(RETRY_BASE_DELAY_MS * attempt);
                }
            }
        }
        throw lastError;
    }
}
