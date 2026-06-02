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
- `packages/app` — zero-native desktop manager (Zig shell + web frontend).
  Browse/create/edit/delete/export/import. The Zig shell spawns/kills the Node
  sidecar; **no memory logic lives in Zig**.
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
  metadata, never ranking signals.
- **No guardrails by design.** Memories may store plaintext secrets; that's the
  user's choice. Don't add redaction/encryption/safety enforcement.

## Build & verify (pnpm workspace, Node ≥ 20)

```bash
pnpm install
pnpm build          # tsc build, all packages
pnpm typecheck
pnpm lint           # eslint; pnpm lint:fix to autofix
pnpm -r --if-present test   # 38 tests: 33 core (jest) + 5 mcp serve (node:test)
```

Always run typecheck + lint + tests before committing. The MCP entry point
builds to `packages/mcp/dist/index.js`.

### Desktop app (`packages/app`)

Needs **Zig 0.16** and the `zero-native` CLI/framework. You don't know
zero-native from general knowledge — load its skill first:
`npx zero-native skills get core --full` (and `automation` for smoke tests).
See `packages/app/README.md` for the shell↔sidecar handshake and CSP policy.

## Conventions

- TypeScript, ESM, 4-space indent, existing import style. Match surrounding code.
- Reuse the embedding + vectordb layers; don't reach around `MemoryStore` for
  store access.
- The sidecar binds **localhost only** (`127.0.0.1`), never `0.0.0.0`.
- Keep changes scoped; don't add speculative config.
