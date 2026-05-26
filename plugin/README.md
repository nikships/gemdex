# Gemdex — Claude Code plugin

This plugin wires the [Gemdex](https://github.com/anand-92/gemdex) semantic code search MCP server into Claude Code, with:

- The `gemdex` MCP server (registered via `npx -y gemdex-mcp@latest` — no local checkout needed).
- A `PostToolUse` hook on `Edit | Write | MultiEdit` that touches `~/.gemdex/.sync-trigger` so the index re-syncs automatically after Claude edits files.
- A `code-search` skill that nudges Claude to prefer `search_code` over `Grep`/`Glob` for semantic/intent queries.

No Docker, no daemon — Gemdex now stores its vectors in an embedded LanceDB at `~/.gemdex/lance` by default.

## Install

From the gemdex repo's marketplace (one-time):

```
/plugin marketplace add anand-92/gemdex
/plugin install gemdex@gemdex
```

You'll be prompted for:

| Field | Required | Notes |
|-------|----------|-------|
| `gemini_api_key` | yes | Google AI Studio API key — [get one here](https://aistudio.google.com/apikey). Stored in the system keychain. |
| `lancedb_path` | optional | Filesystem path for the embedded vector store. Leave blank to use `~/.gemdex/lance`. |

## What it does, exactly

### 1. MCP server registration

`plugin.json` ships an inline `mcpServers.gemdex` entry that runs `npx -y gemdex-mcp@latest`, with `GEMINI_API_KEY` and `LANCEDB_PATH` populated from `userConfig`. The server exposes four tools to Claude:

- `index_codebase`
- `search_code`
- `get_indexing_status`
- `clear_index`

### 2. Auto-reindex hook

`hooks/hooks.json` registers a `PostToolUse` matcher for `Edit | Write | MultiEdit` that runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/touch-sync-trigger.js`. The script `mkdir -p`s `~/.gemdex` and `utimes`-touches `~/.gemdex/.sync-trigger`. Gemdex's built-in `fs.watch` debounces these for 2 s and kicks off an incremental re-index.

The Node script is cross-platform (works on macOS, Linux, and Windows) and never fails the hook — if the touch can't happen, the gemdex periodic background sync still catches the change.

### 3. Search-preference skill

`skills/code-search/SKILL.md` ships a model-invoked skill whose **description** is the persistent nudge: "Use the Gemdex `search_code` MCP tool before Grep/Glob when the user is asking about code by intent or meaning…". The skill body documents the four tools and the exact workflow (initial `index_codebase`, semantic queries via `search_code`, fall back to `Grep` only for exact strings).

## Layout

```
plugin/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   └── hooks.json
├── scripts/
│   └── touch-sync-trigger.js
├── skills/
│   └── code-search/
│       └── SKILL.md
└── README.md
```
