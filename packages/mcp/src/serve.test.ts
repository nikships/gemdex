import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { LanceDBVectorDatabase, MemoryStore, Embedding, EmbeddingVector } from "gemdex-core";
import { createServer } from "./serve.js";

const DIM = 16;

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;
    async detectDimension(): Promise<number> { return DIM; }
    getDimension(): number { return DIM; }
    getProvider(): string { return "Fake"; }
    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: this.vectorize(text), dimension: DIM };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({ vector: this.vectorize(t), dimension: DIM }));
    }
    private vectorize(text: string): number[] {
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
    server = createServer(store);
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
