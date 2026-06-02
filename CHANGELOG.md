# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-06-02

### Added
- Desktop app first-launch setup for `GEMINI_API_KEY`, persisted locally in `~/.gemdex/.env`.
- README screenshots for the desktop setup and memory manager screens.

### Changed
- Desktop app sidecar startup now runs through the user's login shell so Finder/Dock launches inherit the expected Node/npm PATH.
- Refreshed frontend brand artwork and converted app illustration assets to transparent PNGs.
- Published `gemdex-core` and `gemdex-mcp` packages at `0.3.2`.

## [0.3.0] - 2026-06-02

Gemdex is a global, persistent memory layer for AI coding agents: deliberately save, recall, and update memories that persist across every repo and session, backed by Gemini embeddings and an embedded LanceDB hybrid store.

### Added
- **`gemdex-core`** — the memory engine: `GeminiEmbedding`, `LanceDBVectorDatabase` (hybrid dense + BM25, fused with Reciprocal Rank Fusion), and a `MemoryStore` with parent-document chunking. Long memories are split into retrieval chunks for sharp hybrid matching, but `recall` always resolves matches back to the full parent memory, deduped by id — never a fragment.
- **`gemdex-mcp`** — an MCP stdio server exposing three tools: `save_memory`, `recall`, and `update_memory`. Deletion is intentionally not an agent tool. Embedded LanceDB persists at `~/.gemdex/lance` by default (override with `LANCEDB_PATH`); no Docker, no daemon.
- **`gemdex serve`** — a localhost-only (`127.0.0.1`) HTTP/JSON sidecar (list/get/create/update/delete/export/import) backing the desktop manager app.
- **`packages/app`** — a [zero-native](https://www.npmjs.com/package/zero-native) desktop app to manage the memory layer (browse / create / edit / delete / export / import). The Zig shell spawns the sidecar on launch and kills it on exit; no user command required.
- **Claude Code plugin** — registers the `gemdex` MCP server and ships a `memory` skill that nudges the agent to save/recall/update **only when the user explicitly points at memory**.

[Unreleased]: https://github.com/anand-92/gemdex/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/anand-92/gemdex/compare/v0.3.0...v0.3.2
[0.3.0]: https://github.com/anand-92/gemdex/releases/tag/v0.3.0
