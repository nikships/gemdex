#!/usr/bin/env node
// Single source of truth for the whole repo's version: the root `VERSION` file.
// This script stamps that version into every place a version lives so all four
// packages — gemdex-core, gemdex-mcp, gemdex-server, the macOS app — and the
// root manifest always ship in lockstep under ONE version number.
//
// Usage:
//   node scripts/sync-version.mjs            # stamp root VERSION everywhere
//   node scripts/sync-version.mjs --bump     # patch-bump root VERSION first, then stamp
//   node scripts/sync-version.mjs --set X.Y.Z # set root VERSION to X.Y.Z, then stamp
//
// Prints the resulting version as the last line of stdout (so CI can capture it).
// Idempotent: stamping an already-synced tree is a no-op.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(ROOT, "VERSION");

// Every package.json that must carry the unified version.
const PACKAGE_JSON_FILES = [
    "package.json",
    "packages/core/package.json",
    "packages/mcp/package.json",
    "packages/server/package.json",
];
// The macOS app keeps its version in a bare VERSION file (read by build-app.sh
// and the release workflow), not a package.json.
const APP_VERSION_FILE = "packages/app/VERSION";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function readRootVersion() {
    const raw = fs.readFileSync(VERSION_FILE, "utf8").trim();
    if (!SEMVER.test(raw)) {
        throw new Error(`Root VERSION file is not a valid x.y.z semver: "${raw}"`);
    }
    return raw;
}

function writeRootVersion(version) {
    fs.writeFileSync(VERSION_FILE, `${version}\n`);
}

function patchBump(version) {
    const [, maj, min, pat] = SEMVER.exec(version);
    return `${maj}.${min}.${Number(pat) + 1}`;
}

function stampPackageJson(relPath, version) {
    const file = path.join(ROOT, relPath);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (pkg.version === version) {
        return false;
    }
    pkg.version = version;
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 4)}\n`);
    return true;
}

function stampAppVersion(version) {
    const file = path.join(ROOT, APP_VERSION_FILE);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (current === version) {
        return false;
    }
    fs.writeFileSync(file, `${version}\n`);
    return true;
}

function main() {
    const args = process.argv.slice(2);
    const setIndex = args.indexOf("--set");

    let version;
    if (setIndex !== -1) {
        version = (args[setIndex + 1] ?? "").trim();
        if (!SEMVER.test(version)) {
            throw new Error(`--set requires a valid x.y.z version, got "${version}"`);
        }
        writeRootVersion(version);
    } else if (args.includes("--bump")) {
        version = patchBump(readRootVersion());
        writeRootVersion(version);
    } else {
        version = readRootVersion();
    }

    const changed = [];
    for (const rel of PACKAGE_JSON_FILES) {
        if (stampPackageJson(rel, version)) {
            changed.push(rel);
        }
    }
    if (stampAppVersion(version)) {
        changed.push(APP_VERSION_FILE);
    }

    for (const rel of changed) {
        console.error(`  synced ${rel} -> ${version}`);
    }
    console.error(changed.length === 0 ? `Already at ${version} (no changes).` : `Synced ${changed.length} file(s) to ${version}.`);
    // Last stdout line = the version, for CI capture.
    console.log(version);
}

main();
