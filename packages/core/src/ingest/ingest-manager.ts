import * as crypto from 'node:crypto';
import { estimateCost, estimateTokensForChars } from '../inference/claude-code';
import type { MemoryExportRecord } from '../memory/types';
import {
    ClaudeCodeDigester,
    Digester,
    buildDigestPrompt,
    memoryIdForSession,
    renderDigestMemory,
    ESTIMATED_OUTPUT_TOKENS_PER_SESSION,
} from './digester';
import { IngestLedgerStore } from './ingest-ledger';
import { bucketSessionFiles, discoverSessionFiles } from './session-scanner';
import {
    attachTranscriptToRecord,
    readTranscriptAttachment,
    TRANSCRIPT_ATTACHMENT_CAPTION,
} from './transcript-attachment';
import { parseSessionFile } from './transcript-parser';
import {
    IngestLedgerEntry,
    IngestProgress,
    IngestScanResult,
    IngestScanTotals,
    IngestSourceFolder,
    IngestTarget,
    ParsedSession,
    SessionDigest,
    SessionFile,
    SessionMeta,
} from './types';

export interface IngestRunOptions {
    folders: IngestSourceFolder[];
    model?: string;
}

export interface IngestManagerConfig {
    ledger?: IngestLedgerStore;
    /** Injectable for tests. Defaults to a Claude Code {@link ClaudeCodeDigester}. */
    createDigester?: (model: string | undefined) => Digester;
}

/** Concurrent digest requests (each is one `claude -p` child process). */
const CONCURRENCY = 4;
/** Retry attempts per session. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingSession {
    file: SessionFile;
    session: ParsedSession;
    promptHash: string;
}

/** Hash of the digest prompt: the exact input the LLM digest depends on. */
function hashDigestPrompt(prompt: string): string {
    return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/** What a saved digest needs to know about the session file it came from. */
interface DigestSource {
    filePath: string;
    mtimeMs: number;
    size: number;
    promptHash: string;
    sessionMeta: SessionMeta;
}

/**
 * Orchestrates chat-history ingestion: scan source folders against the
 * ledger, digest each pending session through the local Claude Code CLI,
 * and upsert one memory per session into the destination IngestTarget with the
 * deterministic id `chat:<source>:<sessionId>`.
 *
 * One run at a time; progress is polled via {@link getProgress}.
 */
export class IngestManager {
    private readonly config: IngestManagerConfig;
    private readonly ledger: IngestLedgerStore;
    private progress: IngestProgress = { state: 'idle', processed: 0, failed: 0, skipped: 0, total: 0 };
    private cancelRequested = false;
    private running = false;

    constructor(config: IngestManagerConfig = {}) {
        this.config = config;
        this.ledger = config.ledger ?? new IngestLedgerStore();
    }

    getProgress(): IngestProgress {
        return { ...this.progress };
    }

    isRunning(): boolean {
        return this.running;
    }

    cancel(): void {
        this.cancelRequested = true;
    }

    /**
     * Scan source folders, bucket against the ledger, and estimate the cost of
     * never-before-ingested sessions. Changed sessions are reported for
     * transparency but are never processable. Files flagged as changed whose
     * digest prompt hash matches the ledger (mtime/size churn without content
     * changes) are reconciled back into `upToDate` and refreshed.
     */
    scan(folders: IngestSourceFolder[]): IngestScanResult {
        const files = discoverSessionFiles(folders);
        const buckets = bucketSessionFiles(files, this.ledger);
        const ledgerEntries = this.ledger.load().files;
        const refreshedEntries: Record<string, IngestLedgerEntry> = {};

        let newChars = 0;
        const processableFiles: SessionFile[] = [];
        const skippedTrivialFiles: SessionFile[] = [];

        for (const file of buckets.newFiles) {
            const session = this.tryParse(file);
            if (!session) {
                skippedTrivialFiles.push(file);
                continue;
            }
            processableFiles.push(file);
            newChars += buildDigestPrompt(session).length;
        }

        const stillChanged: SessionFile[] = [];
        for (const file of buckets.changedFiles) {
            const session = this.tryParse(file);
            if (!session) {
                stillChanged.push(file);
                continue;
            }
            const prompt = buildDigestPrompt(session);
            const entry = ledgerEntries[file.filePath];
            if (entry?.promptHash !== undefined && entry.promptHash === hashDigestPrompt(prompt)) {
                // The file was touched on disk, but the content the digest
                // depends on is unchanged — self-heal the ledger and move on.
                buckets.upToDate.push(file);
                refreshedEntries[file.filePath] = { ...entry, mtimeMs: file.mtimeMs, size: file.size };
                continue;
            }
            stillChanged.push(file);
        }
        buckets.changedFiles = stillChanged;
        this.ledger.updateEntries(refreshedEntries);

        const totalsFor = (count: number, chars: number): IngestScanTotals => {
            const estimatedInputTokens = estimateTokensForChars(chars);
            const estimatedOutputTokens = count * ESTIMATED_OUTPUT_TOKENS_PER_SESSION;
            return {
                pendingCount: count,
                estimatedInputTokens,
                estimatedOutputTokens,
                estimates: estimateCost(estimatedInputTokens, estimatedOutputTokens),
            };
        };
        return {
            buckets,
            processableFiles,
            skippedTrivialFiles,
            ...totalsFor(processableFiles.length, newChars),
        };
    }

    /** Run ingestion over the pending files in `folders`; resolves when the run completes. */
    async run(options: IngestRunOptions, backend: IngestTarget): Promise<IngestProgress> {
        if (this.running) throw new Error('An ingestion run is already in progress.');
        this.running = true;
        this.cancelRequested = false;
        try {
            const files = discoverSessionFiles(options.folders);
            const buckets = bucketSessionFiles(files, this.ledger);
            // Permanently new-sessions-only: only ledger-absent files are eligible.
            // Prompt-hash reconciliation for mtime churn lives in scan(), not here.
            const pendingFiles = [...buckets.newFiles];

            const sessions: PendingSession[] = [];
            let skipped = 0;
            for (const file of pendingFiles) {
                const session = this.tryParse(file);
                if (!session) {
                    skipped += 1;
                    continue;
                }
                const promptHash = hashDigestPrompt(buildDigestPrompt(session));
                sessions.push({ file, session, promptHash });
            }

            this.progress = {
                state: 'running',
                processed: 0,
                failed: 0,
                skipped,
                total: sessions.length,
            };

            if (sessions.length === 0) {
                this.progress.state = 'done';
                return this.getProgress();
            }

            await this.digestAll(sessions, options.model, backend);
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

    private createDigester(model: string | undefined): Digester {
        if (this.config.createDigester) return this.config.createDigester(model);
        return new ClaudeCodeDigester({ model });
    }

    private tryParse(file: SessionFile): ParsedSession | null {
        try {
            return parseSessionFile(file.filePath, file.source);
        } catch {
            return null;
        }
    }

    private async digestAll(
        sessions: PendingSession[],
        model: string | undefined,
        backend: IngestTarget,
    ): Promise<void> {
        const digester = this.createDigester(model);
        const queue = [...sessions];
        const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
            for (;;) {
                if (this.cancelRequested) return;
                const item = queue.shift();
                if (!item) return;
                this.progress.currentFile = item.file.filePath;
                try {
                    const digest = await this.digestWithRetry(digester, item.session);
                    await this.saveDigest(digest, {
                        filePath: item.file.filePath,
                        mtimeMs: item.file.mtimeMs,
                        size: item.file.size,
                        promptHash: item.promptHash,
                        sessionMeta: toSessionMeta(item.session),
                    }, backend, digester.model);
                    this.progress.processed += 1;
                } catch (error) {
                    this.progress.failed += 1;
                    console.error(
                        `[ingest] failed to digest ${item.file.filePath}: ` +
                        (error instanceof Error ? error.message : String(error)),
                    );
                }
            }
        });
        await Promise.all(workers);
        delete this.progress.currentFile;
        this.progress.state = this.cancelRequested ? 'cancelled' : 'done';
    }

    private async digestWithRetry(digester: Digester, session: ParsedSession): Promise<SessionDigest> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (this.cancelRequested) {
                throw new Error('Ingestion cancelled');
            }
            try {
                return await digester.digest(session);
            } catch (error) {
                lastError = error;
                if (attempt < MAX_ATTEMPTS && !this.cancelRequested) {
                    await sleep(RETRY_BASE_DELAY_MS * attempt);
                }
            }
        }
        throw lastError;
    }

    private async saveDigest(
        digest: SessionDigest,
        request: DigestSource,
        backend: IngestTarget,
        model: string,
    ): Promise<void> {
        const meta = request.sessionMeta;
        const memoryId = memoryIdForSession(meta);
        const now = Date.now();
        const content = renderDigestMemory(digest, meta);
        // Digest text stays searchable/embeddable; full transcript is a
        // non-embedded blob attachment so hybrid search is not polluted.
        // Cleaned plain-text transcript (no JSONL wire bloat / thinking / signatures).
        const transcript = readTranscriptAttachment(meta.filePath, {
            caption: TRANSCRIPT_ATTACHMENT_CAPTION,
            source: meta.source,
        });
        let record: MemoryExportRecord = {
            id: memoryId,
            title: digest.title,
            content,
            createdAt: meta.firstTs ?? now,
            updatedAt: meta.lastTs ?? now,
            ...(transcript ? { attachments: [transcript] } : {}),
        };
        // If the explicit path failed, still try the content footer (same path).
        if (!transcript) {
            const attached = attachTranscriptToRecord(record, {
                filePath: meta.filePath,
                force: true,
                source: meta.source,
            });
            record = attached.record;
            if (attached.status === 'missing') {
                console.error(
                    `[ingest] transcript file missing or empty after clean for ${memoryId}: ${meta.filePath}`,
                );
            }
        }
        const result = await backend.importRecords([record]);
        if (result.imported !== 1) {
            const detail = result.errors[0]?.error;
            throw new Error(`Backend did not import digest for ${meta.filePath}${detail ? `: ${detail}` : ''}`);
        }
        this.ledger.recordIngested(request.filePath, {
            mtimeMs: request.mtimeMs,
            size: request.size,
            memoryId,
            model,
            ingestedAt: now,
            promptHash: request.promptHash,
        });
    }
}

function toSessionMeta(session: ParsedSession) {
    const { turns: _turns, ...meta } = session;
    return meta;
}
