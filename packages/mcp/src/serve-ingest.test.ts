import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { INFERENCE_PRICING_AS_OF, IngestLedgerStore, IngestManager } from "gemdex-core";
import type {
    ClaudeCodeReadiness,
    Digester,
    ImportRecordsResult,
    IngestProgress,
    IngestRunOptions,
    IngestScanResult,
    IngestSourceFolder,
    IngestTarget,
    MemoryBackend,
    MemoryExportRecord,
    ParsedSession,
    SessionDigest,
} from "gemdex-core";
import { ClientConfigStore } from "./cli-config.js";
import { createConfig } from "./config.js";
import { INSTALL_HINT } from "./memory.js";
import { createServer, ServeContext } from "./serve.js";

const TOKEN = "ingest-test-token";
const READY: ClaudeCodeReadiness = { status: "ready", version: "2.1.0", checkedAt: 1 };

interface FakeManagerCalls {
    scans: IngestSourceFolder[][];
    runs: IngestRunOptions[];
    targets: IngestTarget[];
    cancels: number;
}

let calls: FakeManagerCalls;
let running: boolean;
let progress: IngestProgress;

function resetFake(): void {
    calls = { scans: [], runs: [], targets: [], cancels: 0 };
    running = false;
    progress = { state: "idle", processed: 0, failed: 0, skipped: 0, total: 0 };
}
resetFake();

const scanResult: IngestScanResult = {
    buckets: { newFiles: [], changedFiles: [], upToDate: [], skippedActive: [] },
    processableFiles: [],
    skippedTrivialFiles: [],
    pendingCount: 3,
    estimatedInputTokens: 900,
    estimatedOutputTokens: 2400,
    estimates: [{ model: "haiku", usd: 0.01 }],
};

const fakeManager: Pick<IngestManager, "scan" | "run" | "getProgress" | "isRunning" | "cancel"> = {
    scan(folders) {
        calls.scans.push(folders);
        return scanResult;
    },
    async run(options, target) {
        calls.runs.push(options);
        calls.targets.push(target);
        progress = { state: "done", processed: 2, failed: 0, skipped: 0, total: 2 };
        return progress;
    },
    getProgress() {
        return progress;
    },
    isRunning() {
        return running;
    },
    cancel() {
        calls.cancels += 1;
    },
};

const fakeStore = { importRecords: async () => ({ imported: 0, failed: 0, errors: [] }) } as unknown as MemoryBackend;

let savedHome: string | undefined;
let tmpDir: string;
let ctx: ServeContext;
let base: string;
let closeServer: () => Promise<void>;

function authed(input: string, init: RequestInit = {}): Promise<Response> {
    return fetch(input, {
        ...init,
        headers: { "Content-Type": "application/json", "X-Gemdex-Token": TOKEN, ...(init.headers ?? {}) },
    });
}

function postJson(url: string, body: unknown): Promise<Response> {
    return authed(url, { method: "POST", body: JSON.stringify(body) });
}

async function startServer(overrides: Partial<ServeContext> = {}): Promise<{ base: string; ctx: ServeContext; close: () => Promise<void> }> {
    const serverCtx: ServeContext = {
        config: createConfig(() => undefined),
        store: fakeStore,
        token: TOKEN,
        clientConfigStore: new ClientConfigStore({ rootDir: path.join(tmpDir, "gemdex") }),
        isModelInstalled: () => true,
        ingestManager: fakeManager as IngestManager,
        claudeCode: READY,
        checkClaudeCode: async () => READY,
        ...overrides,
    };
    const server = createServer(serverCtx);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        ctx: serverCtx,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-ingest-"));
    // Preset folders resolve from HOME; keep them inside the temp dir.
    savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const started = await startServer();
    base = started.base;
    ctx = started.ctx;
    closeServer = started.close;
});

after(async () => {
    await closeServer();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    resetFake();
    ctx.claudeCode = READY;
});

test("ingest routes require the token", async () => {
    for (const [method, route] of [
        ["GET", "/ingest/sources"],
        ["POST", "/ingest/folders"],
        ["DELETE", "/ingest/folders"],
        ["POST", "/ingest/scan"],
        ["POST", "/ingest/start"],
        ["GET", "/ingest/status"],
        ["POST", "/ingest/cancel"],
    ]) {
        const res = await fetch(`${base}${route}`, { method });
        assert.equal(res.status, 401, `${method} ${route}`);
    }
    assert.equal(calls.runs.length, 0);
});

test("GET /ingest/sources lists presets with session counts, models, pricing and readiness", async () => {
    const claudeProjects = path.join(tmpDir, ".claude", "projects", "repo");
    fs.mkdirSync(claudeProjects, { recursive: true });
    fs.writeFileSync(path.join(claudeProjects, "one.jsonl"), "{}\n");
    fs.writeFileSync(path.join(claudeProjects, "two.jsonl"), "{}\n");
    try {
        const res = await authed(`${base}/ingest/sources`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as any;
        assert.deepEqual(body.presets.map((p: any) => p.source), ["claude", "factory", "codex", "antigravity"]);
        assert.deepEqual(body.presets[0], {
            source: "claude",
            path: path.join(tmpDir, ".claude", "projects"),
            exists: true,
            sessionCount: 2,
        });
        assert.equal(body.presets[1].exists, false);
        assert.equal(body.presets[1].sessionCount, 0);
        assert.deepEqual(body.customFolders, []);
        assert.deepEqual(body.models, [{
            model: "haiku",
            description: "Claude Haiku via your Claude Code login",
            inputUsdPerMTok: 1,
            outputUsdPerMTok: 5,
            isDefault: true,
        }]);
        assert.equal(body.pricingAsOf, INFERENCE_PRICING_AS_OF);
        assert.equal(body.ingestReady, true);
        assert.deepEqual(body.claudeCode, READY);
    } finally {
        fs.rmSync(path.join(tmpDir, ".claude"), { recursive: true, force: true });
    }
});

test("GET /ingest/sources reports not-ready with the Claude Code status", async () => {
    ctx.claudeCode = { status: "unauthenticated", message: "Not logged in.", checkedAt: 3 };
    const body = (await (await authed(`${base}/ingest/sources`)).json()) as any;
    assert.equal(body.ingestReady, false);
    assert.deepEqual(body.claudeCode, { status: "unauthenticated", message: "Not logged in.", checkedAt: 3 });
});

test("POST/DELETE /ingest/folders manage custom folders", async () => {
    const folder = path.join(tmpDir, "my-sessions");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "a.jsonl"), "{}\n");

    const added = await postJson(`${base}/ingest/folders`, { path: `${folder}/` });
    assert.equal(added.status, 200);
    const addedBody = (await added.json()) as any;
    assert.deepEqual(addedBody.customFolders, [{ source: "custom", path: folder, exists: true, sessionCount: 1 }]);
    assert.deepEqual(ctx.clientConfigStore!.listIngestFolders(), [folder]);

    const again = (await (await postJson(`${base}/ingest/folders`, { path: folder })).json()) as any;
    assert.equal(again.customFolders.length, 1, "adding the same folder is idempotent");

    assert.equal((await postJson(`${base}/ingest/folders`, { path: "relative/path" })).status, 400);
    const missing = await postJson(`${base}/ingest/folders`, {});
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "'path' is required" });

    const removeMissing = await authed(`${base}/ingest/folders`, { method: "DELETE", body: JSON.stringify({}) });
    assert.equal(removeMissing.status, 400);

    const removed = await authed(`${base}/ingest/folders`, { method: "DELETE", body: JSON.stringify({ path: folder }) });
    assert.equal(removed.status, 200);
    assert.deepEqual(((await removed.json()) as any).customFolders, []);
    assert.deepEqual(ctx.clientConfigStore!.listIngestFolders(), []);
});

test("POST /ingest/scan validates sources and delegates to the manager", async () => {
    assert.equal((await postJson(`${base}/ingest/scan`, { sources: [] })).status, 400);
    assert.equal((await postJson(`${base}/ingest/scan`, {})).status, 400);
    assert.equal((await postJson(`${base}/ingest/scan`, { sources: [{ source: "cursor" }] })).status, 400);
    const relative = await postJson(`${base}/ingest/scan`, { sources: [{ source: "custom", path: "sessions" }] });
    assert.equal(relative.status, 400);
    assert.match(((await relative.json()) as { error: string }).error, /absolute 'path'/);
    assert.equal(calls.scans.length, 0);

    const ok = await postJson(`${base}/ingest/scan`, {
        sources: [
            { source: "claude" },
            { source: "factory" },
            { source: "codex" },
            { source: "antigravity" },
            { source: "custom", path: tmpDir },
        ],
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), scanResult);
    assert.deepEqual(calls.scans.at(-1), [
        { source: "claude", path: path.join(tmpDir, ".claude", "projects") },
        { source: "factory", path: path.join(tmpDir, ".factory", "sessions") },
        { source: "codex", path: path.join(tmpDir, ".codex", "sessions") },
        { source: "antigravity", path: path.join(tmpDir, ".gemini", "antigravity-cli", "conversations") },
        { source: "custom", path: tmpDir },
    ]);
});

test("POST /ingest/scan works while Claude Code is not ready (it makes no model calls)", async () => {
    ctx.claudeCode = { status: "missing", message: "Claude Code CLI not found.", checkedAt: 1 };
    const res = await postJson(`${base}/ingest/scan`, { sources: [{ source: "factory" }] });
    assert.equal(res.status, 200);
    assert.equal(calls.scans.length, 1);
});

test("POST /ingest/start starts a run against the store and /ingest/status reports it", async () => {
    const res = await postJson(`${base}/ingest/start`, {
        sources: [{ source: "factory" }],
        model: " haiku ",
        // Legacy client fields are ignored.
        mode: "batch",
        newOnly: false,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { started: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(calls.runs.length, 1);
    assert.deepEqual(calls.runs[0], {
        folders: [{ source: "factory", path: path.join(tmpDir, ".factory", "sessions") }],
        model: "haiku",
    });
    assert.equal(calls.targets[0], fakeStore);

    const status = (await (await authed(`${base}/ingest/status`)).json()) as IngestProgress;
    assert.deepEqual(status, { state: "done", processed: 2, failed: 0, skipped: 0, total: 2 });
});

test("POST /ingest/start omits the model when none is sent", async () => {
    assert.equal((await postJson(`${base}/ingest/start`, { sources: [{ source: "claude" }], model: "  " })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.runs[0].model, undefined);
});

for (const state of [
    { status: "missing" as const, message: "Claude Code CLI not found.", checkedAt: 1 },
    { status: "unauthenticated" as const, message: "Claude Code is not logged in.", checkedAt: 1 },
    { status: "error" as const, checkedAt: 1 },
]) {
    test(`POST /ingest/start answers 400 when Claude Code is ${state.status}`, async () => {
        ctx.claudeCode = state;
        const res = await postJson(`${base}/ingest/start`, { sources: [{ source: "factory" }] });
        assert.equal(res.status, 400);
        const { error } = (await res.json()) as { error: string };
        assert.match(error, /^Chat-history ingestion needs Claude Code\. /);
        assert.ok(error.includes(state.message ?? `Claude Code status: ${state.status}.`), error);
        assert.equal(calls.runs.length, 0);
    });
}

test("POST /ingest/start answers 400 while the Claude Code check is still running", async () => {
    ctx.claudeCode = { status: "checking" };
    const res = await postJson(`${base}/ingest/start`, { sources: [{ source: "factory" }] });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /waiting for the Claude Code check to finish/);
    assert.equal(calls.runs.length, 0);
});

test("POST /ingest/start validates sources before the Claude Code gate", async () => {
    ctx.claudeCode = { status: "missing", message: "Claude Code CLI not found.", checkedAt: 1 };
    const res = await postJson(`${base}/ingest/start`, { sources: [] });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /'sources' must be a non-empty array/);
});

test("POST /ingest/start returns 409 while a run is in progress", async () => {
    running = true;
    const res = await postJson(`${base}/ingest/start`, { sources: [{ source: "factory" }] });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "An ingestion run is already in progress." });
    assert.equal(calls.runs.length, 0);
});

test("Claude Code readiness is checked before the in-progress 409", async () => {
    running = true;
    ctx.claudeCode = { status: "missing", message: "Claude Code CLI not found.", checkedAt: 1 };
    const res = await postJson(`${base}/ingest/start`, { sources: [{ source: "factory" }] });
    assert.equal(res.status, 400);
});

test("POST /ingest/cancel cancels only a live run", async () => {
    const idle = await authed(`${base}/ingest/cancel`, { method: "POST" });
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), { cancelled: "none" });
    assert.equal(calls.cancels, 0);

    running = true;
    const live = await authed(`${base}/ingest/cancel`, { method: "POST" });
    assert.deepEqual(await live.json(), { cancelled: "run" });
    assert.equal(calls.cancels, 1);
});

test("POST /ingest/collect no longer exists", async () => {
    const res = await authed(`${base}/ingest/collect`, { method: "POST" });
    assert.equal(res.status, 404);
});

test("ingest routes answer 503 needsInstall when no store is mounted", async () => {
    const bare = await startServer({ store: null, isModelInstalled: () => false });
    try {
        for (const [method, route] of [["GET", "/ingest/sources"], ["POST", "/ingest/start"], ["GET", "/ingest/status"]]) {
            const res = await authed(`${bare.base}${route}`, { method, ...(method === "POST" && { body: "{}" }) });
            assert.equal(res.status, 503, route);
            assert.deepEqual(await res.json(), { error: INSTALL_HINT, needsInstall: true });
        }
    } finally {
        await bare.close();
    }
});

class RecordingStore {
    imported: MemoryExportRecord[] = [];
    async importRecords(records: MemoryExportRecord[]): Promise<ImportRecordsResult> {
        this.imported.push(...records);
        return { imported: records.length, failed: 0, errors: [] };
    }
}

class FakeDigester implements Digester {
    readonly model = "haiku";
    async digest(session: ParsedSession): Promise<SessionDigest> {
        return {
            title: `Digest ${session.sessionId}`,
            whatWasDone: "Set up signing.",
            howToReproduce: [],
            toolsAndServices: [],
            credentialsAndConfig: [],
            gotchas: [],
        };
    }
}

test("POST /ingest/start drives a real IngestManager with an injected digester end to end", async () => {
    const sessions = path.join(tmpDir, "e2e-sessions");
    const text = "Configure code signing for the release build and staple the notarization ticket. ".repeat(4);
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "gamma.jsonl");
    fs.writeFileSync(file, [
        { type: "user", sessionId: "gamma", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text } },
        { type: "assistant", sessionId: "gamma", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", content: [{ type: "text", text }] } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(file, old, old);

    const store = new RecordingStore();
    const models: Array<string | undefined> = [];
    const real = await startServer({
        store: store as unknown as MemoryBackend,
        ingestManager: new IngestManager({
            ledger: new IngestLedgerStore({ rootDir: path.join(tmpDir, "e2e-ledger") }),
            createDigester: (model) => { models.push(model); return new FakeDigester(); },
        }),
    });
    try {
        const scan = (await (await postJson(`${real.base}/ingest/scan`, { sources: [{ source: "custom", path: sessions }] })).json()) as IngestScanResult;
        assert.equal(scan.pendingCount, 1);
        assert.deepEqual(scan.estimates.map((e) => e.model), ["haiku"]);

        const started = await postJson(`${real.base}/ingest/start`, { sources: [{ source: "custom", path: sessions }] });
        assert.equal(started.status, 200);
        let status: IngestProgress | undefined;
        for (let i = 0; i < 100; i++) {
            status = (await (await authed(`${real.base}/ingest/status`)).json()) as IngestProgress;
            if (status.state === "done" || status.state === "failed") break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(status?.state, "done");
        assert.equal(status?.processed, 1);
        assert.deepEqual(models, [undefined]);
        assert.deepEqual(store.imported.map((record) => record.id), ["chat:custom:gamma"]);
        assert.equal(store.imported[0].title, "Digest gamma");
    } finally {
        await real.close();
    }
});
