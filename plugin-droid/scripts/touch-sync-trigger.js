#!/usr/bin/env node
// Touch ~/.gemdex/.sync-trigger so the gemdex MCP server kicks off
// an immediate incremental re-index. Cross-platform replacement for
// `touch ~/.gemdex/.sync-trigger` used by the Droid PostToolUse hook.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.gemdex');
const file = path.join(dir, '.sync-trigger');

try {
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    try {
        // Update mtime if the file already exists (gemdex's fs.watch reacts to this).
        fs.utimesSync(file, now, now);
    } catch {
        // File doesn't exist yet — create it.
        fs.closeSync(fs.openSync(file, 'a'));
    }
} catch (err) {
    // Never fail the hook for this; gemdex's periodic background sync
    // will still catch the change.
    process.stderr.write(`gemdex: failed to touch sync trigger: ${err && err.message ? err.message : err}\n`);
    process.exit(0);
}
