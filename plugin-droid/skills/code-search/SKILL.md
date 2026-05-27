---
description: Use the Gemdex `search_code` MCP tool before Grep/Glob for intent or meaning queries (e.g. "find the websocket reconnection logic", "JWT refresh handler", "retry-with-backoff helper", "error handling in auth"). Gemdex does hybrid semantic + BM25 search over the indexed codebase. This skill covers the four tools, the indexing-status state machine, sub-score interpretation, and stale-index detection.
---

# Gemdex code search

`gemdex` MCP exposes `search_code` (hybrid semantic + BM25). Prefer it for intent queries; use `Grep`/`Glob` for known strings, symbols, log lines, and file globs. If `search_code` isn't in your toolset, the MCP isn't connected — just use `Grep`/`Read`.

Tools, always with an **absolute path**:

- `search_code(path, query, limit?)` — ranked `file:line` snippets. Default `limit` is 5; raise to 10–15 when exploring.
- `get_indexing_status(path)` — current state + last update.
- `index_codebase(path, force?)` — initial or forced full reindex.
- `clear_index(path)` — drop the index.

## Workflow

1. **First search this session:** call `get_indexing_status(path)`.
   - `indexed` → go.
   - `indexing` → search anyway; flag that results may be partial.
   - `indexfailed` → surface the error, fall back to `Grep`.
   - `not indexed` → call `index_codebase(path)` if the user is actively working in this repo; otherwise just `Grep` — don't auto-index a path the user didn't ask about.
2. **Search:** `search_code(path, query, limit=5–15)`.
3. **Read each hit's `Scores:` line** (see below).

## Reading sub-scores

Each hit shows:

    Scores: fused=0.0312 · dense=#1 (d=0.180) · bm25=#3 (s=4.21)

- `fused` — RRF score after fusing both branches (higher = better).
- `dense=#N (d=X)` — rank in semantic candidates; smaller `d` = closer.
- `bm25=#N (s=X)` — rank in BM25 candidates; larger `s` = better.
- `—` means that branch didn't surface this hit.

Heuristics:

- Both ranks ≤ 5 → high confidence; trust it.
- One `—` and fused low → marginal; consider re-phrasing.
- All ranks > 15 → either the codebase doesn't have it, OR the index is stale. Disambiguate by `Read`ing the cited `file:line`; if content has drifted, refresh with `index_codebase(path, force=true)` and re-search. Otherwise it's a genuine miss — fall back to `Grep` or tell the user.

## Index freshness

This plugin's `PostToolUse` hook touches `~/.gemdex/.sync-trigger` after every `Edit`/`Create`/`ApplyPatch`/`Write`/`MultiEdit`, and the server re-embeds only what changed. Drift is rare here, but if you ever see results that don't match what `Read` shows, force-reindex and continue.
