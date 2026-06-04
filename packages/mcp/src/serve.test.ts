import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { LanceDBVectorDatabase, MemoryStore, Embedding, EmbeddingVector, FileBlobStore } from "gemdex-core";
import type { EmbeddingContent } from "gemdex-core";
import { createServer } from "./serve.js";

const DIM = 16;

function vectorize(text: string): number[] {
    const vec: number[] = [];
    for (let i = 0; i < DIM; i++) vec.push(0);
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

class FakeMultimodalEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return "FakeMultimodal"; }
    isMultimodal(): boolean { return true; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: vectorize(text), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: vectorize(t), dimension: DIM }));
    }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return contents.map((c) => {
            const seed = typeof c === "string" ? c : `${c.inlineData.mimeType}:${c.inlineData.data}`;
            return { vector: vectorize(seed), dimension: DIM };
        });
    }
}

let tmpDir: string;
let server: ReturnType<typeof createServer>;
let base: string;

async function json(res: Response): Promise<any> {
    return res.json();
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-test-"));
    const db = new LanceDBVectorDatabase({ uri: tmpDir });
    const store = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db });
    // No token/allowedOrigin — backward-compat mode (existing tests unchanged).
    server = createServer({ config: {} as any, store });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GET /health returns ok", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
});

test("GET /config reports configured when a store is present", async () => {
    const res = await fetch(`${base}/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { configured: true });
});

test("data routes answer 503 needsKey when no store is configured", async () => {
    const bare = createServer({ config: {} as any, store: null });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const addr = bare.address() as AddressInfo;
    const bareBase = `http://127.0.0.1:${addr.port}`;
    try {
        const cfg = await fetch(`${bareBase}/config`);
        assert.deepEqual(await cfg.json(), { configured: false });

        const res = await fetch(`${bareBase}/memories`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { needsKey?: boolean };
        assert.equal(body.needsKey, true);
    } finally {
        await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
});

test("CRUD lifecycle: create, list, get, update, delete", async () => {
    // create
    const createRes = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "remember the deploy token xyz", title: "Deploy" }),
    });
    assert.equal(createRes.status, 201);
    const { memory } = await json(createRes);
    assert.ok(memory.id);
    assert.equal(memory.title, "Deploy");

    // list
    const listRes = await fetch(`${base}/memories`);
    const { memories } = await json(listRes);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, memory.id);
    assert.ok(memories[0].preview.includes("deploy token"));

    // get
    const getRes = await fetch(`${base}/memories/${memory.id}`);
    assert.equal(getRes.status, 200);
    const fetched = (await json(getRes)).memory;
    assert.equal(fetched.content, "remember the deploy token xyz");

    // update
    const updateRes = await fetch(`${base}/memories/${memory.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "updated token abc", title: "Deploy v2" }),
    });
    assert.equal(updateRes.status, 200);
    const updated = (await json(updateRes)).memory;
    assert.equal(updated.content, "updated token abc");
    assert.equal(updated.title, "Deploy v2");

    // delete
    const delRes = await fetch(`${base}/memories/${memory.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const afterList = (await json(await fetch(`${base}/memories`))).memories;
    assert.equal(afterList.length, 0);
});

test("export then import round-trips memories", async () => {
    await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "alpha memory" }),
    });
    const exportRes = await fetch(`${base}/export`);
    const { records } = await json(exportRes);
    assert.ok(records.length >= 1);

    const importRes = await fetch(`${base}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
    });
    assert.equal(importRes.status, 200);
    const result = await json(importRes);
    assert.ok(result.imported >= 1);
});

test("create requires non-empty content", async () => {
    const res = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "   " }),
    });
    assert.equal(res.status, 400);
});

test("get on unknown id returns 404", async () => {
    const res = await fetch(`${base}/memories/does-not-exist`);
    assert.equal(res.status, 404);
});

test("POST /recall returns matching memories by text query", async () => {
    await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "kafka retry backoff strategy notes", title: "Kafka" }),
    });
    const res = await fetch(`${base}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "kafka retry backoff", limit: 5 }),
    });
    assert.equal(res.status, 200);
    const { results } = await json(res);
    assert.ok(Array.isArray(results));
    assert.ok(results.some((r: any) => r.title === "Kafka"));
});

test("POST /recall with neither query nor attachments returns 400", async () => {
    const res = await fetch(`${base}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
});

test("create with neither content nor attachments returns 400", async () => {
    const res = await fetch(`${base}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
});

test("multimodal: create with an attachment, then fetch its raw bytes", async () => {
    const mmDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-mm-db-"));
    const mmBlobDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-mm-blob-"));
    const db = new LanceDBVectorDatabase({ uri: mmDbDir });
    const mmStore = new MemoryStore({
        embedding: new FakeMultimodalEmbedding(),
        vectorDatabase: db,
        blobStore: new FileBlobStore(mmBlobDir),
    });
    const mmServer = createServer({ config: {} as any, store: mmStore });
    await new Promise<void>((resolve) => mmServer.listen(0, "127.0.0.1", resolve));
    const addr = mmServer.address() as AddressInfo;
    const mmBase = `http://127.0.0.1:${addr.port}`;
    try {
        const data = Buffer.from("PNGBYTES").toString("base64");
        const createRes = await fetch(`${mmBase}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "ui mock", attachments: [{ mimeType: "image/png", data, caption: "home" }] }),
        });
        assert.equal(createRes.status, 201);
        const { memory } = await json(createRes);
        assert.equal(memory.attachments.length, 1);
        assert.equal(memory.attachments[0].mimeType, "image/png");

        const attId = memory.attachments[0].id;
        const blobRes = await fetch(`${mmBase}/memories/${memory.id}/attachments/${attId}`);
        assert.equal(blobRes.status, 200);
        assert.equal(blobRes.headers.get("content-type"), "image/png");
        const buf = Buffer.from(await blobRes.arrayBuffer());
        assert.equal(buf.toString(), "PNGBYTES");

        const missing = await fetch(`${mmBase}/memories/${memory.id}/attachments/nope`);
        assert.equal(missing.status, 404);

        // recall-by-media: the same bytes embed to the same vector, so a
        // media-only /recall finds the memory it was attached to.
        const recallRes = await fetch(`${mmBase}/recall`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ attachments: [{ mimeType: "image/png", data }] }),
        });
        assert.equal(recallRes.status, 200);
        const { results } = await json(recallRes);
        assert.ok(results.some((r: any) => r.id === memory.id));
    } finally {
        await new Promise<void>((resolve) => mmServer.close(() => resolve()));
        fs.rmSync(mmDbDir, { recursive: true, force: true });
        fs.rmSync(mmBlobDir, { recursive: true, force: true });
    }
});

test("PATCH /memories/:id/attachments updates a caption, 404 missing, 400 bad body", async () => {
    const mmDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-cap-db-"));
    const mmBlobDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-cap-blob-"));
    const db = new LanceDBVectorDatabase({ uri: mmDbDir });
    const mmStore = new MemoryStore({
        embedding: new FakeMultimodalEmbedding(),
        vectorDatabase: db,
        blobStore: new FileBlobStore(mmBlobDir),
    });
    const mmServer = createServer({ config: {} as any, store: mmStore });
    await new Promise<void>((resolve) => mmServer.listen(0, "127.0.0.1", resolve));
    const addr = mmServer.address() as AddressInfo;
    const mmBase = `http://127.0.0.1:${addr.port}`;
    try {
        const data = Buffer.from("CAPBYTES").toString("base64");
        const createRes = await fetch(`${mmBase}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "ui mock", attachments: [{ mimeType: "image/png", data, caption: "old" }] }),
        });
        assert.equal(createRes.status, 201);
        const { memory } = await json(createRes);
        const attId = memory.attachments[0].id;

        // happy path: 200 with the updated caption
        const okRes = await fetch(`${mmBase}/memories/${memory.id}/attachments`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captions: [{ id: attId, caption: "new caption" }] }),
        });
        assert.equal(okRes.status, 200);
        const updated = (await json(okRes)).memory;
        assert.equal(updated.attachments[0].caption, "new caption");

        // 404 for an unknown memory id
        const missingRes = await fetch(`${mmBase}/memories/does-not-exist/attachments`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captions: [{ id: "0", caption: "x" }] }),
        });
        assert.equal(missingRes.status, 404);

        // 400 for a malformed body (captions not an array)
        const badRes = await fetch(`${mmBase}/memories/${memory.id}/attachments`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captions: "nope" }),
        });
        assert.equal(badRes.status, 400);

        // 405 for a non-PATCH method on the attachments collection path
        const wrongMethod = await fetch(`${mmBase}/memories/${memory.id}/attachments`, { method: "POST" });
        assert.equal(wrongMethod.status, 405);
    } finally {
        await new Promise<void>((resolve) => mmServer.close(() => resolve()));
        fs.rmSync(mmDbDir, { recursive: true, force: true });
        fs.rmSync(mmBlobDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Token enforcement tests
// ---------------------------------------------------------------------------

/** Spin up an isolated server with a specific token (and no allowedOrigin check
 *  so these tests work from any origin — Node fetch has no Origin header). */
async function withTokenServer(
    token: string,
    fn: (base: string) => Promise<void>,
): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-auth-"));
    const db = new LanceDBVectorDatabase({ uri: dir });
    const store = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db });
    const srv = createServer({ config: {} as any, store, token });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        await fn(srvBase);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const TOKEN_CHAR = "a"; const TEST_TOKEN = TOKEN_CHAR.repeat(64); // 64-char hex-like test token

test("token: GET /health is accessible without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/health`);
        assert.equal(res.status, 200);
    });
});

test("token: GET /config is accessible without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/config`);
        assert.equal(res.status, 200);
    });
});

test("token: POST /config is accessible without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        // Posting a bogus key is fine; we only care about the auth gate here.
        const res = await fetch(`${b}/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: "not-a-real-key" }),
        });
        // 200 or 500 — either way the request was not blocked by the token gate.
        assert.ok(res.status !== 401, `expected non-401, got ${res.status}`);
    });
});

test("token: data route without token returns 401", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`);
        assert.equal(res.status, 401);
    });
});

test("token: data route with wrong token returns 401", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, {
            headers: { "X-Gemdex-Token": "b".repeat(64) },
        });
        assert.equal(res.status, 401);
    });
});

test("token: data route with correct token succeeds", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, {
            headers: { "X-Gemdex-Token": TEST_TOKEN },
        });
        assert.equal(res.status, 200);
        const { memories: list } = await res.json() as any;
        assert.ok(Array.isArray(list));
    });
});

test("token: OPTIONS preflight is allowed without a token", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, { method: "OPTIONS" });
        assert.equal(res.status, 204);
    });
});

test("token: CORS headers include X-Gemdex-Token in Allow-Headers", async () => {
    await withTokenServer(TEST_TOKEN, async (b) => {
        const res = await fetch(`${b}/memories`, { method: "OPTIONS" });
        const allow = res.headers.get("access-control-allow-headers") ?? "";
        assert.ok(allow.toLowerCase().includes("x-gemdex-token"), `allow-headers: ${allow}`);
    });
});

test("origin: request with mismatched Origin header returns 403", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-serve-origin-"));
    const db = new LanceDBVectorDatabase({ uri: dir });
    const store = new MemoryStore({ embedding: new FakeEmbedding(), vectorDatabase: db });
    const srv = createServer({
        config: {} as any,
        store,
        token: TEST_TOKEN,
        allowedOrigin: "zero://app",
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const addr = srv.address() as AddressInfo;
    const srvBase = `http://127.0.0.1:${addr.port}`;
    try {
        // A request with a foreign Origin header must be rejected.
        const res = await fetch(`${srvBase}/health`, {
            headers: { "Origin": "https://evil.example.com" },
        });
        assert.equal(res.status, 403);

        // A request with no Origin header (same-origin / CLI) must pass.
        const healthRes = await fetch(`${srvBase}/health`);
        assert.equal(healthRes.status, 200);
    } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
