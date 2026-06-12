import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IngestLedgerStore } from './ingest-ledger';
import { IngestSourceFolder, ScanBuckets, SessionFile } from './types';

/** Files modified within this window are treated as active sessions and skipped. */
export const ACTIVE_SESSION_WINDOW_MS = 10 * 60 * 1000;

/** Default preset locations for supported coding agents. */
export function claudePresetFolder(homeDir: string = os.homedir()): IngestSourceFolder {
    return { source: 'claude', path: path.join(homeDir, '.claude', 'projects') };
}

export function factoryPresetFolder(homeDir: string = os.homedir()): IngestSourceFolder {
    return { source: 'factory', path: path.join(homeDir, '.factory', 'sessions') };
}

export function codexPresetFolder(homeDir: string = os.homedir()): IngestSourceFolder {
    return { source: 'codex', path: path.join(homeDir, '.codex', 'sessions') };
}

export function antigravityPresetFolder(homeDir: string = os.homedir()): IngestSourceFolder {
    return { source: 'antigravity', path: path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations') };
}

/**
 * A transcript candidate is normally any `*.jsonl` file. Antigravity stores
 * conversation records as SQLite/protobuf `*.db` and protobuf `*.pb` files
 * under its conversations folder.
 * Factory writes sibling `<id>.settings.json` files which don't match, but guard
 * against any future `*.settings.jsonl` shape too.
 */
function isSessionFileName(name: string, source: IngestSourceFolder['source']): boolean {
    if (source === 'antigravity') return name.endsWith('.db') || name.endsWith('.pb');
    return name.endsWith('.jsonl') && !name.endsWith('.settings.jsonl');
}

function walk(dir: string, source: IngestSourceFolder['source'], out: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return; // unreadable directory — skip silently
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, source, out);
        } else if (entry.isFile() && isSessionFileName(entry.name, source)) {
            out.push(full);
        }
    }
}

/** Discover all session files under a set of source folders. */
export function discoverSessionFiles(folders: IngestSourceFolder[]): SessionFile[] {
    const files: SessionFile[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
        const paths: string[] = [];
        walk(folder.path, folder.source, paths);
        for (const filePath of paths) {
            if (seen.has(filePath)) continue;
            seen.add(filePath);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }
            files.push({
                source: folder.source,
                filePath,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
            });
        }
    }
    return files;
}

/**
 * Bucket discovered files against the ledger:
 * - `skippedActive` — modified within the active-session window (in-progress).
 * - `newFiles` — no ledger entry.
 * - `changedFiles` — ledger entry exists but mtime or size differ.
 * - `upToDate` — ledger entry matches the file on disk.
 */
export function bucketSessionFiles(
    files: SessionFile[],
    ledger: IngestLedgerStore,
    now: number = Date.now(),
): ScanBuckets {
    const entries = ledger.load().files;
    const buckets: ScanBuckets = { newFiles: [], changedFiles: [], upToDate: [], skippedActive: [] };
    for (const file of files) {
        if (now - file.mtimeMs < ACTIVE_SESSION_WINDOW_MS) {
            buckets.skippedActive.push(file);
            continue;
        }
        const entry = entries[file.filePath];
        if (!entry) {
            buckets.newFiles.push(file);
        } else if (entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) {
            buckets.changedFiles.push(file);
        } else {
            buckets.upToDate.push(file);
        }
    }
    return buckets;
}
