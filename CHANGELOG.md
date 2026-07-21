# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`report_outcome` MCP tool + trust-weighted recall ranking.** A new tool records whether a recalled memory `worked`, `failed`, or was `stale`, tallied per-memory in a client-side ledger (`~/.gemdex/stats.json`, override via `GEMDEX_STATS_PATH`) — no LanceDB writes, no wire-contract change. `recall` now counts every surfacing and, when stats exist, shows each hit's track record (`recalled 7×, worked 3× (last: worked 2d ago)`, `⚠`-prefixed once it has failed or gone stale). Ranking itself stays pure relevance unless you opt in with `GEMDEX_TRUST_RANKING=true`, which over-fetches and re-ranks by a deterministic trust multiplier derived from worked/failed/stale counts. Backward compatible: with no stats recorded and the flag unset, recall output is unchanged.
- **Save-time similar-memory detection.** `save_memory` now checks the new memory against everything already stored, reusing the vectors the save already computed — zero extra embedding calls, one local ANN query plus a few filtered reads. Uses the same centroid-cosine math and default threshold (`0.90`) as memory hygiene. When a near-duplicate or conflicting memory is found, the response carries a `similar` field and a `⚠` advisory block naming it, so the agent can consolidate with `update_memory` on the spot instead of leaving both to be found weeks later by a hygiene scan. On by default; disable with `GEMDEX_SIMILAR_ON_SAVE=false` or adjust the bar with `GEMDEX_SIMILAR_THRESHOLD`. Local mode only in v1 — remote/BYOI saves are unaffected and carry no `similar` field yet.
- **Validated Gemini readiness in the macOS app.** Every sidecar launch now proves the configured local key with a real embedding request before the app unlocks. Missing, rejected, and temporarily unverifiable keys produce a prominent blocking alert instead of surfacing later as failed saves, searches, imports, or session ingestions. Candidate keys are validated before they are persisted, and Storage settings provides status, replacement, and retry controls (including in remote storage mode, where chat digestion still needs a local key).
- **`list_memories` MCP tool.** A read-only browse over the global pool: lists stored memories newest-first as compact summaries (title + id + relative age + preview + media counts), with an optional case-insensitive substring `filter` over title/preview and a `limit` (default 50, max 200). Complements `recall` (relevance-ranked, full content) for orienting and for retrieving an exact `id` to pass to `update_memory`. Deletion remains a human-only desktop action.
- **Richer `recall` output for agents.** Each hit now reports its relative age (`updated: 3d ago`, from `updatedAt`) and an `attachments:` line (kind + stable id + caption) so the agent can judge staleness and knows when media exists (fetch bytes via the sidecar's `GET /memories/:id/attachments/:attachmentId`).
- **Token-budgeted recall.** `recall` accepts `detail: "summary" | "full"` (default `full`); `summary` returns a ~200-char preview per hit instead of full content, so an agent can scan many results cheaply before pulling the one it needs.

- **Multimodal attachments (backend).** `save_memory` and `update_memory` accept an optional `attachments` array of inline base64 media (PNG/JPEG image, MP3/WAV audio, MP4/MOV video, PDF), embedded via `gemini-embedding-2` and recallable by text query. Each attachment is one embedding unit; its caption (or the memory title) backs the BM25 branch.
- On-disk blob storage for attachment bytes under `~/.gemdex/blobs` (a `FileBlobStore`), keeping the LanceDB table lean. Attachments round-trip through `export`/`import`.
- `gemdex serve` now accepts attachments on create/update and streams raw attachment bytes at `GET /memories/:id/attachments/:attachmentId`.
- Attachment validation (mimeType allowlist, per-modality count caps — ≤6 images, ≤1 audio, ≤1 video, ≤1 PDF — and a per-attachment byte ceiling) with a clear error when attachments are supplied to a non-multimodal embedding model.
- **Recall by media.** `recall` now accepts inline media (image/audio/video/PDF) alongside or instead of a text `query`. Each query attachment is embedded into the shared `gemini-embedding-2` space and runs its own similarity branch; text + media branches are fused with Reciprocal Rank Fusion. Exposed through the `recall` MCP tool and a new `POST /recall` route on `gemdex serve`.
- **Desktop app multimodal UI.** Create/edit memories with drag-and-drop or a file picker; per-attachment caption inputs; inline rendering of images, audio and video players, and native PDF preview; a media badge on list items; and a “Find similar” action on any attachment that runs recall-by-example (no free-text search box — keeping the app manage-only).

### Changed
- **Chat-history ingestion is new-sessions-only.** The desktop checkbox and CLI `--new-only` flag were removed. The core engine, sidecar, desktop app, and CLI now treat previously ingested sessions as informational-only—even if their transcript later changes—so no client can accidentally re-digest or overwrite an existing session memory.
- `content` is now optional for `save_memory`/`update_memory` when at least one attachment is supplied; `update_memory` preserves omitted fields (text, title, attachments) instead of requiring `content`.
- `recall` (`MemoryStore` + MCP tool) now takes an optional media query; `query` is optional when at least one attachment is provided.

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
