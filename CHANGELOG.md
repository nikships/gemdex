# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`gemdex-droid` plugin** — a Droid-native sibling of the Claude Code plugin at `plugin-droid/`. Same MCP server + `code-search` skill, but `hooks/hooks.json` uses Droid's single-`command` shape with `${DROID_PLUGIN_ROOT}` so the PostToolUse auto-reindex hook actually fires under `droid`. The original `gemdex` plugin at `plugin/` is unchanged so Claude Code installs keep working as before.

### Changed
- **Trigger file now carries the workspace path.** The Claude Code and Droid plugin hooks read the hook payload's `cwd` from stdin and write it into `~/.gemdex/.sync-trigger` as a single line. The MCP server's watcher reads that line and scopes the incremental re-index to the matching indexed codebase via `findIndexedCodebasePath` (best-match, so subdirectories of an indexed root work too), instead of looping through every indexed codebase on every edit. An empty trigger file is still valid — that's the legacy `touch ~/.gemdex/.sync-trigger` shape and the watcher falls back to syncing every indexed codebase, so existing hand-rolled hooks keep working.

### Fixed
- **Multi-process snapshot reads no longer drop other processes' index options.** `SnapshotManager.getCodebaseInfo` now reads `~/.gemdex/mcp-codebase-snapshot.json` from disk (matching how `getIndexedCodebases` already worked) and only falls back to the in-memory map when the file is missing. Before this, an MCP server that booted before another process had indexed a codebase would call `reindexByChange` for that codebase with empty `requestCustomExtensions` / `requestIgnorePatterns`, filtering all files out and wiping the merkle to an empty set on the next background sync.
- **Local test pipeline runs again.** Pinned every `jest 30.x` package to `30.3.0` via a workspace-level `overrides` block. The published `jest-runtime@30.4.x` calls `clearMocksOnScope` on its bundled `jest-mock@30.4.1` — a method that does not exist in any released `jest-mock` — so `jest --runInBand` crashed during module setup for every suite. Pinning back to `30.3.0` restores a consistent API surface across the jest packages until upstream republishes `jest-mock`.

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
