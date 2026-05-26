---
description: Use the Gemdex `search_code` MCP tool before Grep/Glob when the user is asking about code by intent or meaning (e.g. "find the websocket reconnection logic", "JWT refresh handler", "retry-with-backoff helper", "error handling in the auth flow"). Gemdex performs semantic search over the indexed codebase; Grep only matches exact strings. This skill explains the exact tools to call, when to fall back to ripgrep, and how to keep the index fresh.
---

# Gemdex code search

This repository is indexed by **Gemdex**, a semantic code search MCP server (Gemini embeddings + embedded LanceDB). Reach for it **first** for anything that's a question about meaning, intent, or behavior — and only fall back to `Grep`/`Glob` for exact-string lookups.

## When to use Gemdex vs Grep / Glob

Prefer the `search_code` MCP tool (provided by the `gemdex` server) when:

- The user asks about code by **intent** or **meaning** — e.g. "find the retry-with-backoff helper", "where does JWT refresh happen?", "websocket reconnection logic", "rate limiting".
- You want **ranked, semantically-related** results across many files.
- You're exploring an unfamiliar codebase and don't yet know the symbol or file names.

Use `Grep` / `Glob` only when:

- You need an **exact string** match (a specific symbol you already know, an error literal, a log message, an import path).
- You need to list files by **path pattern**.
- Gemdex returned no useful results for the semantic query.

## Workflow

1. **First time in a fresh checkout?** Call `index_codebase` once with the repo's absolute path. After that, the index stays in sync automatically — this plugin's `PostToolUse` hook touches `~/.gemdex/.sync-trigger` after every `Edit`, `Write`, or `MultiEdit`, which the gemdex server picks up and uses to incrementally re-embed only what changed.
2. **For semantic questions**, call `search_code` with a natural-language query and the absolute codebase path. Read the returned `file:line` hits first instead of guessing or grepping.
3. **If results look stale or empty**, call `get_indexing_status` to check the last sync time and chunk count. If the codebase isn't covered, run `index_codebase` again.
4. **Fall back to `Grep`/`Glob`** only for exact-string lookups (function names you already have, log lines, error strings, file globs).

## Tool reference

The `gemdex` MCP server exposes four tools:

- `search_code(path, query, limit?)` — semantic search; returns ranked `file:line` snippets. Default `limit` is 5; raise to 10–15 when scoping out an unfamiliar area.
- `index_codebase(path)` — initial full index of a directory.
- `get_indexing_status(path)` — last sync time, chunk count, and freshness for a codebase.
- `clear_index(path)` — drop the index for a codebase.

Always pass an **absolute path** for `path`.
