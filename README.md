<div align="center">

<img src="assets/logo-wordmark.jpg" alt="Gemdex, a memory layer for AI coding agents" width="780" />

### Persistent memory for AI coding agents

[![npm version](https://img.shields.io/npm/v/gemdex-mcp?color=cf6a4c&label=gemdex-mcp&logo=npm)](https://www.npmjs.com/package/gemdex-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-7a9e7e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-7a9e7e.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

Save a useful memory once and recall it across repos and sessions. Gemdex
indexes small chunks for precise hybrid semantic + BM25 matching, then resolves
matches to whole parent memories. MCP agents scan a cheap title index and open
only the memories they need.

## Two ways to run it

| | Local | Self-hosted |
|---|---|---|
| Agent connection | `npx gemdex-mcp`, stdio | Streamable HTTP `/mcp` |
| Embeddings | On-device BGE-M3 via MLX | Server-owned Gemini, including multimodal |
| Storage | LanceDB and blobs under `~/.gemdex` | Postgres/pgvector and file/S3 blobs |
| Platform | Apple Silicon, macOS 14+, native arm64 Node ≥24 | Docker host |
| Human management | Native macOS app via localhost sidecar | Web manager |
| Pool | One per machine | Shared across machines |
| MCP tools | Seven, including delete | Six, without delete |

These are separate pools. The npx package and desktop sidecar are local-only;
connect directly to HTTP MCP for a self-hosted pool.

## Local quickstart

```bash
npx gemdex-mcp install
claude mcp add gemdex -- npx -y gemdex-mcp@latest
```

The explicit install downloads managed Python/MLX and pinned
[`mlx-community/bge-m3-mlx-8bit`](https://huggingface.co/mlx-community/bge-m3-mlx-8bit)
weights, about 600 MB. No Python, uv, Homebrew, HF CLI, or compiler setup is
needed. Embeddings run offline after installation. There is no API key,
sentinel value, or provider switch. Rosetta Node is unsupported.
See [MLX model and runtime requirements](docs/MLX_MODELS.md).

All seven tools remain discoverable before installation and return setup
guidance. Retry a tool after installation, or reconnect your MCP client.

For another MCP client:

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

### Upgrade from Gemini-based releases

Run `npx gemdex-mcp migrate` after installation. It re-embeds legacy memories
from `memories` into `memories_mlx_bge_m3_8bit`, preserving text, titles,
timestamps and attachment bytes. Installation alone does not migrate.

Recall and hygiene refuse to run while legacy rows remain. List/get/update/
delete/export remain available after installation. Migration reports progress
and is rerunnable. Legacy media blobs remain readable but are not
media-searchable; back up your store before migrating.

### Save and recall

Ask your agent to save something durable:

```text
Save how we set up the review workflow to memory.
```

Then, in another session or repo using that pool:

```text
Check memory for our review workflow and use it here.
```

Tell your agent when to use memory in its instructions:

```markdown
## Memory

Use Gemdex recall to find relevant memories before starting work.
Recall returns titles and ids; use get_memory only for useful hits.
Save reusable findings and update existing memories when correcting them.
Report worked/failed/stale outcomes after acting on a fetched memory.
Use read_attachment for transcript bytes.
Delete only when a memory should be permanently removed and the connected
surface provides delete_memory.
```

## MCP tools

| Tool | Behavior |
|------|----------|
| `save_memory` | Save content and/or attachments; return id and title |
| `recall` | Text query, top 10 titles + ids, never full bodies |
| `get_memory` | Full parent body, age, attachments and track record |
| `update_memory` | Full `content` replacement or literal `edits`, optional title/attachments |
| `report_outcome` | Record `worked`, `failed`, or `stale`, with optional note |
| `read_attachment` | Attachment bytes as UTF-8 or base64 |
| `delete_memory` | Stdio only, permanent delete and client-stat cleanup |

`get_memory`, not title-index recall, increments recall counts.
Stats live in a separate ledger (`~/.gemdex/stats.json` by default).
`GEMDEX_TRUST_RANKING=true` enables outcome-weighted title ranking;
otherwise ranking is relevance-only.

Local saves include an advisory when existing memories are similar, using
already-computed vectors and centroid similarity (default threshold 0.90).
The advisory does not block the save. Configure it with
`GEMDEX_SIMILAR_ON_SAVE` and `GEMDEX_SIMILAR_THRESHOLD`.

### Attachments

Local attachments are text files only: `.txt`, `.json`, `.jsonl`/`.ndjson`.
Use a local `path` or inline base64 `data` + `mimeType`. Supported MIME types
are `text/plain`, `application/json`, `application/jsonl`,
`application/x-ndjson`, `text/x-jsonl`, up to four files per memory, 20 MiB each.
Bytes are non-embedded blobs, readable through `read_attachment`.
New images, audio, video, PDF and media recall queries are unsupported locally.

The self-hosted server supports Gemini multimodal embedding and media recall
through `/v1`. HTTP MCP attachment inputs are inline base64 only, never
client filesystem paths. See the [/v1 contract](docs/BYOI_REMOTE_MODE.md).

## Chat history and memory hygiene

Local digestion and hygiene use your existing Claude Code login. Install
Claude Code and run `claude auth login`, then:

```bash
npx gemdex-mcp status
npx gemdex-mcp ingest-history --source claude --dry-run
npx gemdex-mcp ingest-history --source claude
```

Sources include Claude Code, Factory CLI, Codex, Antigravity, or a folder path.
Only never-before-ingested sessions are processed. Each produces a digest
memory and a cleaned transcript attachment. `backfill-transcripts` attaches
files referenced by older digest footers, with `--dry-run` and `--force`
options; missing files are skipped with a message.

Inference runs as isolated `claude -p --model haiku` structured-JSON calls:
no tools, settings, skills, MCP servers, hooks, CLAUDE.md, or session
persistence, and a temporary working directory. Concurrency is four, with at
most three total attempts and a five-minute timeout per call.

Cost estimates are Haiku API list-price equivalents ($1 input / $5 output per
million tokens). With a Claude subscription, usage counts against plan limits,
not a per-token bill. Local embeddings stay on-device, but ingestion transcripts
and hygiene candidates go through Claude Code inference.

Hygiene first clusters local vectors, then judges candidates with Claude Code.
Deleting findings requires human approval. Self-hosted uploads instead use
the server's Gemini digestion. See [chat-history paths](docs/CHAT_HISTORY.md).

## The desktop app (maintenance-only)

The native macOS app manages the local pool through `gemdex serve`, which binds
only `127.0.0.1` and uses a per-launch token. Its contract exposes explicit MLX
install/migration jobs and Claude Code readiness. Memory routes return
`503 {needsInstall:true}` until installation; ingestion/hygiene start requires
Claude Code readiness. See the [sidecar contract](packages/mcp/AGENTS.md#sidecar-contract).

The web manager is the primary human surface for self-hosted deployments.
The desktop app is not a client for that pool.

## Self-host the whole stack (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/nikships/gemdex/main/scripts/install.sh | bash
```

The installer starts Postgres, `gemdex-server`, HTTP MCP and the web manager,
generates secrets, waits for migrations, verifies a real save and recall, and
prints Streamable HTTP client configuration. It asks for a
[Google AI Studio key](https://aistudio.google.com/apikey), or reads
`GEMINI_API_KEY`. This key belongs to the server, not the agent client.

The default is loopback-only. `--lan` exposes MCP and web to your trusted LAN
with static MCP auth and login-free web access. For public access, use HTTPS,
Google OAuth, and the deployment guide. Never publish Postgres or `/v1`.

```json
{
  "mcpServers": {
    "gemdex": {
      "type": "http",
      "url": "https://gemdex.example.com/mcp"
    }
  }
}
```

This example targets a Google OAuth deployment; the client handles login.

| Guide | Purpose |
|-------|---------|
| [Self-host deploy](docs/SELF_HOST_DEPLOY.md) | Compose, Google OAuth, HTTPS edge and exposure checks |
| [Operations](docs/BYOI_OPERATIONS.md) | Storage, backup/restore, upgrades and troubleshooting |
| [Go further](docs/GO_FURTHER.md) | DNS, managed platforms, sizing and costs |
| [Security](docs/SECURITY_SELFHOST.md) | Enforced boundaries and pre-launch checklist |
| [Chat history](docs/CHAT_HISTORY.md) | Local ingestion, web upload and OAuth record import |

## Packages and library use

| Package | Responsibility |
|---------|----------------|
| [core](packages/core/README.md) | MemoryStore, embedding providers, shared HTTP router and inference |
| [mcp](packages/mcp/README.md) | Local stdio tools, CLI and desktop sidecar |
| [server](packages/server/README.md) | BYOI `/v1`, Postgres/pgvector, Gemini and file/S3 blobs |
| [mcp-http](packages/mcp-http/README.md) | Six-tool Streamable HTTP agent surface |
| [web](packages/web/README.md) | Browser manager and session-upload BFF |
| [app](packages/app/README.md) | Native local manager |

To use the engine directly, see the [core library example](packages/core/README.md#local-library-use).
Local environment settings are in the [MCP README](packages/mcp/README.md#environment);
self-hosted settings are in the [server README](packages/server/README.md#environment-variables).

## Privacy & safety

Memory text and attachment bytes are plaintext unless you add your own storage
controls. Gemdex provides no secret redaction or hosted custody service.
Local embeddings run on-device; local ingestion and hygiene send selected
content through Claude Code using your account. The self-hosted server sends
embedding payloads and uploaded-session digestion to Gemini using its key.
See [custody](docs/BYOI_OPERATIONS.md#security-and-custody) and
[self-host security](docs/SECURITY_SELFHOST.md).

## Build from source

From a clone with Node ≥24 and pnpm ≥10:

```bash
pnpm install
pnpm build
```

The local MCP entry point is `packages/mcp/dist/index.js`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and development guidance.

## License

MIT. See [LICENSE](LICENSE).

## MCP Registry

`mcp-name: io.github.nikships/gemdex`
