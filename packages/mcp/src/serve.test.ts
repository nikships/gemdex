import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as httpServer } from "node:http";
import {
    Embedding,
    EmbeddingVector,
    FileBlobStore,
    LanceDBVectorDatabase,
    LocalMemoryBackend,
    MLX_MODEL,
    createMemoryApiHandler,
} from "gemdex-core";
import type { ClaudeCodeReadiness, MemoryBackend } from "gemdex-core";
import { ClientConfigStore } from "./cli-config.js";
import { createConfig } from "./config.js";
import { INSTALL_HINT } from "./memory.js";
import { createServer, ServeContext } from "./serve.js";

const DIM = 16;

function vectorize(text: string): number[] {
    const vec: number[] = new Array(DIM).fill(0);
    let total = 0;
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        vec[hash % DIM] += 1;
        total += 1;
    }
    if (total === 0) vec[0] = 1;
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
        return texts.map((t) => ({ vector: vectorize(t), dimension: DIM }));
    }
}

function makeLocalStore(dir: string): LocalMemoryBackend {
    return new LocalMemoryBackend({
        embedding: new FakeEmbedding(),
        vectorDatabase: new LanceDBVectorDatabase({ uri: path.join(dir, "lance") }),
        blobStore: new FileBlobStore(path.join(dir, "blobs")),
    });
}

const READY: ClaudeCodeReadiness = { status: "ready", version: "2.1.0", path: "/opt/claude", checkedAt: 1 };

interface Harness {
    base: string;
    ctx: ServeContext;
    root: string;
    close: () => Promise<void>;
}

/**
 * Start a sidecar with hermetic defaults: temp client root, no installed
 * model, and a fake Claude Code probe, so no test touches ~/.gemdex, MLX or
 * the real claude binary.
 */
async function startServer(overrides: Partial<ServeContext> = {}): Promise<Harness> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-"));
    const ctx: ServeContext = {
        config: createConfig(() => undefined),
        store: null,
        clientConfigStore: new ClientConfigStore({ rootDir: path.join(root, "gemdex") }),
        isModelInstalled: () => false,
        checkClaudeCode: async () => READY,
        ...overrides,
    };
    const server = createServer(ctx);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        base,
        ctx,
        root,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

async function json(res: Response): Promise<any> {
    return res.json();
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
}

let savedHome: string | undefined;
let fakeHome: string;
let shared: Harness;

before(async () => {
    // Preset folders and default stores resolve from HOME; keep them in a temp dir.
    savedHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-home-"));
    process.env.HOME = fakeHome;
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-store-"));
    shared = await startServer({ store: makeLocalStore(storeDir), claudeCode: READY });
    const close = shared.close;
    shared.close = async () => {
        await close();
        fs.rmSync(storeDir, { recursive: true, force: true });
    };
});

after(async () => {
    await shared.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /health and /config
// ---------------------------------------------------------------------------

test("GET /health returns ok", async () => {
    const res = await fetch(`${shared.base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
});

test("GET /config reports store, local model and Claude Code status", async () => {
    const res = await fetch(`${shared.base}/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), {
        configured: true,
        embedding: { installed: false, model: MLX_MODEL, status: "not-installed" },
        claudeCode: READY,
    });
});

test("GET /config has no Gemini or remote fields", async () => {
    const body = await json(await fetch(`${shared.base}/config`));
    assert.deepEqual(Object.keys(body).sort(), ["claudeCode", "configured", "embedding"]);
    assert.doesNotMatch(JSON.stringify(body), /gemini|needsKey|"remote|"mode"|activeRemote/i);
});

test("the Claude Code probe starts on boot and /config reports checking until it resolves", async () => {
    let release!: (readiness: ClaudeCodeReadiness) => void;
    let calls = 0;
    const h = await startServer({
        checkClaudeCode: () => {
            calls += 1;
            return new Promise((resolve) => { release = resolve; });
        },
    });
    try {
        assert.equal(calls, 1, "createServer starts the probe");
        const checking = await json(await fetch(`${h.base}/config`));
        assert.deepEqual(checking.claudeCode, { status: "checking" });

        release({ status: "unauthenticated", message: "Not logged in.", path: "/opt/claude", checkedAt: 5 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const settled = await json(await fetch(`${h.base}/config`));
        assert.deepEqual(settled.claudeCode, { status: "unauthenticated", message: "Not logged in.", path: "/opt/claude", checkedAt: 5 });
        assert.equal(calls, 1, "GET /config never re-probes");
    } finally {
        await h.close();
    }
});

test("POST /config/check shares one in-flight probe and then re-probes on demand", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await startServer({
        claudeCode: { status: "missing", message: "not found", checkedAt: 1 },
        checkClaudeCode: async () => {
            calls += 1;
            await gate;
            return { ...READY, checkedAt: calls };
        },
    });
    try {
        assert.equal(calls, 0, "a pre-seeded state skips the boot probe");
        const first = fetch(`${h.base}/config/check`, { method: "POST" });
        const second = fetch(`${h.base}/config/check`, { method: "POST" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual((await json(await fetch(`${h.base}/config`))).claudeCode, {
            status: "checking", message: "not found", checkedAt: 1,
        });
        release();
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(calls, 1);
        assert.equal((await json(a)).claudeCode.status, "ready");
        assert.equal((await json(b)).claudeCode.status, "ready");

        const again = await fetch(`${h.base}/config/check`, { method: "POST" });
        assert.equal((await json(again)).claudeCode.checkedAt, 2);
        assert.equal(calls, 2);
    } finally {
        release();
        await h.close();
    }
});

test("a throwing Claude Code probe is reported as an error, not a crash", async () => {
    const h = await startServer({
        claudeCode: { status: "missing", checkedAt: 1 },
        checkClaudeCode: async () => { throw new Error("spawn EACCES"); },
    });
    try {
        const res = await fetch(`${h.base}/config/check`, { method: "POST" });
        assert.equal(res.status, 200);
        const { claudeCode } = await json(res);
        assert.equal(claudeCode.status, "error");
        assert.equal(claudeCode.message, "spawn EACCES");
        assert.equal(typeof claudeCode.checkedAt, "number");
    } finally {
        await h.close();
    }
});

test("GET /config reflects a running local model job", async () => {
    const h = await startServer({
        claudeCode: READY,
        localModelJob: { installed: false, model: MLX_MODEL, status: "installing", message: "Downloading" },
    });
    try {
        const body = await json(await fetch(`${h.base}/config`));
        assert.equal(body.configured, false);
        assert.deepEqual(body.embedding, { installed: false, model: MLX_MODEL, status: "installing", message: "Downloading" });
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// 503 needsInstall and store mounting
// ---------------------------------------------------------------------------

test("data routes answer 503 needsInstall until the local model is installed", async () => {
    const h = await startServer({ claudeCode: READY });
    try {
        const config = await json(await fetch(`${h.base}/config`));
        assert.equal(config.configured, false);
        assert.equal(config.embedding.status, "not-installed");

        for (const [method, route] of [
            ["GET", "/memories"],
            ["POST", "/recall"],
            ["GET", "/export"],
            ["GET", "/ingest/sources"],
            ["GET", "/hygiene/report"],
        ]) {
            const res = await fetch(`${h.base}${route}`, { method, ...(method === "POST" && { body: "{}" }) });
            assert.equal(res.status, 503, `${method} ${route}`);
            assert.deepEqual(await json(res), { error: INSTALL_HINT, needsInstall: true });
        }
        // Local model settings stay reachable so the app can offer the install.
        assert.equal((await fetch(`${h.base}/settings/embedding`)).status, 200);
    } finally {
        await h.close();
    }
});

test("a model installed while the sidecar runs mounts the store on the next request", async () => {
    let installed = false;
    let built = 0;
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-mount-"));
    const backend = makeLocalStore(storeDir);
    const h = await startServer({
        claudeCode: READY,
        isModelInstalled: () => installed,
        createBackend: () => { built += 1; return backend; },
    });
    try {
        assert.equal((await fetch(`${h.base}/memories`)).status, 503);
        assert.equal(built, 0);

        installed = true;
        // /health is answered before the mount check and never builds a store.
        assert.equal((await fetch(`${h.base}/health`)).status, 200);
        assert.equal(built, 0);

        const res = await fetch(`${h.base}/memories`);
        assert.equal(res.status, 200);
        assert.deepEqual(await json(res), { memories: [] });
        assert.equal(built, 1);
        assert.equal(h.ctx.store, backend);
        assert.equal((await json(await fetch(`${h.base}/config`))).configured, true);
        assert.equal(built, 1, "the store is built once");
    } finally {
        await h.close();
        fs.rmSync(storeDir, { recursive: true, force: true });
    }
});

test("the store is not auto-mounted while a local model job is running", async () => {
    let built = 0;
    const h = await startServer({
        claudeCode: READY,
        isModelInstalled: () => true,
        createBackend: () => { built += 1; return {} as MemoryBackend; },
        localModelJob: { installed: true, model: MLX_MODEL, status: "migrating" },
    });
    try {
        const res = await fetch(`${h.base}/memories`);
        assert.equal(res.status, 503);
        assert.equal((await json(res)).needsInstall, true);
        assert.equal(built, 0);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Removed routes
// ---------------------------------------------------------------------------

test("Gemini key and remote-mode routes are gone", async () => {
    for (const [method, route] of [
        ["POST", "/config"],
        ["POST", "/config/validate"],
        ["GET", "/settings"],
        ["POST", "/settings/remotes"],
        ["DELETE", "/settings/remotes/prod"],
        ["POST", "/settings/mode"],
        ["POST", "/settings/test"],
        ["POST", "/settings/import-local"],
        ["POST", "/settings/embedding/provider"],
        ["POST", "/ingest/collect"],
    ]) {
        const res = await fetch(`${shared.base}${route}`, {
            method,
            headers: { "Content-Type": "application/json" },
            ...(method !== "GET" && { body: JSON.stringify({ apiKey: "AIza-x", mode: "remote" }) }),
        });
        assert.equal(res.status, 404, `${method} ${route}`);
    }
});

// ---------------------------------------------------------------------------
// Core memory routes through the sidecar
// ---------------------------------------------------------------------------

test("CRUD lifecycle: create, list, get, update, delete", async () => {
    const createRes = await post(`${shared.base}/memories`, { content: "remember the deploy token xyz", title: "Deploy" });
    assert.equal(createRes.status, 201);
    const { memory } = await json(createRes);
    assert.ok(memory.id);
    assert.equal(memory.title, "Deploy");

    const { memories } = await json(await fetch(`${shared.base}/memories`));
    assert.ok(memories.some((m: any) => m.id === memory.id && m.preview.includes("deploy token")));

    const getRes = await fetch(`${shared.base}/memories/${memory.id}`);
    assert.equal(getRes.status, 200);
    assert.equal((await json(getRes)).memory.content, "remember the deploy token xyz");

    const updateRes = await fetch(`${shared.base}/memories/${memory.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "updated token abc", title: "Deploy v2" }),
    });
    assert.equal(updateRes.status, 200);
    const updated = (await json(updateRes)).memory;
    assert.equal(updated.content, "updated token abc");
    assert.equal(updated.title, "Deploy v2");

    const delRes = await fetch(`${shared.base}/memories/${memory.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal((await fetch(`${shared.base}/memories/${memory.id}`)).status, 404);
});

test("export then import round-trips memories", async () => {
    await post(`${shared.base}/memories`, { content: "alpha memory" });
    const { records } = await json(await fetch(`${shared.base}/export`));
    assert.ok(records.length >= 1);

    const importRes = await post(`${shared.base}/import`, { records });
    assert.equal(importRes.status, 200);
    assert.ok((await json(importRes)).imported >= 1);
});

test("import rejects a missing records array", async () => {
    const res = await post(`${shared.base}/import`, {});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid payload: 'records' must be an array" });
});

test("create requires content or an attachment", async () => {
    assert.equal((await post(`${shared.base}/memories`, { content: "   " })).status, 400);
    assert.equal((await post(`${shared.base}/memories`, {})).status, 400);
});

test("invalid JSON body returns 400", async () => {
    const res = await fetch(`${shared.base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid JSON body" });
});

test("get on unknown id returns 404", async () => {
    assert.equal((await fetch(`${shared.base}/memories/does-not-exist`)).status, 404);
});

test("POST /recall returns matching memories by text query", async () => {
    await post(`${shared.base}/memories`, { content: "kafka retry backoff strategy notes", title: "Kafka" });
    const res = await post(`${shared.base}/recall`, { query: "kafka retry backoff", limit: 5 });
    assert.equal(res.status, 200);
    const { results } = await json(res);
    assert.ok(results.some((r: any) => r.title === "Kafka"));
});

test("POST /recall with neither query nor attachments returns 400", async () => {
    assert.equal((await post(`${shared.base}/recall`, {})).status, 400);
});

test("POST /recall by media is rejected: the local model is text-only", async () => {
    const res = await post(`${shared.base}/recall`, {
        attachments: [{ mimeType: "image/png", data: Buffer.from("PNGBYTES").toString("base64") }],
    });
    assert.equal(res.status, 400);
    assert.match((await json(res)).error, /Recall by media is not supported/);
});

test("media attachments are rejected on create", async () => {
    for (const mimeType of ["image/png", "image/jpeg", "audio/mpeg", "video/mp4", "application/pdf"]) {
        const res = await post(`${shared.base}/memories`, {
            content: `a memory with ${mimeType}`,
            attachments: [{ mimeType, data: Buffer.from("MEDIABYTES").toString("base64") }],
        });
        assert.equal(res.status, 400, mimeType);
        const { error } = await json(res);
        assert.ok(
            error.includes(`${mimeType} attachments are not supported`) || /could not be parsed as a valid PDF/.test(error),
            `${mimeType}: ${error}`,
        );
    }
    const { memories } = await json(await fetch(`${shared.base}/memories`));
    assert.equal(memories.some((m: any) => /a memory with/.test(m.preview)), false);
});

test("text and JSON attachments are stored as blobs and served back", async () => {
    const note = "plain text notes";
    const config = JSON.stringify({ region: "us-east-1" });
    const createRes = await post(`${shared.base}/memories`, {
        content: "deploy settings with attached files",
        attachments: [
            { mimeType: "text/plain", data: Buffer.from(note).toString("base64"), caption: "notes" },
            { mimeType: "application/json", data: Buffer.from(config).toString("base64"), caption: "config" },
        ],
    });
    assert.equal(createRes.status, 201);
    const { memory } = await json(createRes);
    assert.deepEqual(memory.attachments.map((a: any) => [a.kind, a.mimeType, a.caption]), [
        ["file", "text/plain", "notes"],
        ["file", "application/json", "config"],
    ]);

    const textRes = await fetch(`${shared.base}/memories/${memory.id}/attachments/${memory.attachments[0].id}`);
    assert.equal(textRes.status, 200);
    assert.equal(textRes.headers.get("content-type"), "text/plain");
    assert.equal(textRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await textRes.text(), note);

    const jsonRes = await fetch(`${shared.base}/memories/${memory.id}/attachments/${memory.attachments[1].id}`);
    assert.equal(jsonRes.headers.get("content-type"), "application/json");
    assert.equal(await jsonRes.text(), config);

    assert.equal((await fetch(`${shared.base}/memories/${memory.id}/attachments/nope`)).status, 404);
});

test("update rejects media attachments and keeps the existing memory intact", async () => {
    const created = await json(await post(`${shared.base}/memories`, {
        content: "memory that must survive a bad update",
        attachments: [{ mimeType: "text/plain", data: Buffer.from("keep me").toString("base64") }],
    }));
    const id = created.memory.id;
    const res = await fetch(`${shared.base}/memories/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments: [{ mimeType: "image/png", data: Buffer.from("PNG").toString("base64") }] }),
    });
    assert.equal(res.status, 400);
    const after = (await json(await fetch(`${shared.base}/memories/${id}`))).memory;
    assert.equal(after.content, "memory that must survive a bad update");
    assert.deepEqual(after.attachments.map((a: any) => a.mimeType), ["text/plain"]);
});

test("PATCH /memories/:id/attachments updates a caption, 404 missing, 400 bad body, 405 wrong method", async () => {
    const created = await json(await post(`${shared.base}/memories`, {
        content: "caption target",
        attachments: [{ mimeType: "text/plain", data: Buffer.from("CAPBYTES").toString("base64"), caption: "old" }],
    }));
    const { memory } = created;
    const attId = memory.attachments[0].id;

    const okRes = await fetch(`${shared.base}/memories/${memory.id}/attachments`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captions: [{ id: attId, caption: "new caption" }] }),
    });
    assert.equal(okRes.status, 200);
    assert.equal((await json(okRes)).memory.attachments[0].caption, "new caption");

    const missingRes = await fetch(`${shared.base}/memories/does-not-exist/attachments`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captions: [{ id: "0", caption: "x" }] }),
    });
    assert.equal(missingRes.status, 404);

    const badRes = await fetch(`${shared.base}/memories/${memory.id}/attachments`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captions: "nope" }),
    });
    assert.equal(badRes.status, 400);

    assert.equal((await fetch(`${shared.base}/memories/${memory.id}/attachments`, { method: "POST" })).status, 405);
});

test("shared memory API handler mounts data routes without the sidecar /config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-shared-api-"));
    const srv = httpServer(createMemoryApiHandler({
        store: makeLocalStore(dir),
        corsHeaders: { "Access-Control-Allow-Origin": "https://server.example.test" },
    }));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const srvBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
        assert.equal((await fetch(`${srvBase}/config`)).status, 404);

        const preflight = await fetch(`${srvBase}/memories`, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "https://server.example.test");
        assert.ok((preflight.headers.get("access-control-allow-headers") ?? "").includes("X-Gemdex-Token"));

        const createRes = await post(`${srvBase}/memories`, { content: "shared handler memory notarize build with signing identity" });
        assert.equal(createRes.status, 201);

        // Save-time similar-memory detection surfaces the first memory on a near-duplicate.
        const duplicate = await json(await post(`${srvBase}/memories`, {
            content: "shared handler memory notarize build with signing identity tool",
        }));
        assert.ok(Array.isArray(duplicate.memory.similar) && duplicate.memory.similar.length > 0);
        assert.ok(duplicate.memory.similar[0].similarity >= 0.9);

        assert.equal((await json(await fetch(`${srvBase}/memories`))).memories.length, 2);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("attachment bytes force download for non-allowlisted mime metadata", async () => {
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected store call"); };
    const store: MemoryBackend = {
        save: unexpected,
        recall: unexpected,
        update: unexpected,
        updateAttachmentCaptions: unexpected,
        get: unexpected,
        list: unexpected,
        delete: unexpected,
        exportAll: unexpected,
        importRecords: unexpected,
        readAttachment: async () => ({
            data: Buffer.from("<html></html>"),
            mimeType: "text/html",
            byteLength: Buffer.byteLength("<html></html>"),
        }),
    };
    const srv = httpServer(createMemoryApiHandler({ store }));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const srvBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
        const res = await fetch(`${srvBase}/memories/memory-id/attachments/attachment-id`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/octet-stream");
        assert.equal(res.headers.get("content-disposition"), "attachment");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
});

// ---------------------------------------------------------------------------
// Token and origin enforcement
// ---------------------------------------------------------------------------

const TEST_TOKEN = "a".repeat(64);

async function withTokenServer(fn: (base: string) => Promise<void>, overrides: Partial<ServeContext> = {}): Promise<void> {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-auth-"));
    const h = await startServer({ store: makeLocalStore(storeDir), token: TEST_TOKEN, claudeCode: READY, ...overrides });
    try {
        await fn(h.base);
    } finally {
        await h.close();
        fs.rmSync(storeDir, { recursive: true, force: true });
    }
}

test("token: /health, GET /config and POST /config/check need no token", async () => {
    await withTokenServer(async (b) => {
        assert.equal((await fetch(`${b}/health`)).status, 200);
        assert.equal((await fetch(`${b}/config`)).status, 200);
        assert.equal((await fetch(`${b}/config/check`, { method: "POST" })).status, 200);
    });
});

test("token: data, settings, ingest and hygiene routes reject a missing or wrong token", async () => {
    await withTokenServer(async (b) => {
        for (const [method, route] of [
            ["GET", "/memories"],
            ["POST", "/recall"],
            ["GET", "/export"],
            ["GET", "/settings/embedding"],
            ["POST", "/settings/embedding/install"],
            ["POST", "/settings/embedding/migrate"],
            ["GET", "/ingest/sources"],
            ["POST", "/ingest/start"],
            ["GET", "/hygiene/report"],
            ["POST", "/hygiene/start"],
            ["GET", "/no-such-route"],
        ]) {
            const missing = await fetch(`${b}${route}`, { method });
            assert.equal(missing.status, 401, `${method} ${route} without token`);
            const wrong = await fetch(`${b}${route}`, { method, headers: { "X-Gemdex-Token": "b".repeat(64) } });
            assert.equal(wrong.status, 401, `${method} ${route} with wrong token`);
            const short = await fetch(`${b}${route}`, { method, headers: { "X-Gemdex-Token": "a" } });
            assert.equal(short.status, 401, `${method} ${route} with a different-length token`);
        }
    });
});

test("token: the token gate runs before the needsInstall gate", async () => {
    await withTokenServer(async (b) => {
        assert.equal((await fetch(`${b}/memories`)).status, 401);
        const authed = await fetch(`${b}/memories`, { headers: { "X-Gemdex-Token": TEST_TOKEN } });
        assert.equal(authed.status, 503);
    }, { store: null });
});

test("token: data route with the correct token succeeds", async () => {
    await withTokenServer(async (b) => {
        const res = await fetch(`${b}/memories`, { headers: { "X-Gemdex-Token": TEST_TOKEN } });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray((await json(res)).memories));
    });
});

test("token: OPTIONS preflight is allowed without a token and advertises X-Gemdex-Token", async () => {
    await withTokenServer(async (b) => {
        const res = await fetch(`${b}/memories`, { method: "OPTIONS" });
        assert.equal(res.status, 204);
        const allow = res.headers.get("access-control-allow-headers") ?? "";
        assert.ok(allow.toLowerCase().includes("x-gemdex-token"), `allow-headers: ${allow}`);
    });
});

test("origin: a mismatched Origin is rejected on every route; absent or matching Origin passes", async () => {
    await withTokenServer(async (b) => {
        for (const route of ["/health", "/config", "/memories"]) {
            const res = await fetch(`${b}${route}`, {
                headers: { Origin: "https://evil.example.com", "X-Gemdex-Token": TEST_TOKEN },
            });
            assert.equal(res.status, 403, route);
        }
        const preflight = await fetch(`${b}/memories`, { method: "OPTIONS", headers: { Origin: "https://evil.example.com" } });
        assert.equal(preflight.status, 403);

        assert.equal((await fetch(`${b}/health`)).status, 200);
        const matching = await fetch(`${b}/memories`, { headers: { Origin: "zero://app", "X-Gemdex-Token": TEST_TOKEN } });
        assert.equal(matching.status, 200);
        assert.equal(matching.headers.get("access-control-allow-origin"), "zero://app");
    }, { allowedOrigin: "zero://app" });
});
