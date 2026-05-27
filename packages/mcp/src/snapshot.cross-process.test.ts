import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gemdex-mcp-snapshot-xproc-"));
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

test("getCodebaseInfo reflects on-disk snapshot updates written by another process", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await fs.mkdir(codebasePath);

        // Simulate process A: indexes the codebase with custom extensions and persists.
        const processA = new SnapshotManager();
        processA.setCodebaseIndexing(codebasePath, 0, {
            requestSplitter: "ast",
            requestCustomExtensions: [".txt"]
        });
        processA.setCodebaseIndexed(
            codebasePath,
            { indexedFiles: 1, totalChunks: 1, status: "completed" },
            { requestSplitter: "ast", requestCustomExtensions: [".txt"] }
        );
        processA.saveCodebaseSnapshot();

        // Process B starts AFTER process A indexed — but never loads the snapshot.
        // Before the fix, getCodebaseInfo returned undefined here (in-memory map empty),
        // and a background sync run by B would call reindexByChange with default
        // extensions, dropping `.txt` files and wiping the merkle.
        const processB = new SnapshotManager();
        const info = processB.getCodebaseInfo(codebasePath);

        assert.notEqual(info, undefined, "process B must see the codebase that process A indexed");
        assert.equal(info?.status, "indexed");
        if (info?.status === "indexed") {
            assert.deepEqual(info.requestCustomExtensions, [".txt"]);
            assert.equal(info.requestSplitter, "ast");
        }
    });
});

test("getCodebaseInfo falls back to in-memory state when snapshot file is missing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await fs.mkdir(codebasePath);

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexing(codebasePath, 12, {
            requestSplitter: "langchain"
        });
        // Intentionally do not call saveCodebaseSnapshot — the on-disk file
        // does not exist yet. getCodebaseInfo should still return the in-memory
        // state so callers within the same process behave consistently.

        const info = snapshotManager.getCodebaseInfo(codebasePath);
        assert.equal(info?.status, "indexing");
        if (info?.status === "indexing") {
            assert.equal(info.indexingPercentage, 12);
            assert.equal(info.requestSplitter, "langchain");
        }
    });
});
