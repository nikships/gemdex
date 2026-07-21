import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { envManager } from '../utils/env-manager';

/** How a recalled memory's advice actually played out, self-reported by the agent. */
export type MemoryOutcome = 'worked' | 'failed' | 'stale';

/** Longest a `report_outcome` note is allowed to be once trimmed. */
const MAX_NOTE_LENGTH = 500;

/** Per-memory tally the outcome feedback loop maintains, keyed by memory id. */
export interface MemoryStats {
    /** Times this memory has been surfaced in a `recall` result. */
    recallCount: number;
    /** Epoch ms of the most recent `recall` that surfaced this memory. */
    lastRecalledAt?: number;
    workedCount: number;
    failedCount: number;
    staleCount: number;
    lastOutcome?: { outcome: MemoryOutcome; at: number; note?: string };
}

/** The on-disk stats file shape (`~/.gemdex/stats.json` by default). */
interface StatsFile {
    version: 1;
    memories: Record<string, MemoryStats>;
}

function emptyStats(): MemoryStats {
    return { recallCount: 0, workedCount: 0, failedCount: 0, staleCount: 0 };
}

/**
 * Client-side outcome-feedback ledger: how often each memory gets surfaced by
 * `recall`, and how the agent says it actually went (`worked` / `failed` /
 * `stale`). Lives outside LanceDB entirely — see the module-level design note
 * in the MCP layer's `report_outcome` handler for why. Stats are per-client in
 * v1 (this machine's experience with this memory), stored at
 * `~/.gemdex/stats.json` by default, overridable via `GEMDEX_STATS_PATH`.
 *
 * Telemetry, never source of truth: a missing or corrupt file starts fresh
 * rather than throwing — a stats read/write failure must never break `recall`
 * or `report_outcome`. Persistence is atomic (write to a temp file, then
 * `fs.renameSync`), matching `IngestLedgerStore`/`HygieneReportStore`.
 */
export class MemoryStatsStore {
    readonly filePath: string;

    constructor(filePath?: string) {
        this.filePath = filePath
            ?? envManager.get('GEMDEX_STATS_PATH')
            ?? path.join(os.homedir(), '.gemdex', 'stats.json');
    }

    /** Current stats for a memory id, or `undefined` if none have been recorded. */
    get(id: string): MemoryStats | undefined {
        return this.load().memories[id];
    }

    /**
     * Bump `recallCount` + `lastRecalledAt` for every id surfaced by a
     * `recall` call. No-op for an empty list (avoids an idle read+write).
     */
    recordRecall(ids: string[], now: number = Date.now()): void {
        if (ids.length === 0) return;
        const file = this.load();
        for (const id of ids) {
            const stats = file.memories[id] ?? emptyStats();
            stats.recallCount += 1;
            stats.lastRecalledAt = now;
            file.memories[id] = stats;
        }
        this.write(file);
    }

    /**
     * Record how acting on a recalled memory went. `note` is trimmed and
     * capped at {@link MAX_NOTE_LENGTH} characters. Returns the memory's
     * updated stats so the caller can render a track-record confirmation
     * without a second read.
     */
    recordOutcome(id: string, outcome: MemoryOutcome, note?: string, now: number = Date.now()): MemoryStats {
        const file = this.load();
        const stats = file.memories[id] ?? emptyStats();
        if (outcome === 'worked') stats.workedCount += 1;
        else if (outcome === 'failed') stats.failedCount += 1;
        else stats.staleCount += 1;
        const trimmedNote = note?.trim().slice(0, MAX_NOTE_LENGTH);
        stats.lastOutcome = { outcome, at: now, ...(trimmedNote && { note: trimmedNote }) };
        file.memories[id] = stats;
        this.write(file);
        return stats;
    }

    /** Drop all stats for a memory id. Harmless (no-op) if none exist — for future delete integration. */
    removeStats(id: string): void {
        const file = this.load();
        if (!(id in file.memories)) return;
        delete file.memories[id];
        this.write(file);
    }

    /**
     * Loaded fresh on every call (no in-memory cache — matches
     * `IngestLedgerStore`'s precedent), tolerant of a missing or corrupt
     * file: this is telemetry, never source of truth, so a parse failure
     * starts fresh instead of throwing into `recall`/`report_outcome`.
     */
    private load(): StatsFile {
        if (!fs.existsSync(this.filePath)) {
            return { version: 1, memories: {} };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || parsed.version !== 1
                || typeof parsed.memories !== 'object' || parsed.memories === null) {
                throw new Error('unsupported format');
            }
            return parsed as StatsFile;
        } catch {
            // Corrupt/foreign file — start fresh rather than throw. A later
            // write will overwrite it with a clean, valid ledger.
            return { version: 1, memories: {} };
        }
    }

    private write(file: StatsFile): void {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, this.filePath);
    }
}
