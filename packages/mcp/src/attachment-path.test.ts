import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { AttachmentValidationError } from "gemdex-core";
import { resolveAttachmentInputs } from "./attachment-path.js";

let tmp: string;

function fixture(name: string, contents: string | Buffer): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, contents);
    return file;
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-att-"));
});

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("reads text and JSON files into base64 with mimeType inferred from the extension", async () => {
    const cases: Array<[string, string]> = [
        ["notes.txt", "text/plain"],
        ["config.json", "application/json"],
        ["session.jsonl", "application/x-ndjson"],
        ["events.ndjson", "application/x-ndjson"],
        ["UPPER.JSON", "application/json"],
    ];
    for (const [name, mimeType] of cases) {
        const body = `contents of ${name}`;
        const [attachment] = await resolveAttachmentInputs([{ path: fixture(name, body), caption: name }]);
        assert.equal(attachment.mimeType, mimeType, name);
        assert.equal(attachment.caption, name);
        assert.equal(Buffer.from(attachment.data, "base64").toString("utf8"), body);
        assert.equal((attachment as { path?: string }).path, undefined, "the path never reaches the store");
    }
});

test("resolves file:// URLs and paths relative to the working directory", async () => {
    const file = fixture("url.txt", "from a file url");
    const [fromUrl] = await resolveAttachmentInputs([{ path: pathToFileURL(file).href }]);
    assert.equal(Buffer.from(fromUrl.data, "base64").toString("utf8"), "from a file url");

    const [fromRelative] = await resolveAttachmentInputs([{ path: path.relative(process.cwd(), file) }]);
    assert.equal(fromRelative.data, fromUrl.data);
});

test("honors an explicit mimeType override for a path attachment", async () => {
    const [attachment] = await resolveAttachmentInputs([{ path: fixture("log.data", "k=v"), mimeType: "text/plain" }]);
    assert.equal(attachment.mimeType, "text/plain");
});

test("infers image, audio and video mimeTypes from the extension", async () => {
    const cases: Array<[string, string]> = [
        ["shot.png", "image/png"],
        ["photo.webp", "image/webp"],
        ["memo.m4a", "audio/mp4"],
        ["take.flac", "audio/flac"],
        ["demo.mov", "video/quicktime"],
        ["talk.webm", "video/webm"],
    ];
    for (const [name, mimeType] of cases) {
        const [attachment] = await resolveAttachmentInputs([{ path: fixture(name, "bytes") }]);
        assert.equal(attachment.mimeType, mimeType, name);
    }
});

test("passes inline base64 data through untouched", async () => {
    const data = Buffer.from("hello").toString("base64");
    const [attachment] = await resolveAttachmentInputs([{ mimeType: "text/plain", data, caption: "c" }]);
    assert.deepEqual(attachment, { mimeType: "text/plain", data, caption: "c" });
});

test("rejects an attachment carrying both data and path", async () => {
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: fixture("both.txt", "x"), data: "abc", mimeType: "text/plain" }]),
        (err: unknown) => err instanceof AttachmentValidationError && /exactly one/.test((err as Error).message),
    );
});

test("rejects an invalid file:// URL with a clear validation error", async () => {
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: "file://%%not-a-url" }]),
        (err: unknown) => err instanceof AttachmentValidationError && /Invalid file:\/\/ URL/.test((err as Error).message),
    );
});

test("rejects a missing file", async () => {
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: path.join(tmp, "missing.txt") }]),
        (err: unknown) => err instanceof AttachmentValidationError && /file not found/.test((err as Error).message),
    );
});

test("rejects a path with an unknown extension and no explicit mimeType", async () => {
    const file = fixture("archive.zip", "hi");
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: file }]),
        (err: unknown) => err instanceof AttachmentValidationError
            && /could not infer mimeType/.test((err as Error).message)
            && /\.txt/.test((err as Error).message)
            && /\.m4a/.test((err as Error).message)
            && !/\.pdf/.test((err as Error).message),
    );
});

test("rejects an oversized file via stat before reading", async () => {
    const file = path.join(tmp, "big.txt");
    // One byte over the 100 MiB local per-attachment ceiling; sparse so the test stays fast.
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, 100 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: file }]),
        (err: unknown) => err instanceof AttachmentValidationError && /per-attachment limit/.test((err as Error).message),
    );
});

test("resolves a directory path to a not-a-file error", async () => {
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: tmp, mimeType: "text/plain" }]),
        (err: unknown) => err instanceof AttachmentValidationError && /is not a file/.test((err as Error).message),
    );
});

test("reports the failing attachment's position", async () => {
    await assert.rejects(
        () => resolveAttachmentInputs([{ path: fixture("ok.txt", "ok") }, { path: path.join(tmp, "nope.txt") }]),
        (err: unknown) => err instanceof AttachmentValidationError && /Attachment #2/.test((err as Error).message),
    );
});
