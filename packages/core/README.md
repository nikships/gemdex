# gemdex-core

The shared engine for [Gemdex](https://github.com/nikships/gemdex): local
LanceDB text storage, parent-document retrieval, embedding providers, shared
HTTP data routes, session parsing/digestion, and memory hygiene.

## Local library use

Install the package with `npm install gemdex-core`. Local MLX inference requires
native arm64 macOS 14+ and an explicitly installed runtime/model. The
`npx gemdex-mcp install` command manages that installation; normal inference
never downloads anything.

```ts
import {
  MemoryStore,
  LanceDBVectorDatabase,
  MlxEmbedding,
  LEGACY_GEMINI_COLLECTION,
} from 'gemdex-core';

const memory = new MemoryStore({
  embedding: new MlxEmbedding(),
  vectorDatabase: new LanceDBVectorDatabase(),
  legacyCollectionName: LEGACY_GEMINI_COLLECTION,
});

await memory.save({ content: 'How we deploy: …', title: 'Deploy' });
const hits = await memory.recall('how do we deploy', 5);
console.log(hits[0]?.content); // whole parent, never a fragment
```

`MemoryStore` indexes chunks in `memories_mlx_bge_m3_8bit` and resolves
hybrid dense + BM25 matches to full parents. Its attachments are non-embedded
text-file blobs; media queries and new media attachments are unsupported.

### Upgrade from Gemini-based releases

Pass `legacyCollectionName: LEGACY_GEMINI_COLLECTION` to access the older
`memories` table. List/get/update/delete/export can access legacy parents;
recall and hygiene reject a populated legacy table. `memory.migrateLegacy()`
re-embeds text (or the title of a media-only parent), preserving timestamps,
metadata and blob bytes. Legacy media remains readable, not media-searchable.
Back up the store before migration.

## Shared server functionality

`MemoryBackend` defines the storage boundary; `LocalMemoryBackend` adapts
`MemoryStore`. The self-hosted server supplies `PostgresMemoryBackend` and
uses core's `GeminiEmbedding` for multimodal embedding. The
`handleMemoryApiRequest` router serves both sidecar and server with the same
data-route shapes, while each shell owns authentication and setup.

Local inference uses `ClaudeCodeDigester` and `ClusterJudge` through isolated
Claude Code Haiku calls. The server's uploaded-session path uses
`SessionDigester` with its server-owned Gemini key. Both share session parsing,
digest rendering and deterministic memory ids.

For self-hosted agents, use [HTTP MCP](../mcp-http/README.md); for direct HTTP
integrations, see the [/v1 contract](../../docs/BYOI_REMOTE_MODE.md).
See [MLX runtime details](../../docs/MLX_MODELS.md) for platform and model limits.

## License

MIT
