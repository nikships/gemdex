# gemdex-core

## Ownership boundaries

- `memory/memory-store.ts` owns local storage (text and media) and migration.
  `memory/backend.ts` exposes `MemoryBackend` and its `LocalMemoryBackend`
  adapter. Server implements the same interface with Postgres.
- `http/http-api.ts` owns the shared data routes for sidecar and server.
  Keep bind/auth/config outside this router. Match attachment routes before
  the greedy memory-id route.
- Local embedding is `embedding/mlx-embedding.ts` (multimodal); server
  embedding is `embedding/gemini-embedding.ts`. The shared attachment validator
  has two limit sets: `DEFAULT_ATTACHMENT_LIMITS` (server, Gemini MIME list) and
  `LOCAL_ATTACHMENT_LIMITS` (the `MemoryStore` default: more containers, longer
  clips, no PDF). A limit set's `mimeTypes` is its allowlist. Do not narrow
  server support to enforce local limits.
- `memory/content-edits.ts` is client-side literal editing, not a storage
  primitive. `stats/memory-stats-store.ts` is a separate client ledger;
  `MemoryStore` never reads it or applies trust ranking.
- Server `GeminiEmbedding.embedContentBatch` must wrap each input in a Content
  object with `parts`, and verify the returned count. Flat string arrays can
  aggregate into one embedding. Only `gemini-embedding-2` is multimodal;
  `gemini-embedding-001` is text-only.

## Storage and migration invariants

- Default local table: `LOCAL_TEXT_COLLECTION = memories_mlx_embeddinggemma2_8bit`.
  MCP also supplies `legacyCollectionNames` = `LEGACY_BGE_M3_COLLECTION`
  (`memories_mlx_bge_m3_8bit`), then `LEGACY_GEMINI_COLLECTION` (`memories`),
  for upgrades. Legacy vectors are never searched with MLX queries.
  Recall and `listParentsWithVectors` fail while any legacy rows remain.
- Legacy parents remain listable, readable, updatable, deletable and exportable.
  Writes go into the main index. `migrateLegacy` embeds text and each stored
  image/audio/video blob (a title row only when nothing else embeds), commits
  destination rows before deleting source rows, and preserves metadata/blobs.
  Stable ids make migration rerunnable.
- Migration requires cross-process write locking and atomic vector upsert.
  LanceDB mutations lock before snapshots. Tables and blobs have no shared
  crash-atomic transaction; rollback attempts are not a transaction guarantee.
  Stop writers before manually removing a stale lock.
- Embed before deleting existing rows/blobs. Reject empty input before any
  destructive overwrite. Preserve this ordering on save/update/import.
- Full parent metadata is duplicated in every row. Rewrite all parent rows
  for metadata changes; recall resolves and deduplicates whole parents.
  `relativePath` is the parent id, not a filesystem path.
- Image/audio/video attachments are embedded from their bytes, one
  `<parent>::att::<index>` row each, whose BM25 text is the caption or title.
  `file` attachments (text/JSON/JSONL) are never embedded. A parent with no
  text and no embedded media indexes its title. New media the embedding cannot
  take is rejected. Omitted attachments on update and import records re-write
  stored files under the looser of the store and server limits
  (`preserveMedia`), so legacy PDFs and media survive; a file that cannot be
  embedded there stays an unsearchable blob. `attachments:[]` clears them.
- Export inlines blobs; import re-embeds text and media. Caption-only updates
  preserve vectors and blobs. Do not make metadata edits depend on inference.
- Dimensions are fixed per collection. EmbeddingGemma 2 uses 768d (BGE-M3 was
  1024d); do not reuse a table with vectors from another model.
- `LanceDBVectorDatabase` construction creates its directory; `FileBlobStore`
  writes lazily. Tests must supply disposable locations.

## Retrieval

- Local `MemoryStore.recall` takes a text query and/or query media. Text is
  hybrid dense + BM25; each query file is a dense branch embedded with the query
  prompt. Several branches fuse by RRF with `k=100` (`RECALL_RRF_K`, also the
  hybrid text RRF); vector DB fallback is `DEFAULT_RRF_K=60`. Do not change one
  assuming it controls the other. `HYBRID_MODE=false` selects dense-only.
  Blob-only file types cannot be query media.
- The FTS index is lazy because LanceDB cannot train it on an empty table;
  FTS failure can degrade to dense-only.
- DataFusion lowercases unquoted identifiers. Preserve backtick quoting of
  camelCase columns and the `==` to `=` translation without corrupting string
  literals or other comparison operators.
- Save-time similarity reuses embedded vectors and centroid math from
  `utils/centroid.ts`, default threshold 0.93 (calibrated for EmbeddingGemma 2). It is advisory and failure
  must not fail a save. `GEMDEX_SIMILAR_ON_SAVE=false` disables it;
  `GEMDEX_SIMILAR_THRESHOLD` must be in `(0,1]`.
- Server multimodal retrieval lives in `packages/server/src/postgres.ts`;
  local media restrictions must not alter the `/v1` wire shape.

## Inference and ingestion

- `inference/claude-code.ts` runs local ingestion and hygiene through
  `claude -p --model haiku` with structured JSON. Preserve isolation:
  no tools, settings sources, skills, MCP servers, hooks, CLAUDE.md,
  auto-memory, or session persistence; fresh temporary cwd. Keep the existing
  login available, so neither a temporary HOME nor API-key-only `--bare`
  substitutes for these controls.
- `GEMDEX_CLAUDE_PATH` overrides discovery; native install locations precede
  PATH to avoid IDE/multiplexer wrappers. `checkClaudeCode` probes version and
  login without a model call, returning `ready`, `missing`, `unauthenticated`,
  or `error`. Readiness does not guarantee Haiku entitlement.
- Reject CLI error envelopes, missing structured output, and model usage that
  indicates silent fallback. Default timeout is five minutes per call.
  Ingest/hygiene managers use concurrency four and at most three total
  attempts per session/cluster.
- `ingest/digester.ts` contains both `ClaudeCodeDigester` (local) and
  `SessionDigester` (server Gemini uploads). Keep shared cleaning, prompt,
  schema and `chat:<source>:<sessionId>` ids; do not route BYOI through Claude.
- `IngestManager.run` processes only ledger-new files. Scan may reconcile
  unchanged prompt hashes or report changed files, but must not re-digest
  ledger-known sessions. No Batch API or collect workflow exists.
- Keep `IngestTarget` narrowed to `importRecords`, not the full backend.
  Digest text is embedded; cleaned transcript bytes are a non-embedded blob.
  Session timestamps are source activity times, not ingest times.
- `ingest/uploaded-session.ts` accepts transcript text without a path ledger.
  It isolates failures per file, uses content-derived source/id with filename
  fallback, and points to the stored attachment rather than a nonexistent
  host path. Re-upload upserts; local new-sessions-only gating does not apply.
- Cost estimates in `inference/claude-code.ts` are Haiku API list-price
  equivalents ($1/$5 per million input/output tokens), not subscription bills.
  Subscription use counts toward plan limits.
- Use injected runners/digesters/judges in tests. The inference test suite
  uses fake executables, not the user's Claude Code session.

## Hygiene

`candidate-finder.ts` clusters normalized parent centroids locally, with
size-capped greedy agglomeration (max eight members). `ClusterJudge` uses
Claude Code; its parser must produce a finding for every known member, discard
unknown ids, and retain at least one member per cluster. Findings persist in
`hygiene-report.ts`, with dismissals keyed by stable sorted-member hashes.
Apply deletes only after explicit human approval, never as an automatic
judge side effect or agent tool. BYOI has no vector-listing/hygiene endpoint.

For MLX worker/installer changes, read [MLX runtime](../../docs/MLX_MODELS.md):
query/document task prompts (media included), prompt-inclusive mean pooling and
normalization, unmodified upstream mlx-vlm, offline inference, artifacts pinned
by the generated manifest (`scripts/generate-mlx-manifest.py`; never hand-edit
`mlx-manifest.ts`), the bounded subprocess protocol, and explicit installation
are required. A runtime bump must keep text vectors at parity or ship a
re-embedding migration.
