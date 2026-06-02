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

## Required env

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI Studio API key (needed to embed on save/recall/update) |
| `LANCEDB_PATH` | *(optional)* Custom directory for the embedded store (default `~/.gemdex/lance`) |

See the [main repo](https://github.com/anand-92/gemdex) for all environment
variables and configuration options.

## License

MIT
