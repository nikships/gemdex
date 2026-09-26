# Chat-history ingestion

A chat memory contains a generated digest and a cleaned transcript as a
non-embedded `file` attachment. Only the digest text is embedded.

## Choose the destination first

| Path | Destination | Inference | Authentication |
|------|-------------|-----------|----------------|
| `npx gemdex-mcp ingest-history` or sidecar `/ingest/*` | This machine's LanceDB pool | Claude Code Haiku using the existing login | Local process or sidecar token |
| Web manager upload | Self-hosted Postgres pool | Gemini on `gemdex-server` | Manager session |
| `POST /mcp/sync/records` from an OAuth client | Self-hosted Postgres pool | Caller supplies already-digested records | HTTP MCP access token |
| Host-local transcript submission to `/v1/sessions/ingest` | Self-hosted Postgres pool | Gemini on `gemdex-server` | BYOI bearer, private HTTP |

Running the npx CLI on a deployment host still writes to that host's **local**
LanceDB pool. It does not select the self-hosted backend. For the self-hosted
pool, use web upload or a client of the private ingestion API.

## Local ingestion

Install the local model with `npx gemdex-mcp install`, then install Claude Code
and sign in with `claude auth login`.

```bash
npx gemdex-mcp status
npx gemdex-mcp ingest-history --source claude --dry-run
npx gemdex-mcp ingest-history --source claude
```

Repeat `--source` for `claude`, `factory`, `codex`, `antigravity`, or a custom
folder path. Without it, the CLI uses existing preset folders.

`packages/core/src/ingest/ingest-manager.ts` scans against the local
`~/.gemdex/ingest.json` ledger. Runs are permanently **new-sessions-only**:
ledger-known sessions are skipped even if changed. Scan diagnostics may show
those changes, but they are not eligible for digestion. Active and trivial
sessions are skipped. A dry run scans and estimates without inference.

Local ingestion and memory hygiene use
`packages/core/src/inference/claude-code.ts`: isolated
`claude -p --model haiku` with structured JSON output, no tools, user settings,
skills, MCP servers, hooks, CLAUDE.md or session persistence, and a temporary
cwd. The existing Claude Code login is retained. `checkClaudeCode()` returns
`ready | missing | unauthenticated | error` without a model call; the sidecar
adds `checking` while probing. `GEMDEX_CLAUDE_PATH` can select the binary.

Concurrency is four, with at most three total attempts per session/cluster
and a five-minute timeout per inference call. Cost estimates use Haiku API
list prices ($1 input / $5 output per million tokens). A Claude subscription
counts usage against plan limits rather than billing per token.
There is no batch-submit/collect workflow.

Sidecar `/ingest/start` and `/hygiene/start` return 400 until Claude Code is
ready. Ordinary memory operations require MLX installation, not Claude login.
See the [sidecar contract](../packages/mcp/AGENTS.md#sidecar-contract).

### Upgrade from Gemini-based releases

`npx gemdex-mcp migrate` re-embeds stored text into the MLX table; it does not
re-digest sessions or embed transcript bytes. Legacy rows block recall and
hygiene until migrated. To attach transcripts referenced only by a digest's
path footer, use `npx gemdex-mcp backfill-transcripts --dry-run`, then omit
`--dry-run` to write. Missing files are skipped with a message.

## Self-hosted web upload

The manager accepts `.jsonl` transcripts or `.zip` archives: up to 25 files,
24 MiB per file and 64 MiB per request. The web BFF decodes the form, expands
archives, and forwards raw transcripts to `POST /v1/sessions/ingest`.

`packages/server/src/session-ingest.ts` uses core's Gemini `SessionDigester`
and `ingestUploadedSessions`. The server owns `GEMINI_API_KEY`; browsers and
the web BFF do not. Uploaded files have no host path ledger. Each file returns
`ingested`, `skipped` (`unparseable` or `trivial`), or `failed`, independently.
Re-upload is allowed and upserts the same id.

For host-local automation, a private authenticated HTTP client can submit
`{"files":[{"filename":"session.jsonl","content":"<raw JSONL>"}]}` to
`/v1/sessions/ingest`. This endpoint accepts up to 25 files, with a
`40 * 1024 * 1024`-character per-file limit and 100 MiB request-body cap.
It does not scan folders itself.

## OAuth record import

`packages/mcp-http/src/gemdex_mcp_http/sync.py` exposes
`POST /mcp/sync/records` for clients that already have digested records.
Any authorized OAuth client can send `{"records":[...]}` with its HTTP MCP
bearer token. This is an HTTP route, not an MCP tool, and not an npx command.
In static-auth deployments it uses the configured static bearer instead.

The route verifies the token itself because FastMCP custom routes are
auth-exempt. It accepts at most 50 records per request, capped at 100 MiB;
ids must start with `chat:`. Unknown fields are dropped. It forwards to
BYOI `/v1/import`, which upserts by id. Keep it under `/mcp/` so the public
edge routes it to the authenticated MCP service.

## Shared ids, different ledger rules

All built-in digest paths derive `chat:<source>:<sessionId>`, share transcript
cleaning and digest rendering, and preserve source activity timestamps.
An OAuth record producer should use that same id convention.

Ids make repeated imports and uploads upsert rather than duplicate. They do
not make generated text byte-identical across models, or make local ingestion
reprocess ledger-known files. Upload uses a content-derived session id when
available and the filename stem otherwise; preserve filenames when relying
on the fallback.

The web history view derives its records from `chat:` memories, not a laptop's
ledger. `createdAt` and `updatedAt` mean session activity, not ingestion time.

## Read the transcript

Use `get_memory` to inspect attachments, then
`read_attachment(memory_id="chat:factory:<sessionId>")`. Omit
`attachment_id` when there is a single transcript. Both stdio and HTTP MCP
offer this tool; reading stored bytes does not invoke an embedding model.

For public setup, see [deployment](SELF_HOST_DEPLOY.md#upload-sessions-from-the-browser);
for backups and custody, see [operations](BYOI_OPERATIONS.md).
