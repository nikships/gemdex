# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-06-02

### Changed
- **Repurposed Gemdex from a per-repo code-search index into a global, persistent memory layer for AI coding agents.** You now deliberately save/recall/update memories that persist across every repo and session. The Gemini + LanceDB hybrid retrieval engine is reused as-is.
- MCP tool surface is now three tools: `save_memory`, `recall`, and `update_memory`. Recall uses **parent-document chunking** — long memories are split into retrieval chunks for sharp hybrid matching, but recall always returns the full parent memory, never a fragment.
- `gemdex-core` now exports a `MemoryStore` (parent-document chunking over the existing `GeminiEmbedding` + `LanceDBVectorDatabase`).

### Added
- `gemdex serve` run-mode: a localhost-only HTTP/JSON sidecar (list/get/create/update/delete/export/import) backing the desktop manager app. Binds `127.0.0.1` and prints a `PORT=<n>` handshake line for the shell.
- `packages/app`: a [zero-native](https://www.npmjs.com/package/zero-native) desktop app to manage the memory layer (browse / create / edit / delete / export / import). The Zig shell spawns the sidecar on launch and kills it on exit; no user command required.
- A `gemdex` bin alias on `gemdex-mcp` so `npx gemdex serve` works.
- `memory` Claude Code skill nudging the agent to save/recall/update **only when explicitly told**.

### Removed
- All code-search MCP tools: `index_codebase`, `search_code`, `clear_index`, `get_indexing_status`.
- File-derived indexing: AST/tree-sitter splitters and grammars, LangChain character splitter, Merkle incremental sync, file watcher / `~/.gemdex/.sync-trigger`, periodic background sync, multimodal (PDF/image) indexing, per-repo snapshot manager, and per-repo table naming.
- The `gemdex-core` `Context` class and the MCP `snapshot.ts` / `sync.ts` / `splitter.ts` / code-search `handlers.ts`.
- Code-search environment variables: `INDEX_MULTIMODAL`, `CUSTOM_EXTENSIONS`, `CUSTOM_IGNORE_PATTERNS`, `GEMDEX_BACKGROUND_SYNC`, `GEMDEX_SYNC_INTERVAL_MS`, `GEMDEX_TRIGGER_WATCHER`, `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE`, and splitter selection.
- The `code-search` plugin skill and the `PostToolUse` auto-reindex hook.
- Unused `gemdex-core` dependencies: tree-sitter grammars, `langchain`, `glob`, `fs-extra`, `mock-fs`.

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

[Unreleased]: https://github.com/anand-92/gemdex/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/anand-92/gemdex/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/anand-92/gemdex/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anand-92/gemdex/releases/tag/v0.1.0
