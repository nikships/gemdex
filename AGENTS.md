# AGENTS.md — working on the Gemdex repo

Gemdex is a **global, persistent memory layer for AI coding agents**: explicit
`save_memory` / `recall` / `update_memory` over Gemini embeddings + an embedded
LanceDB hybrid (dense + BM25) store.

## Monorepo layout

- `packages/core` (`gemdex-core`) — engine. `GeminiEmbedding`,
  `LanceDBVectorDatabase` (hybrid + RRF), and `memory/` (the `MemoryStore` +
  parent-document chunker). No file-indexing.
- `packages/mcp` (`gemdex-mcp`) — MCP stdio server exposing the 3 tools, plus
  `serve.ts`, the localhost HTTP sidecar (`gemdex serve`) for the desktop app.
- `packages/app` — native **SwiftUI** macOS desktop manager (Apple Silicon).
  Browse/create/edit/delete/export/import. The Swift app spawns/kills the Node
  sidecar (`Services/SidecarManager.swift`); **no memory logic lives in the
  app**. Release builds bundle their own Node runtime + sidecar (zero user
  install) and ship Sparkle auto-updates (vendored `third_party/sparkle`,
  `macos/embed-sparkle.sh`) — see `packages/app/README.md`.
- `plugin/` — Claude Code plugin (the `memory` skill + manifest).

## The memory model (don't break these invariants)

- **One global pool.** No scopes, tags, or per-repo buckets. Embeddings do the
  disambiguation.
- **Parent-document chunking.** Long memories are split into chunks for sharp
  hybrid matching, but `recall` resolves chunk hits back to the **full parent
  memory and dedupes** — callers must never receive a fragment.
- **3 MCP tools only:** `save_memory`, `recall`, `update_memory`. There is **no
  delete tool** — deletion is a human action in the desktop app.
- **Pure-relevance ranking.** No recency/importance bias. Timestamps are
  metadata, never ranking signals. When `recall` combines branches (text + one
  per query attachment) they fuse via RRF — still scale-free, still
  relevance-only.
- **Recall by text and/or media.** `recall` accepts an optional `attachments`
  query (image/audio/video/PDF) embedded into the same `gemini-embedding-2`
  space; `query` is optional when media is supplied. The desktop app surfaces
  this only as recall-*by-example* ("Find similar" on an attachment) — there is
  still no free-text search box in the app.
- **Attachments by path or base64.** An attachment (on `save_memory` / `recall`
  / `update_memory`) is either inline base64 `data` or a local file `path`. Path
  resolution (read off disk + base64-encode, mimeType inferred from the
  extension) lives **only in the MCP stdio handlers** (`attachment-path.ts`);
  the HTTP sidecar and `MemoryStore` never read files by path. Per-attachment
  ceiling is 20 MB (inline base64 only — no Files API).
- **No guardrails by design.** Memories may store plaintext secrets; that's the
  user's choice. Don't add redaction/encryption/safety enforcement.

## Build & verify (pnpm workspace, Node ≥ 20)

```bash
pnpm install
pnpm build          # tsc build, all packages
pnpm typecheck
pnpm lint           # eslint; pnpm lint:fix to autofix
pnpm -r --if-present test   # 82 tests: 62 core (jest) + 20 mcp (node:test): serve + attachment-path
```

Always run typecheck + lint + tests before committing. The MCP entry point
builds to `packages/mcp/dist/index.js`. Note `eslint` only covers `**/*.ts`.

### Desktop app (`packages/app`)

Native **SwiftUI** app for macOS (Apple Silicon), built with SwiftPM — no
Xcode/`xcodebuild` required. `swift build -c release --arch arm64` compiles the
binary; `macos/build-app.sh` assembles the `.app` bundle (add `--with-sidecar`
to bundle the Node runtime + sidecar). It is **not** in the pnpm workspace.
See `packages/app/README.md` for the app↔sidecar handshake and signing flow.

### Live smoke-testing the sidecar / multimodal paths

The jest + `node:test` suites use a fake embedding. To exercise the real
`gemini-embedding-2` (e.g. attachments, `POST /recall` recall-by-media) end to
end, write a throwaway ESM script that drives `createServer` directly. Hard-won
gotchas so you don't repeat them:

- **Script location matters.** Node resolves bare specifiers like `gemdex-core`
  relative to the **script file's** directory, not your cwd. A script in
  `scripts/` or run via `node ../../foo.mjs` will fail `ERR_MODULE_NOT_FOUND`.
  Put the script **inside `packages/mcp/`** (where the workspace links live) and
  import the server with a relative path: `import { createServer } from "./dist/serve.js"`.
- **Build first.** It imports from `dist/`, so run `pnpm build` beforehand.
- **Never touch `~/.gemdex`.** Construct the store with a temp LanceDB dir and a
  `new FileBlobStore(tmpDir)` (the blob root is otherwise hardcoded to
  `~/.gemdex/blobs`), plus a real `new GeminiEmbedding({ apiKey, model: 'gemini-embedding-2' })`.
- **Use a real image.** Gemini rejects tiny 1×1 placeholder PNGs with
  `"Provided image is not valid"`. Use an actual file (e.g.
  `packages/app/assets/brand/logo-mark-256.png`).
- Needs `GEMINI_API_KEY` in the env. Clean up temp dirs and `rm` the throwaway
  script when done.

## Conventions

- TypeScript, ESM, 4-space indent, existing import style. Match surrounding code.
- Reuse the embedding + vectordb layers; don't reach around `MemoryStore` for
  store access.
- The sidecar binds **localhost only** (`127.0.0.1`), never `0.0.0.0`.
- Keep changes scoped; don't add speculative config.
