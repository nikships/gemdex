# gemdex-mcp

Local-only stdio MCP, CLI, and desktop sidecar. Core owns storage, embeddings,
inference, and shared data routes. Self-hosted agents use
[`mcp-http`](../mcp-http/AGENTS.md), a separate pool and transport.

## Entry points and ownership

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Both `gemdex` and `gemdex-mcp` bins; help, serve, CLI, then stdio dispatch; seven tool schemas |
| `src/handlers.ts` | Tool validation/rendering, partial content edits, attachment resolution, stats and trust ranking |
| `src/tool-names.ts` | Positional tool tuple, append rather than reorder |
| `src/config.ts` | Local config and help text |
| `src/memory.ts` | `LocalMemoryBackend` with `MlxEmbedding` and legacy-index access |
| `src/local-model.ts` | Shared CLI/sidecar install, status, migration orchestration |
| `src/onboarding.ts` | Setup guidance returned before tool handlers when MLX is absent |
| `src/cli-config.ts` | Local settings and custom ingest folders |
| `src/cli.ts` | `install`, `migrate`, `status`, `backfill-transcripts`, `ingest-history` |
| `src/serve.ts` | Loopback auth, configuration, model jobs, ingestion/hygiene routes |

`runCli` returns `null` for an unrecognized verb, falling through to MCP.
Add a verb to `CLI_COMMANDS` and its dispatch together. In stdio mode,
`console.log`/`console.warn` are redirected to stderr before other work.
Never write raw stdout in tool code. CLI output and the sidecar handshake run
outside the JSON-RPC mode.

`ClientConfigStore` preserves unknown configuration keys on rewrite. Keep that
behavior when editing ingest folders; do not delete settings owned by another
release. Its writes use temporary files and user-only permissions.

## Local model and migration

- `createMemoryBackend` always uses BGE-M3 via MLX. There is no provider
  selector, API-key sentinel, or network storage configuration.
- Installation is explicit (`npx gemdex-mcp install`), Apple Silicon only,
  about 600 MB for managed Python/MLX and pinned model weights. Normal inference
  never downloads. See [runtime constraints](../../docs/MLX_MODELS.md) before
  changing the installer.
- All seven tools remain discoverable before installation and return setup
  guidance without running handlers. Subsequent calls can see installation.
- **Upgrade from Gemini-based releases:** `npx gemdex-mcp migrate` re-embeds
  legacy `memories` into `memories_mlx_bge_m3_8bit`. Install does not migrate.
  Recall and hygiene refuse to run while legacy rows remain; list/get/update/
  delete/export remain available once the model is installed. Preserve legacy
  attachment bytes and timestamps. Do not compare vectors across these tables.
- New attachments are non-embedded `file` blobs only: `.txt`, `.json`,
  `.jsonl`/`.ndjson`. Accepted MIME types are `text/plain`, `application/json`,
  `application/jsonl`, `application/x-ndjson`, `text/x-jsonl`.
  Limit: four files per memory, 20 MiB each. A local `path` is preferred over
  inline base64 `data` + `mimeType`. New image/audio/video/PDF attachments and
  media recall queries are rejected. Legacy media can remain readable.

## Sidecar contract

Bind only `127.0.0.1`; emit `PORT=<n> TOKEN=<hex>` once on stdout.
`runServe` creates a random per-launch token, checked with `timingSafeEqual`.
Check Origin before routing (`GEMDEX_WEBVIEW_ORIGIN`, default `zero://app`;
absent Origin allowed), then preflight, public probes, and the token gate.
Do not treat Origin as a replacement for token authentication.

| Method | Path | Token | Behavior |
|--------|------|-------|----------|
| GET | `/health` | no | `{ok:true}` |
| GET | `/config` | no | `{configured, embedding, claudeCode}` |
| POST | `/config/check` | no | Await a fresh Claude Code probe, return config |
| GET | `/settings/embedding` | yes | Status, including `legacyMemories` when available |
| POST | `/settings/embedding/install` | yes | Explicit async install, 202 |
| POST | `/settings/embedding/migrate` | yes | Explicit async migration, 202 |
| GET | `/ingest/sources` | yes | Presets, custom folders, models, readiness |
| POST / DELETE | `/ingest/folders` | yes | Add/remove `{path}` |
| POST | `/ingest/scan` | yes | Scan `{sources}`, return estimate |
| POST | `/ingest/start` | yes | Start `{sources, model?}` |
| GET | `/ingest/status` | yes | Progress |
| POST | `/ingest/cancel` | yes | Cooperative cancel |
| GET | `/hygiene/report` | yes | Report, models, pricing, readiness |
| POST | `/hygiene/scan` | yes | Local clustering, optional `{threshold}` |
| POST | `/hygiene/start` | yes | Judge clusters, optional `{model, threshold}` |
| GET | `/hygiene/status` | yes | Progress |
| POST | `/hygiene/cancel` | yes | Cooperative cancel |
| POST | `/hygiene/apply` | yes | Delete human-approved `{ids}` |
| POST | `/hygiene/dismiss` | yes | Dismiss `{clusterIds}` |

Poll `GET /settings/embedding` for install/migration jobs. Status is
`not-installed | installed | installing | migrating | error`, with optional
`message`, `completed`, `total`, `legacyMemories`. A concurrent model job
returns 409; migration before installation returns 400.

`configured` means the store is mounted, not that inference or migration is
ready. Until installation, routes after model settings return
`503 {needsInstall:true, error}`. Claude readiness is
`checking | ready | missing | unauthenticated | error`; ingest/hygiene start
returns 400 unless ready, and 409 for an already-running job.

Data routes delegate to core: `GET|POST /memories`,
`GET|PUT|PATCH|DELETE /memories/:id`,
`GET /memories/:id/attachments/:attachmentId`,
`PATCH /memories/:id/attachments`, `POST /recall`, `GET /export`,
`POST /import`. Recall is text-only here. Body limits are 50 MiB by default,
100 MiB for attachment-bearing core routes; oversize is 413, invalid JSON 400.

## Inference and ingestion

Local ingestion and hygiene use core's `ClaudeCodeRunner`, not an API-key
client. Read [core instructions](../core/AGENTS.md#inference-and-ingestion)
before changing process isolation, model selection, or readiness.
`status` probes Claude Code; inject readiness and inference in tests rather
than launching the user's CLI.

History ingestion is permanently new-sessions-only. Changed ledger-known
sessions appear in diagnostics but cannot be selected for digestion. No batch
job/collect path exists. `backfill-transcripts` uses list + per-id get, not
`exportAll` (large inline transcripts can exceed V8 string limits).

## Tool invariants

- Handlers return readable `{content, isError:true}` on failure, never throw
  through the protocol.
- `recall(query)` returns a fixed top-10 title index, never bodies or media
  queries. `get_memory(id)` opens the full parent and increments recall stats.
- `update_memory` preserves omitted fields; `attachments:[]` clears them.
  `edits` and full `content` are mutually exclusive. Literal edits are applied
  after get, then update, so this read-modify-write is last-write-wins.
- `report_outcome` validates the id with get before touching the stats ledger.
  Stats failures degrade gracefully rather than breaking memory operations.
- `GEMDEX_TRUST_RANKING=true` over-fetches, applies a multiplier in `[0.6,1.4]`,
  reorders and slices to 10. Off means backend order unchanged. Core ranking
  stays pure relevance.
- Save-time similarity is core's responsibility; render `SaveResult.similar`
  without running detection again.
- `delete_memory` checks existence, deletes, then best-effort clears stats.
  Prefer updates for corrections; confirm with the user when deletion intent
  is unclear. Do not mirror delete into HTTP MCP automatically.
