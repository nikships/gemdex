import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gemdex-mcp-status-"));
    const homeDir = path.join(tempRoot, "home");
    await mkdir(homeDir, { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        await mkdir(path.join(homeDir, ".gemdex"), { recursive: true });
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

        await rm(tempRoot, { recursive: true, force: true });
    }
}

function createCloudSyncContext(codebasePath: string) {
    return {
        getVectorDatabase() {
            return {
                async listCollections() {
                    return ["hybrid_code_chunks_partial"];
                },
                async getCollectionDescription(collectionName: string) {
                    assert.equal(collectionName, "hybrid_code_chunks_partial");
                    return `codebasePath:${codebasePath}`;
                },
                async query() {
                    throw new Error("metadata fallback should not be used when description has codebasePath");
                },
                async getCollectionRowCount() {
                    throw new Error("row count must not be used as indexing completion");
                }
            };
        }
    };
}

test("get_indexing_status does not let cloud sync clobber active indexing state", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexing(codebasePath, 37);
        snapshotManager.saveCodebaseSnapshot();

        const handlers = new ToolHandlers(createCloudSyncContext(codebasePath) as any, snapshotManager);

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /currently being indexed/);
        assert.match(result.content[0].text, /37\.0%/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), []);
    });
});

test("get_indexing_status does not recover cloud-only row counts as completed indexing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");

        const handlers = new ToolHandlers(createCloudSyncContext(codebasePath) as any, snapshotManager);

        const result = await handlers.handleGetIndexingStatus({ path: codebasePath });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /is not indexed/);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "not_found");
        assert.deepEqual(snapshotManager.getIndexedCodebases(), []);
    });
});

test("legacy zero-entry validation does not use row count as indexedFiles", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotPath = path.join(tempRoot, "home", ".gemdex", "mcp-codebase-snapshot.json");
        await writeFile(snapshotPath, JSON.stringify({
            formatVersion: "v2",
            codebases: {
                [codebasePath]: {
                    status: "indexed",
                    indexedFiles: 0,
                    totalChunks: 0,
                    indexStatus: "completed",
                    lastUpdated: new Date().toISOString()
                }
            },
            lastUpdated: new Date().toISOString()
        }, null, 2));

        const snapshotManager = new SnapshotManager();
        snapshotManager.loadCodebaseSnapshot();
        const handlers = new ToolHandlers({
            getCollectionName() {
                return "hybrid_code_chunks_partial";
            },
            getVectorDatabase() {
                return {
                    async hasCollection(collectionName: string) {
                        assert.equal(collectionName, "hybrid_code_chunks_partial");
                        return true;
                    },
                    async getCollectionRowCount(collectionName: string) {
                        assert.equal(collectionName, "hybrid_code_chunks_partial");
                        return 42;
                    }
                };
            }
        } as any, snapshotManager);

        await handlers.validateLegacyZeroEntries();

        const info = snapshotManager.getCodebaseInfo(codebasePath);
        assert.equal(info?.status, "indexed");
        if (!info || info.status !== "indexed") {
            throw new Error("Expected legacy entry to remain indexed after validation");
        }
        assert.equal(info.indexedFiles, 0);
        assert.equal(info.totalChunks, 42);
    });
});

test("search_code formats multimodal hits as media references", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        snapshotManager.setCodebaseIndexed(codebasePath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: "completed",
        });
        snapshotManager.saveCodebaseSnapshot();

        const context = {
            getEmbedding: () => ({
                getProvider: () => "test",
            }),
            semanticSearch: async () => [{
                content: "PDF page 1: guide.pdf\nPage: 1\nMIME type: application/pdf",
                relativePath: "guide.pdf",
                startLine: 1,
                endLine: 1,
                language: "pdf",
                score: 0.9,
                metadata: {
                    mediaType: "pdf",
                    page: 1,
                    mimeType: "application/pdf",
                },
            }],
        };

        const handlers = new ToolHandlers(context as any, snapshotManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const result = await handlers.handleSearchCode({
            path: codebasePath,
            query: "architecture guide",
            limit: 1,
        });

        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /PDF page 1/);
        assert.match(result.content[0].text, /Location: guide\.pdf#page=1/);
        assert.doesNotMatch(result.content[0].text, /Code snippet/);
    });
});
