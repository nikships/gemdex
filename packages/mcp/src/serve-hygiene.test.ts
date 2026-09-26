import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import {
    Embedding,
    EmbeddingVector,
    FileBlobStore,
    HygieneManager,
    HygieneReportStore,
    INFERENCE_PRICING_AS_OF,
    LanceDBVectorDatabase,
    LocalMemoryBackend,
} from "gemdex-core";
import type {
    ClaudeCodeReadiness,
    HygieneFinding,
    HygieneProgress,
    HygieneReport,
    HygieneRunOptions,
    HygieneScanResult,
    Judge,
    JudgeMemberInput,
    MemoryBackend,
    MemoryStore,
} from "gemdex-core";
import { ClientConfigStore } from "./cli-config.js";
import { createConfig } from "./config.js";
import { INSTALL_HINT } from "./memory.js";
import { createServer, ServeContext } from "./serve.js";

const TOKEN = "hygiene-test-token";
const READY: ClaudeCodeReadiness = { status: "ready", version: "2.1.0", checkedAt: 1 };

interface FakeManagerCalls {
    scans: Array<{ store: MemoryStore; threshold: number | undefined }>;
    runs: Array<{ options: HygieneRunOptions; store: MemoryStore }>;
    applies: Array<{ ids: string[]; backend: MemoryBackend }>;
    dismissals: string[][];
    cancels: number;
}

let calls: FakeManagerCalls;
let running: boolean;
let progress: HygieneProgress;

function resetFake(): void {
    calls = { scans: [], runs: [], applies: [], dismissals: [], cancels: 0 };
    running = false;
    progress = { state: "idle", judged: 0, failed: 0, total: 0 };
}
resetFake();

const scanResult: HygieneScanResult = {
    scannedAt: 123,
    threshold: 0.85,
    memoryCount: 4,
    clusters: [],
    dismissedCount: 0,
    estimatedInputTokens: 10,
    estimatedOutputTokens: 20,
    estimates: [{ model: "haiku", usd: 0 }],
};

const fakeManager: Pick<HygieneManager, "getReport" | "scan" | "run" | "getProgress" | "isRunning" | "cancel" | "apply" | "dismiss"> = {
    getReport: () => null,
    async scan(store, threshold) {
        calls.scans.push({ store, threshold });
        return scanResult;
    },
    async run(options, store) {
        calls.runs.push({ options, store });
        progress = { state: "done", judged: 3, failed: 0, total: 3 };
        return progress;
    },
    getProgress: () => progress,
    isRunning: () => running,
    cancel() {
        calls.cancels += 1;
    },
    async apply(ids, backend) {
        calls.applies.push({ ids, backend });
        return { deleted: ids.length };
    },
    dismiss(clusterIds) {
        calls.dismissals.push(clusterIds);
    },
};

const fakeMemoryStore = {} as unknown as MemoryStore;

// localStore() gates on `instanceof LocalMemoryBackend`, so the fake must
// carry the real prototype; Object.create skips the constructor.
const fakeStore = Object.create(LocalMemoryBackend.prototype) as LocalMemoryBackend;
Object.assign(fakeStore, { getStore: () => fakeMemoryStore });

let tmpDir: string;
let base: string;
let ctx: ServeContext;
let closeServer: () => Promise<void>;

function authed(input: string, init: RequestInit = {}): Promise<Response> {
    return fetch(input, {
        ...init,
        headers: { "Content-Type": "application/json", "X-Gemdex-Token": TOKEN, ...(init.headers ?? {}) },
    });
}

function postJson(url: string, body: unknown = {}): Promise<Response> {
    return authed(url, { method: "POST", body: JSON.stringify(body) });
}

async function startServer(overrides: Partial<ServeContext> = {}): Promise<{ base: string; ctx: ServeContext; close: () => Promise<void> }> {
    const serverCtx: ServeContext = {
        config: createConfig(() => undefined),
        store: fakeStore,
        token: TOKEN,
        clientConfigStore: new ClientConfigStore({ rootDir: path.join(tmpDir, "gemdex") }),
        isModelInstalled: () => true,
        hygieneManager: fakeManager as HygieneManager,
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-hygiene-"));
    const started = await startServer();
    base = started.base;
    ctx = started.ctx;
    closeServer = started.close;
});

after(async () => {
    await closeServer();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    resetFake();
    ctx.claudeCode = READY;
});

test("hygiene routes require the token", async () => {
    for (const [method, route] of [
        ["GET", "/hygiene/report"],
        ["POST", "/hygiene/scan"],
        ["POST", "/hygiene/start"],
        ["GET", "/hygiene/status"],
        ["POST", "/hygiene/cancel"],
        ["POST", "/hygiene/apply"],
        ["POST", "/hygiene/dismiss"],
    ]) {
        assert.equal((await fetch(`${base}${route}`, { method })).status, 401, `${method} ${route}`);
    }
    assert.equal(calls.runs.length + calls.applies.length + calls.dismissals.length, 0);
});

test("GET /hygiene/report returns the persisted report, the Haiku model, pricing and readiness", async () => {
    const res = await authed(`${base}/hygiene/report`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        report: null,
        models: [{
            model: "haiku",
            description: "Claude Haiku via your Claude Code login",
            inputUsdPerMTok: 1,
            outputUsdPerMTok: 5,
            isDefault: true,
        }],
        pricingAsOf: INFERENCE_PRICING_AS_OF,
        hygieneReady: true,
    });
});

test("GET /hygiene/report still serves the report when Claude Code is not ready", async () => {
    ctx.claudeCode = { status: "missing", message: "Claude Code CLI not found.", checkedAt: 1 };
    const res = await authed(`${base}/hygiene/report`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { hygieneReady: boolean }).hygieneReady, false);
});

test("POST /hygiene/scan delegates with the local store and threshold, without needing Claude Code", async () => {
    ctx.claudeCode = { status: "unauthenticated", message: "Not logged in.", checkedAt: 1 };
    const res = await postJson(`${base}/hygiene/scan`, { threshold: 0.9 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), scanResult);
    assert.equal(calls.scans[0].store, fakeMemoryStore);
    assert.equal(calls.scans[0].threshold, 0.9);

    await postJson(`${base}/hygiene/scan`, { threshold: "0.5" });
    assert.equal(calls.scans[1].threshold, undefined, "a non-numeric threshold is ignored");
});

test("POST /hygiene/start kicks off a run and /hygiene/status reports it", async () => {
    const res = await postJson(`${base}/hygiene/start`, { model: "haiku", threshold: 0.8 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { started: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls.runs[0].options, { model: "haiku", threshold: 0.8 });
    assert.equal(calls.runs[0].store, fakeMemoryStore);

    const status = await authed(`${base}/hygiene/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { state: "done", judged: 3, failed: 0, total: 3 });
});

for (const state of [
    { status: "missing" as const, message: "Claude Code CLI not found.", checkedAt: 1 },
    { status: "unauthenticated" as const, message: "Claude Code is not logged in.", checkedAt: 1 },
    { status: "error" as const, checkedAt: 1 },
]) {
    test(`POST /hygiene/start answers 400 when Claude Code is ${state.status}`, async () => {
        ctx.claudeCode = state;
        const res = await postJson(`${base}/hygiene/start`);
        assert.equal(res.status, 400);
        const { error } = (await res.json()) as { error: string };
        assert.match(error, /^Memory hygiene needs Claude Code\. /);
        assert.ok(error.includes(state.message ?? `Claude Code status: ${state.status}.`), error);
        assert.equal(calls.runs.length, 0);
    });
}

test("POST /hygiene/start answers 400 while the Claude Code check is still running", async () => {
    ctx.claudeCode = { status: "checking" };
    const res = await postJson(`${base}/hygiene/start`);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /Memory hygiene is waiting for the Claude Code check/);
    assert.equal(calls.runs.length, 0);
});

test("POST /hygiene/start returns 409 while a run is in progress", async () => {
    running = true;
    const res = await postJson(`${base}/hygiene/start`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "A hygiene run is already in progress." });
    assert.equal(calls.runs.length, 0);
});

test("Claude Code readiness is checked before the in-progress 409", async () => {
    running = true;
    ctx.claudeCode = { status: "missing", message: "Claude Code CLI not found.", checkedAt: 1 };
    assert.equal((await postJson(`${base}/hygiene/start`)).status, 400);
});

test("POST /hygiene/cancel cancels only a live run", async () => {
    const idle = await authed(`${base}/hygiene/cancel`, { method: "POST" });
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), { cancelled: false });
    assert.equal(calls.cancels, 0);

    running = true;
    const live = await authed(`${base}/hygiene/cancel`, { method: "POST" });
    assert.deepEqual(await live.json(), { cancelled: true });
    assert.equal(calls.cancels, 1);
});

test("POST /hygiene/apply deletes the given ids via the backend and validates the body", async () => {
    const res = await postJson(`${base}/hygiene/apply`, { ids: ["a", "b"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: 2 });
    assert.deepEqual(calls.applies[0].ids, ["a", "b"]);
    assert.equal(calls.applies[0].backend, fakeStore);

    for (const body of [{}, { ids: [] }, { ids: ["a", ""] }, { ids: "a" }, { ids: [1] }]) {
        const bad = await postJson(`${base}/hygiene/apply`, body);
        assert.equal(bad.status, 400, JSON.stringify(body));
        assert.deepEqual(await bad.json(), { error: "'ids' must be a non-empty array of strings." });
    }
    assert.equal(calls.applies.length, 1);
});

test("POST /hygiene/apply works while Claude Code is not ready (it is a human-approved delete)", async () => {
    ctx.claudeCode = { status: "missing", checkedAt: 1 };
    assert.equal((await postJson(`${base}/hygiene/apply`, { ids: ["x"] })).status, 200);
});

test("POST /hygiene/dismiss records dismissals and validates the body", async () => {
    const res = await postJson(`${base}/hygiene/dismiss`, { clusterIds: ["c1", "c2", "c3"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { dismissed: 3 });
    assert.deepEqual(calls.dismissals[0], ["c1", "c2", "c3"]);

    const empty = await postJson(`${base}/hygiene/dismiss`, { clusterIds: [] });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: "'clusterIds' must be a non-empty array of strings." });
});

test("scan and start answer 400 when the store is not the local LanceDB store", async () => {
    const other = await startServer({
        store: { importRecords: async () => ({ imported: 0, failed: 0, errors: [] }) } as unknown as MemoryBackend,
    });
    try {
        for (const route of ["/hygiene/scan", "/hygiene/start"]) {
            const res = await postJson(`${other.base}${route}`);
            assert.equal(res.status, 400, route);
            assert.deepEqual(await res.json(), { error: "Memory hygiene needs the local memory store." });
        }
        assert.equal(calls.scans.length + calls.runs.length, 0);
    } finally {
        await other.close();
    }
});

test("hygiene routes answer 503 needsInstall when no store is mounted", async () => {
    const bare = await startServer({ store: null, isModelInstalled: () => false });
    try {
        for (const [method, route] of [["GET", "/hygiene/report"], ["POST", "/hygiene/start"], ["POST", "/hygiene/apply"]]) {
            const res = await authed(`${bare.base}${route}`, { method, ...(method === "POST" && { body: "{}" }) });
            assert.equal(res.status, 503, route);
            assert.deepEqual(await res.json(), { error: INSTALL_HINT, needsInstall: true });
        }
    } finally {
        await bare.close();
    }
});

// ---------------------------------------------------------------------------
// End to end with a real HygieneManager, a real local store and a fake judge
// ---------------------------------------------------------------------------

const DIM = 16;

function vectorize(text: string): number[] {
    const vec: number[] = new Array(DIM).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        vec[hash % DIM] += 1;
    }
    return vec;
}

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return "Fake"; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: vectorize(text), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((text) => ({ vector: vectorize(text), dimension: DIM }));
    }
}

class FakeJudge implements Judge {
    readonly model = "haiku";
    clusters: JudgeMemberInput[][] = [];
    async judge(members: JudgeMemberInput[]): Promise<HygieneFinding[]> {
        this.clusters.push(members);
        const [newest, ...older] = [...members].sort((a, b) => b.updatedAt - a.updatedAt);
        return [
            { memoryId: newest.memoryId, verdict: "keep", confidence: "high" },
            ...older.map((member): HygieneFinding => ({
                memoryId: member.memoryId,
                verdict: "duplicate",
                supersededBy: newest.memoryId,
                confidence: "high",
            })),
        ];
    }
}

test("hygiene end to end: scan, judge, report, apply and dismiss through the sidecar", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-hygiene-e2e-"));
    const backend = new LocalMemoryBackend({
        embedding: new FakeEmbedding(),
        vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(dir, "lance") }),
        blobStore: new FileBlobStore(path.join(dir, "blobs")),
    });
    const older = await backend.save({ content: "release signing uses the developer id certificate in the keychain" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await backend.save({ content: "release signing uses the developer id certificate in the keychain" });
    await backend.save({ content: "postgres backups run nightly at two via cron on the database host" });

    const judge = new FakeJudge();
    const models: Array<string | undefined> = [];
    const manager = new HygieneManager({
        reportStore: new HygieneReportStore({ rootDir: dir }),
        createJudge: (model) => { models.push(model); return judge; },
    });
    const real = await startServer({ store: backend, hygieneManager: manager });
    try {
        const scan = (await (await postJson(`${real.base}/hygiene/scan`, { threshold: 0.95 })).json()) as HygieneScanResult;
        assert.equal(scan.memoryCount, 3);
        assert.equal(scan.clusters.length, 1);
        assert.deepEqual(scan.clusters[0].members.map((m) => m.memoryId).sort(), [older.id, newer.id].sort());
        assert.deepEqual(scan.estimates.map((e) => e.model), ["haiku"]);
        assert.equal(judge.clusters.length, 0, "scanning makes no model calls");

        assert.equal((await postJson(`${real.base}/hygiene/start`, { threshold: 0.95 })).status, 200);
        let status: HygieneProgress | undefined;
        for (let i = 0; i < 100; i++) {
            status = (await (await authed(`${real.base}/hygiene/status`)).json()) as HygieneProgress;
            if (status.state === "done" || status.state === "failed") break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.deepEqual(status, { state: "done", judged: 1, failed: 0, total: 1 });
        assert.deepEqual(models, [undefined]);

        const { report } = (await (await authed(`${real.base}/hygiene/report`)).json()) as { report: HygieneReport };
        assert.equal(report.model, "haiku");
        const finding = report.clusters[0].findings!.find((f) => f.memoryId === older.id)!;
        assert.equal(finding.verdict, "duplicate");
        assert.equal(finding.supersededBy, newer.id);

        const applied = await postJson(`${real.base}/hygiene/apply`, { ids: [older.id] });
        assert.deepEqual(await applied.json(), { deleted: 1 });
        assert.equal(await backend.get(older.id), null);
        assert.notEqual(await backend.get(newer.id), null);
        const afterApply = (await (await authed(`${real.base}/hygiene/report`)).json()) as { report: HygieneReport };
        assert.deepEqual(afterApply.report.deletedIds, [older.id]);

        const clusterId = report.clusters[0].clusterId;
        assert.deepEqual(await (await postJson(`${real.base}/hygiene/dismiss`, { clusterIds: [clusterId] })).json(), { dismissed: 1 });
    } finally {
        await real.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
