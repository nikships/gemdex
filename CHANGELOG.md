# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-26

### Changed
- **Replaced Milvus with embedded LanceDB.** Gemdex no longer requires Docker or a running vector-store daemon. All vectors persist in a single directory (`~/.gemdex/lance` by default, override with `LANCEDB_PATH`). Per-instance collection limits are gone, opening the door to indexing many repos under one home directory.
- Hybrid retrieval now uses LanceDB's BM25 full-text index on `content` plus dense kNN, fused via Reciprocal Rank Fusion in app code.
- Plugin manifest no longer prompts for Milvus address/token — only the Gemini API key is required.

### Removed
- `MilvusVectorDatabase` and `MilvusRestfulVectorDatabase` exports from `gemdex-core`, along with their Node SDK dependency and the unused `faiss-node` dep.
- `MILVUS_ADDRESS` / `MILVUS_TOKEN` environment variables (replaced by `LANCEDB_PATH`).
- `COLLECTION_LIMIT_MESSAGE` export (no longer applicable — LanceDB has no collection cap).

## [0.1.0] - 2026-05-25

### Added
- Initial release of `gemdex-core` (indexing engine) and `gemdex-mcp` (MCP server).
- AST-aware chunking via tree-sitter for TypeScript, JavaScript, Python, Java, C/C++, C#, Go, Rust, PHP, Ruby, Swift, Kotlin, Scala, and Markdown.
- Gemini Embedding 2 client with Matryoshka-resizable output (256 / 768 / 1536 / 3072 dimensions).
- Milvus vector store with hybrid dense + BM25 retrieval (configurable via `HYBRID_MODE`).
- Four MCP tools: `index_codebase`, `search_code`, `clear_index`, `get_indexing_status`.
- Incremental re-indexing via Merkle-tree change detection.
- File-trigger watcher (`~/.gemdex/.sync-trigger`) for editor-driven re-syncs.
- Custom file extensions and ignore patterns via env vars.

[Unreleased]: https://github.com/anand-92/gemdex/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/anand-92/gemdex/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anand-92/gemdex/releases/tag/v0.1.0
