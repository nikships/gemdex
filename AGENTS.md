# Gemdex

## Architecture boundaries

```text
Local agent -> mcp stdio ------> core MemoryStore -> MLX + LanceDB
macOS app --> mcp serve -------> core shared HTTP router -> LocalMemoryBackend

Remote agent -> mcp-http --/v1--> server -> Postgres/pgvector + Gemini
Browser ------> web BFF ---/v1--> server -> core shared HTTP router
```

- `packages/mcp` is local-only: on-device BGE-M3 embeddings via `MlxEmbedding`,
  shared storage with the desktop sidecar, and Claude Code inference for
  ingestion/hygiene. Do not wire it to the self-hosted pool.
- `packages/server` owns self-hosted Gemini embedding (including multimodal)
  and uploaded-session digestion. `mcp-http` and `web` call its `/v1` API,
  not the npx package. These Python services cannot import TypeScript core.
- `MemoryBackend` is the shared storage interface. Core's `LocalMemoryBackend`
  wraps `MemoryStore`; server's `PostgresMemoryBackend` implements it for BYOI.
  Fix shared data-route behavior in `packages/core/src/http/http-api.ts`
  (`handleMemoryApiRequest`), mounted by both server and sidecar.
- Retrieval ranks chunks but resolves to whole parent memories. MCP `recall`
  is a title index; `get_memory` opens bodies. Do not conflate MCP output with
  the full-parent HTTP recall response.
- Stdio exposes seven tools, including `delete_memory`; HTTP MCP exposes six
  and deliberately omits delete. Human managers have explicit delete flows.
- Outcome stats are a separate per-client ledger, not memory rows.
  Trust re-ranking belongs in MCP, not core's relevance-only retrieval.
- `packages/app` is a maintenance-only SwiftUI client over localhost.
  Keep it working, do not delete it, and land general self-hosted management
  features in `packages/web`. Describe desktop behavior through the
  [sidecar contract](packages/mcp/AGENTS.md#sidecar-contract).

## Read by task

Read the relevant package instructions before working in its subtree. Ancestor
rules also apply; a nested file overrides only conflicting rules.

| Task | Instructions |
|------|--------------|
| Storage, embeddings, migration, inference | [core](packages/core/AGENTS.md) |
| Stdio tools, CLI, local sidecar | [mcp](packages/mcp/AGENTS.md) |
| BYOI auth, Postgres, migrations | [server](packages/server/AGENTS.md) |
| HTTP MCP, OAuth, digest import route | [mcp-http](packages/mcp-http/AGENTS.md) |
| Browser manager and upload BFF | [web](packages/web/AGENTS.md) |
| Native macOS client | [app](packages/app/AGENTS.md) |

For deployment changes, read [deploy](deploy/README.md) and
[operations](docs/BYOI_OPERATIONS.md). For wire changes, read the
[/v1 contract](docs/BYOI_REMOTE_MODE.md). Update
[security notes](docs/SECURITY_SELFHOST.md) and
[chat-history paths](docs/CHAT_HISTORY.md) when auth, exposure, or ingestion
behavior changes; they cite implementation paths.

## Repository constraints

- MCP stdout carries JSON-RPC. Diagnostics go to stderr; the sidecar's
  `PORT=<n> TOKEN=<hex>` handshake is its deliberate raw stdout output.
- Local processes share `~/.gemdex` (LanceDB in `lance`, attachments in `blobs`).
  Use isolated fixtures in tests, not the user's pool.
- TS: prefer `??` over `||`; never add `eslint-disable`. Required configuration
  fails explicitly rather than silently choosing a broken default.
- Root manifests require Node ≥24 and pnpm ≥10. CI currently tests Node 20/22;
  do not mistake that matrix for the supported runtime declaration.
- From the repo root, the full gate is `pnpm lint && pnpm typecheck && pnpm build && pnpm -r test`.
  CI ordering and service prerequisites are in `.github/workflows/ci.yml`.
  Python packages have separate checks in their own instructions.
- `pnpm-workspace.yaml` pins the Jest family to `30.3.0` and allows the native
  `@lancedb/lancedb` install build. Do not unpin casually.
- BYOI integration is `packages/server/integration/byoi.mjs`, invoked from the
  root with `pnpm test:byoi` after building. It requires a dedicated disposable
  pgvector database via `BYOI_TEST_DATABASE_URL`; it exercises `/v1` HTTP
  directly, not local MCP or the sidecar.
