# gemdex-mcp

MCP server for semantic code search — Gemini embeddings + Milvus.

Part of [Gemdex](https://github.com/anand-92/gemdex).

## Install for Claude Code

```bash
claude mcp add gemdex \
  -e GEMINI_API_KEY=your-key \
  -e MILVUS_ADDRESS=localhost:19530 \
  -- npx -y gemdex-mcp@latest
```

## Install for any MCP client

```json
{
  "mcpServers": {
    "gemdex": {
      "command": "npx",
      "args": ["-y", "gemdex-mcp@latest"],
      "env": {
        "GEMINI_API_KEY": "your-key",
        "MILVUS_ADDRESS": "localhost:19530"
      }
    }
  }
}
```

## Tools

- `index_codebase` — index a directory
- `search_code` — natural-language semantic + BM25 hybrid search
- `clear_index` — drop the Milvus collection for a codebase
- `get_indexing_status` — progress + last-completed timestamps

## Required env

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI Studio API key |
| `MILVUS_ADDRESS` | Milvus location (`host:port`, defaults to `localhost:19530`) |
| `MILVUS_TOKEN` | *(optional)* Auth token for Milvus instances with authentication enabled |

See the [main repo](https://github.com/anand-92/gemdex) for all environment variables and configuration options.

## License

MIT
