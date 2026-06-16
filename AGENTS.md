# AGENTS.md — Gemdex (system map)

Repo-root reference for coding agents. This file is the **map**: how the four
packages fit together and where the hard problems live. Each package has its own
`AGENTS.md` explaining its internals — read the relevant one before editing
code there. The closest `AGENTS.md` wins.

## What Gemdex is

A **global, persistent memory layer for AI coding agents**. An agent explicitly
saves a memory once and recalls it across every repo, session, and machine.
Retrieval is the **parent-document ("small-to-big")** pattern: content is
chunked and embedded for sharp matching (hybrid dense + BM25 fused with
Reciprocal Rank Fusion), but recall always returns the **whole parent memory,
never a fragment**.

## The one architectural idea to hold in your head

**All memory logic lives in `gemdex-core`. Everything else is a thin shell.**

```
                 ┌──────────────────────────────────────────────┐
                 │  gemdex-core  (the engine)                    │
                 │  • MemoryStore: chunk → embed → store →       │
                 │    recall → resolve to whole parent           │
                 │  • GeminiEmbedding (multimodal)               │
                 │  • LanceDBVectorDatabase (dense + BM25 + RRF) │
                 │  • handleMemoryApiRequest  ← shared HTTP API  │
                 │  • MemoryBackend: Local ⇄ Remote (same iface) │
                 └──────────────────────────────────────────────┘
                    ▲              ▲                        ▲
        depends on  │              │ depends on             │ depends on
   ┌────────────────┴───┐   ┌──────┴───────────────┐   the same shared
   │ gemdex-mcp         │   │ gemdex-server        │   HTTP router is
   │ (client surface)   │   │ (BYOI backend)       │   mounted by BOTH
   │ • MCP stdio tools  │   │ • node:http + /v1    │   mcp's `serve`
   │ • `gemdex serve`   │   │ • Postgres/pgvector  │   sidecar AND the
   │   localhost sidecar│   │ • file/S3 blobs      │   server
   │ • remote-mode CLI  │   │ • server-side embed  │
   └────────────────────┘   └──────────────────────┘
              ▲
              │ spawns sidecar over localhost (PORT/TOKEN handshake)
   ┌──────────┴──────────┐
   │ packages/app        │
   │ native SwiftUI mac  │
   │ (thin HTTP client)  │
   └─────────────────────┘
```

Two facts that explain most of the codebase:

1. **`gemdex-core/src/http/http-api.ts` (`handleMemoryApiRequest`) is the single
   memory HTTP API**, mounted verbatim by *both* the `gemdex serve` sidecar (in
   `mcp`) and the BYOI `server`. Fix a memory-route bug there, not in either
   shell.
2. **`MemoryBackend` has two interchangeable impls** — `LocalMemoryBackend`
   (embeds client-side via Gemini + LanceDB) and `RemoteMemoryBackend` (HTTP to
   a BYOI server, which embeds). Callers are written once and swapped by
   `GEMDEX_MODE`. Remote-mode clients need **no `GEMINI_API_KEY`**.

## Packages

| Package | Name | What it is | Read |
|---------|------|------------|------|
| `packages/core` | `gemdex-core` | The engine: chunking + parent-document recall, embeddings, LanceDB hybrid+RRF, the shared HTTP router, the backend interface. | [core/AGENTS.md](packages/core/AGENTS.md) |
| `packages/mcp` | `gemdex-mcp` | One binary, three modes: MCP stdio tools, the `gemdex serve` localhost sidecar, the remote-mode CLI. | [mcp/AGENTS.md](packages/mcp/AGENTS.md) |
| `packages/server` | `gemdex-server` | Self-hosted BYOI backend: thin `node:http` shell (`/v1`, auth, CORS, migrations) over Postgres/pgvector + file/S3 blobs, server-side embedding. | [server/AGENTS.md](packages/server/AGENTS.md) |
| `packages/app` | — | Native SwiftUI macOS manage-only app; spawns the sidecar and is a thin HTTP client. Swift, not TS. | [app/AGENTS.md](packages/app/AGENTS.md) |

`plugin/` is the Claude Code plugin (the `memory` skill + manifest). `docs/` holds
the BYOI operations guide and the remote-mode wire contract.

## Cross-cutting mechanics (where to look)

- **Save → recall pipeline** (chunking, attachments-as-rows, two RRF layers,
  embed-before-delete): `gemdex-core` → [core/AGENTS.md](packages/core/AGENTS.md).
- **Local vs remote** (per-process via `GEMDEX_MODE`; pools never merge; copy via
  `import-local-to-remote`): mcp + core.
- **The shared store** lives at `~/.gemdex` (LanceDB at `~/.gemdex/lance`, blob
  bytes at `~/.gemdex/blobs`, secrets in `~/.gemdex/.env` `0600`). The MCP
  process and the desktop sidecar share it, so a memory saved by one shows up in
  the other.
- **Sidecar handshake** (`PORT=<n> TOKEN=<hex>` on stdout; `127.0.0.1` + per-launch
  `X-Gemdex-Token`): mcp's `serve.ts` writes it, the app's `SidecarManager`
  reads it.
- **stdout is sacred in MCP mode** — it carries JSON-RPC frames; the handshake
  line is the one sanctioned raw-stdout write. See mcp.
- **BYOI wire contract / compat floor** (`/v1`, bearer auth, `minClientVersion`):
  server + [docs/BYOI_REMOTE_MODE.md](docs/BYOI_REMOTE_MODE.md).

## Four tools, no delete

The MCP surface is `save_memory`, `recall`, `update_memory`, and the read-only
`list_memories` (browse summaries newest-first, optional substring filter — for
orienting and getting exact ids; `recall` remains the relevance-ranked path).
**There is no agent delete tool by design** — deletion is a deliberate human
action in the desktop app (the sidecar/core `DELETE /memories/:id` route exists;
the MCP tools deliberately don't expose it).

## Conventions (TS packages)

- TypeScript strict; **prefer `??` over `||`**; **never** add `eslint-disable`
  (fix the cause).
- **Required config fails fast at startup** — no silent fallback to a broken
  default.
- `packages/app` is Swift/SwiftUI — these rules don't apply there.

## Working in the monorepo

- pnpm workspace, Node ≥ 20, pnpm ≥ 10. `pnpm install` from the root.
- Per-package work: `pnpm --filter <name> <script>` (e.g. `build`, `dev`, `test`).
- Full local gate before pushing: `pnpm lint && pnpm typecheck && pnpm build &&
  pnpm -r test`. CI plan: `.github/workflows/ci.yml` (TS verify matrix +
  desktop-app build + BYOI Postgres integration + Docker compose smoke).
- `pnpm-workspace.yaml` pins the Jest family to `30.3.0` and lists
  `@lancedb/lancedb` under `onlyBuiltDependencies` (native build) — don't unpin
  casually.
