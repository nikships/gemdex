#!/usr/bin/env node
// Write the workspace path into ~/.gemdex/.sync-trigger so the gemdex MCP
// server kicks off an immediate incremental re-index scoped to just that
// codebase. Used by the Claude Code PostToolUse hook.
//
// Claude Code passes the hook payload as JSON on stdin. We extract `cwd`
// and write it into the trigger file as a single line. The MCP watcher
// reads that line and runs `reindexByChange` for the matching indexed
// codebase only. An empty file is the legacy "no workspace info" signal
// and the watcher falls back to a sync across every indexed codebase.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.gemdex');
const file = path.join(dir, '.sync-trigger');

function readStdinSync() {
    // Avoid blocking when no JSON payload is piped (e.g. manual invocation
    // from a terminal). isTTY is true exactly when stdin is not a pipe.
    if (process.stdin.isTTY) return '';
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function extractCwd(stdinText) {
    if (!stdinText) return '';
    try {
        const obj = JSON.parse(stdinText);
        if (obj && typeof obj.cwd === 'string') {
            return obj.cwd.trim();
        }
    } catch {
        // Not JSON or malformed — treat as no workspace info.
    }
    return '';
}

try {
    fs.mkdirSync(dir, { recursive: true });
    const cwd = extractCwd(readStdinSync());
    // Write atomically. writeFileSync truncates + writes, which also bumps
    // mtime — the gemdex fs.watch reacts to this the same way it did when
    // this script only touched the file.
    fs.writeFileSync(file, cwd ? `${cwd}\n` : '', 'utf8');
} catch (err) {
    // Never fail the hook for this; gemdex's periodic background sync
    // will still catch the change.
    process.stderr.write(`gemdex: failed to write sync trigger: ${err && err.message ? err.message : err}\n`);
    process.exit(0);
}
