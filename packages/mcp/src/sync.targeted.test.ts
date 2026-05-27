import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import type { Context } from "gemdex-core";

interface RecordedReindex {
    codebasePath: string;
    additionalIgnorePatterns: string[];
    additionalSupportedExtensions: string[];
}

function createStubContext(): { context: Context; calls: RecordedReindex[] } {
    const calls: RecordedReindex[] = [];
    const context = {
        async reindexByChange(
            codebasePath: string,
            _progressCallback: unknown,
            additionalIgnorePatterns: string[] = [],
            additionalSupportedExtensions: string[] = []
        ): Promise<{ added: number; removed: number; modified: number }> {
            calls.push({
                codebasePath,
                additionalIgnorePatterns,
                additionalSupportedExtensions
            });
            return { added: 0, removed: 0, modified: 0 };
        }
    } as unknown as Context;
    return { context, calls };
}

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gemdex-mcp-sync-target-"));
    const homeDir = path.join(tempRoot, "home");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        await fs.mkdir(path.join(homeDir, ".gemdex"), { recursive: true });
        await run(tempRoot);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

test("handleSyncIndex with a target path only syncs that codebase", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = path.join(tempRoot, "repoA");
        const repoB = path.join(tempRoot, "repoB");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(repoA, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        snapshotManager.setCodebaseIndexed(repoB, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        snapshotManager.saveCodebaseSnapshot();

        const { context, calls } = createStubContext();
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex(repoB);

        assert.equal(calls.length, 1, "only one codebase should be re-synced");
        assert.equal(calls[0].codebasePath, repoB);
    });
});

test("handleSyncIndex resolves a subdirectory target to its parent indexed codebase", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = path.join(tempRoot, "repoA");
        await fs.mkdir(repoA);
        const sub = path.join(repoA, "packages", "inner");
        await fs.mkdir(sub, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(repoA, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        snapshotManager.saveCodebaseSnapshot();

        const { context, calls } = createStubContext();
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex(sub);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].codebasePath, repoA);
    });
});

test("handleSyncIndex with an unindexed target skips the sync entirely", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = path.join(tempRoot, "repoA");
        const elsewhere = path.join(tempRoot, "elsewhere");
        await fs.mkdir(repoA);
        await fs.mkdir(elsewhere);

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(repoA, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        snapshotManager.saveCodebaseSnapshot();

        const { context, calls } = createStubContext();
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex(elsewhere);

        assert.equal(calls.length, 0, "non-tracked target must not fall back to all-codebases sync");
    });
});

test("handleSyncIndex without a target falls back to syncing every indexed codebase", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = path.join(tempRoot, "repoA");
        const repoB = path.join(tempRoot, "repoB");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(repoA, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        snapshotManager.setCodebaseIndexed(repoB, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        snapshotManager.saveCodebaseSnapshot();

        const { context, calls } = createStubContext();
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex();

        const paths = calls.map(c => c.codebasePath).sort();
        assert.deepEqual(paths, [repoA, repoB].sort());
    });
});

test("handleSyncIndex forwards the codebase's stored requestCustomExtensions on a targeted sync", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = path.join(tempRoot, "repo");
        await fs.mkdir(repo);

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(
            repo,
            { indexedFiles: 1, totalChunks: 1, status: "completed" },
            { requestSplitter: "ast", requestCustomExtensions: [".txt"] }
        );
        snapshotManager.saveCodebaseSnapshot();

        const { context, calls } = createStubContext();
        const syncManager = new SyncManager(context, snapshotManager);

        await syncManager.handleSyncIndex(repo);

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].additionalSupportedExtensions, [".txt"]);
    });
});
