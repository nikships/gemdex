# gemdex-mcp

Local memory for AI coding agents: on-device BGE-M3 embeddings via MLX,
embedded LanceDB, seven stdio MCP tools, and a localhost desktop sidecar.
Part of [Gemdex](https://github.com/nikships/gemdex).

## Install

Requires Node.js ≥24, native arm64 macOS 14+ (Apple Silicon, not Rosetta).

```bash
npx gemdex-mcp install
claude mcp add gemdex -- npx -y gemdex-mcp@latest
```

Installation explicitly downloads managed Python/MLX and pinned
`mlx-community/bge-m3-mlx-8bit` weights, about 600 MB. No preinstalled Python,
uv, Homebrew, compiler, or model tooling is needed. Embeddings run offline
after installation. There is no API key, provider switch, or remote backend
setting. Before installation all seven tools return setup guidance.

Other MCP clients can use:

```json
{
  "mcpServers": {
    "gemdex": {
      "command": "npx",
      "args": ["-y", "gemdex-mcp@latest"]
    }
  }
}
```

The local pool lives at `~/.gemdex/lance`, with attachment bytes at
`~/.gemdex/blobs`. For a shared self-hosted pool, connect your agent directly
to the [Streamable HTTP MCP endpoint](../mcp-http/README.md). The npx package
and desktop sidecar manage only the local pool.

### Upgrade from Gemini-based releases

After installation, run `npx gemdex-mcp migrate` to re-embed legacy `memories`
into `memories_mlx_bge_m3_8bit` (1024 dimensions). Installation alone does not
migrate. Progress is reported and migration is safe to rerun.

Recall and hygiene refuse to run while legacy rows remain, avoiding incomplete
results. List/get/update/delete/export remain available after installation.
Migration preserves text, titles, timestamps and attachment blobs. Legacy
media is readable but is not embedded or searchable as media.

## CLI

| Command | Purpose |
|---------|---------|
| `npx gemdex-mcp install` | Download and verify runtime/model |
| `npx gemdex-mcp migrate` | Re-embed legacy memories |
| `npx gemdex-mcp status` | Show model, legacy count, store and Claude Code readiness |
| `npx gemdex-mcp backfill-transcripts [--force] [--dry-run]` | Attach transcript files referenced by existing digest footers |
| `npx gemdex-mcp ingest-history [--source claude\|factory\|codex\|antigravity\|PATH]... [--model haiku] [--dry-run]` | Digest new local sessions |

Backfill skips missing files with a message. Ingestion defaults to detected
preset folders and processes only sessions absent from its successful-ingest
ledger. Changed sessions already in the ledger are skipped. `--dry-run`
scans and estimates; it does not call the model.

## Chat-history ingestion and hygiene

Install Claude Code and sign in with `claude auth login`. Gemdex uses that
existing login for isolated `claude -p --model haiku` structured-JSON calls:
no tools, user settings, skills, MCP servers, hooks, CLAUDE.md, or session
persistence, and a temporary working directory.

Local ingestion and hygiene use concurrency four, at most three total attempts,
and a five-minute timeout per inference call. Estimates use Haiku list prices
($1 input / $5 output per million tokens). With a Claude subscription, usage
counts against the plan's limits rather than being billed per token.
Readiness is `ready | missing | unauthenticated | error`; the sidecar also
reports `checking` during a probe.

The digest text is embedded locally; its cleaned transcript is stored as a
non-embedded attachment. See [ingestion paths](../../docs/CHAT_HISTORY.md) for
the distinction between local ingestion and server-side uploads.

## Tools

| Tool | Behavior |
|------|----------|
| `save_memory` | Save text and/or text-file attachments; return id and title |
| `recall` | Text query, fixed top-10 title index, never full bodies |
| `get_memory` | Open a full parent by id; increment recall stats |
| `update_memory` | Replace content or apply literal `edits`; preserve omitted fields |
| `report_outcome` | Record `worked`, `failed`, or `stale` in the client stats ledger |
| `read_attachment` | Read a memory's attachment bytes as UTF-8 or base64 |
| `delete_memory` | Permanently delete a memory and clear its client stats |

Prefer updates for corrections and delete only when the memory should be gone.
HTTP MCP is a separate six-tool surface without delete.

New local attachments are text files only: `.txt`, `.json`, `.jsonl`/`.ndjson`.
Pass a local `path` (preferred) or inline base64 `data` and `mimeType`.
Accepted MIME types: `text/plain`, `application/json`, `application/jsonl`,
`application/x-ndjson`, `text/x-jsonl`. The limit is four files per memory,
20 MiB each. File bytes are never embedded. Images, audio, video, PDF and media
recall queries are unsupported. Omitting attachments on update preserves them;
`attachments:[]` clears them.

## Desktop sidecar

`npx gemdex-mcp serve --port 0` starts the local HTTP API, bound to
`127.0.0.1`. The desktop app spawns it and reads the
`PORT=<n> TOKEN=<hex>` handshake. Model install/migration are explicit
asynchronous settings actions; Claude Code readiness gates ingestion/hygiene,
not ordinary memory reads. See the
[sidecar contract](AGENTS.md#sidecar-contract) for routes and status fields.

## Environment

| Variable | Purpose |
|----------|---------|
| `LANCEDB_PATH` | Override `~/.gemdex/lance` |
| `GEMDEX_CLAUDE_PATH` | Override Claude binary discovery for ingestion/hygiene |
| `HYBRID_MODE` | `false` disables BM25; default `true` |
| `GEMDEX_SERVE_PORT` | Sidecar port; default auto/0 |
| `GEMDEX_WEBVIEW_ORIGIN` | Allowed sidecar Origin; default `zero://app` |
| `GEMDEX_STATS_PATH` | Override `~/.gemdex/stats.json` |
| `GEMDEX_TRUST_RANKING` | `true` enables outcome-weighted title ranking |
| `GEMDEX_SIMILAR_ON_SAVE` | `false` disables similarity advisories |
| `GEMDEX_SIMILAR_THRESHOLD` | Similarity threshold in `(0,1]`, default 0.90 |

## MCP Registry

`mcp-name: io.github.nikships/gemdex`

## License

MIT
