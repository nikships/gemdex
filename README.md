# Gemdex

Semantic code search MCP server for AI coding agents. Embeds your codebase with Google's Gemini Embedding 2 model and stores it in Milvus for hybrid (dense + BM25) retrieval.

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

## What it does

- Indexes your codebase using AST-aware chunking (TypeScript, JavaScript, Python, Java, C/C++, C#, Go, Rust, PHP, Ruby, Swift, Kotlin, Scala, Markdown).
- Embeds each chunk with `gemini-embedding-2` (8K context, 3072 dim, Matryoshka-resizable).
- Stores vectors in Milvus and serves an MCP server with four tools: `index_codebase`, `search_code`, `clear_index`, `get_indexing_status`.
- Incremental re-indexing via Merkle-tree change detection; touch `~/.gemdex/.sync-trigger` to force a sync.

## Why

Loading whole repos into an LLM's context for every request is slow and expensive. Gemdex finds the relevant code first, then hands only those chunks to the model.

## Requirements

- Node.js ≥ 20
- A running Milvus instance (local via Docker, or Zilliz Cloud)
- A Google AI API key for Gemini

### Spin up local Milvus (Docker)

```yaml
# ~/milvus/docker-compose.yml
services:
  milvus:
    container_name: milvus-standalone
    image: milvusdb/milvus:v2.5.10
    environment:
      ETCD_USE_EMBED: "true"
      ETCD_DATA_DIR: /var/lib/milvus/etcd
      ETCD_CONFIG_PATH: /milvus/configs/embedEtcd.yaml
      COMMON_STORAGETYPE: local
      DEPLOY_MODE: STANDALONE
    volumes:
      - ./volumes/milvus:/var/lib/milvus
      - ./embedEtcd.yaml:/milvus/configs/embedEtcd.yaml
      - ./user.yaml:/milvus/configs/user.yaml
    ports:
      - "19530:19530"
      - "9091:9091"
      - "2379:2379"
    command: ["milvus", "run", "standalone"]
```

```bash
cd ~/milvus && docker compose up -d
```

## Install for Claude Code

```bash
claude mcp add gemdex \
  -e GEMINI_API_KEY=your-key \
  -e MILVUS_ADDRESS=localhost:19530 \
  -- npx -y gemdex-mcp@latest
```

Then in Claude Code:

```
Index this codebase
```

```
Search for the retry-with-backoff helper
```

## Install for other MCP clients

The server speaks the Model Context Protocol over stdio. For any client (Cursor, Codex CLI, Windsurf, Cline, etc.) the command is `npx -y gemdex-mcp@latest` with the same env vars.

Example MCP config JSON:

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

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | yes | — | Google AI Studio API key |
| `MILVUS_ADDRESS` | one of these | — | `host:port` of Milvus (e.g. `localhost:19530`) |
| `MILVUS_TOKEN` | one of these | — | Zilliz Cloud token (also resolves the address) |
| `EMBEDDING_MODEL` | no | `gemini-embedding-2` | Override Gemini embedding model |
| `EMBEDDING_DIMENSION` | no | model default | Force Matryoshka-resized dimension (256/768/1536/3072) |
| `EMBEDDING_BATCH_SIZE` | no | 100 | Texts per embed request |
| `GEMINI_BASE_URL` | no | Google default | Custom Gemini endpoint |
| `HYBRID_MODE` | no | `true` | Disable to use dense-only vector search |
| `CUSTOM_EXTENSIONS` | no | — | Comma-separated extra file extensions (`.vue,.svelte`) |
| `CUSTOM_IGNORE_PATTERNS` | no | — | Comma-separated extra ignore globs |
| `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` | no | — | Readable prefix for Milvus collection names |
| `GEMDEX_BACKGROUND_SYNC` | no | `true` | Periodic background re-index |
| `GEMDEX_SYNC_INTERVAL_MS` | no | `300000` | Background sync period |
| `GEMDEX_TRIGGER_WATCHER` | no | `true` | Watch `~/.gemdex/.sync-trigger` for forced syncs |

## Auto-reindex on edit (Claude Code)

Drop this into `~/.claude/settings.json` to keep the index fresh in real time:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "touch ~/.gemdex/.sync-trigger" }] }
    ]
  }
}
```

## Use as a library

```ts
import { Context, MilvusVectorDatabase, GeminiEmbedding } from 'gemdex-core';

const embedding = new GeminiEmbedding({
  apiKey: process.env.GEMINI_API_KEY!,
  model: 'gemini-embedding-2',
});

const vectorDatabase = new MilvusVectorDatabase({
  address: 'localhost:19530',
});

const context = new Context({ embedding, vectorDatabase });

await context.indexCodebase('./my-project');
const results = await context.semanticSearch('./my-project', 'how does auth work', 5);
```

## Packages

| Package | Description |
|---------|-------------|
| [`gemdex-core`](packages/core) | Indexing engine, AST splitters, Gemini embedding client, Milvus vector store |
| [`gemdex-mcp`](packages/mcp) | MCP server binary that wires the core into an MCP stdio process |

## Build from source

```bash
git clone https://github.com/anand-92/gemdex.git
cd gemdex
pnpm install
pnpm build
```

The MCP entry point lands at `packages/mcp/dist/index.js`. Point your MCP client at `node /absolute/path/to/packages/mcp/dist/index.js` to run a local build.

## License

MIT. See [LICENSE](LICENSE).
