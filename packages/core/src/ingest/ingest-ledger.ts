import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IngestLedger, IngestLedgerEntry, PendingBatchJob } from './types';

/**
 * Persistent record of which session files have been ingested (and any
 * pending Batch API job), stored at `~/.gemdex/ingest.json`. Keyed by
 * absolute file path; an entry whose recorded mtime/size differ from the
 * file on disk marks the session as changed and due for re-ingestion.
 */
export class IngestLedgerStore {
    readonly ledgerPath: string;

    constructor(options: { rootDir?: string } = {}) {
        const rootDir = options.rootDir ?? path.join(os.homedir(), '.gemdex');
        this.ledgerPath = path.join(rootDir, 'ingest.json');
    }

    load(): IngestLedger {
        if (!fs.existsSync(this.ledgerPath)) {
            return { version: 1, files: {} };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || parsed.version !== 1
                || typeof parsed.files !== 'object' || parsed.files === null) {
                throw new Error('unsupported format');
            }
            return parsed as IngestLedger;
        } catch (error) {
            throw new Error(`Unable to read ${this.ledgerPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    getEntry(filePath: string): IngestLedgerEntry | undefined {
        return this.load().files[filePath];
    }

    recordIngested(filePath: string, entry: IngestLedgerEntry): void {
        const ledger = this.load();
        ledger.files[filePath] = entry;
        this.write(ledger);
    }

    /** Upsert several entries in one read-modify-write (used to self-heal mtime churn). */
    updateEntries(entries: Record<string, IngestLedgerEntry>): void {
        const paths = Object.keys(entries);
        if (paths.length === 0) return;
        const ledger = this.load();
        for (const filePath of paths) {
            ledger.files[filePath] = entries[filePath];
        }
        this.write(ledger);
    }

    setPendingBatch(job: PendingBatchJob | undefined): void {
        const ledger = this.load();
        if (job) {
            ledger.pendingBatch = job;
        } else {
            delete ledger.pendingBatch;
        }
        this.write(ledger);
    }

    getPendingBatch(): PendingBatchJob | undefined {
        return this.load().pendingBatch;
    }

    private write(ledger: IngestLedger): void {
        fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.ledgerPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, this.ledgerPath);
    }
}
