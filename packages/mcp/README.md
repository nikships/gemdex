# gemdex-mcp

MCP memory layer for AI coding agents — `save_memory` / `recall` /
`update_memory` backed by Gemini embeddings + embedded LanceDB.

Part of [Gemdex](https://github.com/anand-92/gemdex).

## Install for Claude Code

```bash
claude mcp add gemdex \
  -e GEMINI_API_KEY=your-key \
  -- npx -y gemdex-mcp@latest
```

No Docker, no daemon. Memories live at `~/.gemdex/lance` by default.

To use a self-hosted Gemdex Server instead, configure remote mode. The client
does not need `GEMINI_API_KEY`; embedding runs on the server:

```bash
claude mcp add gemdex \
  -e GEMDEX_MODE=remote \
  -e GEMDEX_REMOTE_URL=https://memory.example.com \
  -e GEMDEX_REMOTE_TOKEN=your-server-token \
  -- npx -y gemdex-mcp@latest
```

### Configure remotes with the CLI

The easiest path is `init-remote` — it adds the remote, prompts for the token
(without echoing it), verifies the server is reachable, authenticated, and
version-compatible, switches to remote mode, and prints the agent command:

```bash
npx gemdex init-remote production https://memory.example.com

# Also copy this machine's local memories into the server in the same step:
npx gemdex init-remote production https://memory.example.com --import-local
```

Or run the individual steps:

```bash
# Prompts for the bearer token without echoing it.
npx gemdex remote add production https://memory.example.com

npx gemdex remote list
npx gemdex mode remote production
npx gemdex status

# Return to the embedded local backend.
npx gemdex mode local

# Copy the local store to a named remote, preserving memory ids.
npx gemdex import-local-to-remote production
```

Named remotes live in `~/.gemdex/config.json`. Bearer tokens are stored
separately in `~/.gemdex/.env` with user-only file permissions and are never
printed. For automation, use `--token-stdin`; to manage the secret externally,
use `--token-env MY_TOKEN_VAR`.

### Local and remote at the same time

Mode is per process via `GEMDEX_MODE`, so you can register two MCP servers — one
local, one remote — as two independent memory pools that never merge:

```bash
claude mcp add gemdex-local \
  -e GEMDEX_MODE=local -e GEMINI_API_KEY=your-key \
  -- npx -y gemdex-mcp@latest

claude mcp add gemdex-remote \
  -e GEMDEX_MODE=remote \
  -e GEMDEX_REMOTE_URL=https://memory.example.com \
  -e GEMDEX_REMOTE_TOKEN=your-server-token \
  -- npx -y gemdex-mcp@latest
```

Pass `GEMDEX_MODE` per server (not `gemdex mode …`, which sets one shared mode).

## Install for any MCP client

```json
{
  "mcpServers": {
    "gemdex": {
      "command": "npx",
      "args": ["-y", "gemdex-mcp@latest"],
      "env": {
        "GEMINI_API_KEY": "your-key"
      }
    }
  }
}
```

See the [BYOI operations guide](../../docs/BYOI_OPERATIONS.md) for server
deployment, TLS, storage, backup/restore, upgrades, and troubleshooting.

## Tools

- `save_memory(content, title?)` — persist a new memory; returns its `id`.
- `recall(query, limit?)` — retrieve full memories by natural language (hybrid
  semantic + BM25), ranked by relevance. Never returns fragments.
- `update_memory(id, content, title?)` — revise an existing memory in place.

Deletion is intentionally **not** an agent tool — it's a human action in the
Gemdex desktop app.

## Desktop sidecar

The same binary also runs the localhost HTTP manager API used by the desktop app:

```bash
npx gemdex serve --port 0   # 127.0.0.1 only; --port 0 = OS picks a free port
```

## Environment

| Variable | Description |
|----------|-------------|
| `GEMDEX_MODE` | `local` (default) or `remote` |
| `GEMINI_API_KEY` | Required in local mode; Google AI Studio API key |
| `LANCEDB_PATH` | *(optional)* Custom directory for the embedded store (default `~/.gemdex/lance`) |
| `GEMDEX_REMOTE_URL` | Required in remote mode; Gemdex Server root URL |
| `GEMDEX_REMOTE_TOKEN` | Required in remote mode by default; server bearer token |
| `GEMDEX_REMOTE_TOKEN_ENV_VAR` | Optional alternate env var containing the remote token |
| `GEMDEX_REMOTE_NAME` | Optional human-readable remote name |

See the [main repo](https://github.com/anand-92/gemdex) for all environment
variables and configuration options.

## License

MIT
