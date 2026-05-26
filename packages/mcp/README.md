# gemdex-mcp

MCP server for semantic code search — Gemini embeddings + embedded LanceDB.

Part of [Gemdex](https://github.com/anand-92/gemdex).

## Install for Claude Code

```bash
claude mcp add gemdex \
  -e GEMINI_API_KEY=your-key \
  -- npx -y gemdex-mcp@latest
```

No Docker, no daemon. LanceDB lives at `~/.gemdex/lance` by default.

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

- `index_codebase` — index a directory
- `search_code` — natural-language semantic + BM25 hybrid search
- `clear_index` — drop the LanceDB table for a codebase
- `get_indexing_status` — progress + last-completed timestamps

## Required env

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI Studio API key |
| `LANCEDB_PATH` | *(optional)* Custom directory for the embedded vector store (default `~/.gemdex/lance`) |

See the [main repo](https://github.com/anand-92/gemdex) for all environment variables and configuration options.

## License

MIT
