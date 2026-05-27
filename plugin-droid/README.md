# Gemdex — Droid plugin

Droid-native build of [Gemdex](https://github.com/anand-92/gemdex) semantic code search.

> If you're on **Claude Code**, install `gemdex@gemdex` instead (see [`../plugin/README.md`](../plugin/README.md)). The two plugins ship identical MCP server + skill — only the hooks shape differs.

## Why a separate plugin?

Droid claims Claude Code plugin compatibility, but its `hooks.json` runner ignores the `args[]` array used by the Claude variant. With the Claude plugin loaded in Droid you get:

```
SyntaxError: Unexpected token ':'
    at evalTypeScript (node:internal/process/execution:260:22)
```

…because Droid invokes plain `node` and Node tries to `eval` the hook payload JSON from stdin.

This plugin uses Droid's single-`command` shape per the [official docs](https://docs.factory.ai/cli/configuration/plugins#plugin-hooks):

```json
{
    "type": "command",
    "command": "node \"${DROID_PLUGIN_ROOT}/scripts/touch-sync-trigger.js\""
}
```

…with `${DROID_PLUGIN_ROOT}` instead of `${CLAUDE_PLUGIN_ROOT}` and no separate `args` field, so the hook actually executes.

## Install

```bash
droid plugin marketplace add https://github.com/anand-92/gemdex
droid plugin install gemdex-droid@gemdex
```

You'll be prompted for:

| Field | Required | Notes |
|-------|----------|-------|
| `gemini_api_key` | yes | Google AI Studio API key — [get one here](https://aistudio.google.com/apikey). Stored in the system keychain. |
| `lancedb_path` | optional | Filesystem path for the embedded vector store. Leave blank to use `~/.gemdex/lance`. |

## What it does

### 1. MCP server registration

`.factory-plugin/plugin.json` registers `gemdex` MCP via `npx -y gemdex-mcp@latest`, with `GEMINI_API_KEY` + `LANCEDB_PATH` populated from `userConfig`. The server exposes four tools:

- `index_codebase`
- `search_code`
- `get_indexing_status`
- `clear_index`

### 2. Auto-reindex hook

`hooks/hooks.json` registers a `PostToolUse` matcher for `Edit | Create | ApplyPatch | Write | MultiEdit` that runs `node "${DROID_PLUGIN_ROOT}/scripts/touch-sync-trigger.js"`. Droid pipes the hook payload (including `cwd`) to the script on stdin; the script `mkdir -p`s `~/.gemdex` and writes the editor's workspace path into `~/.gemdex/.sync-trigger` as a single line. Gemdex's built-in `fs.watch` debounces those changes for 2 s, reads the workspace line, and runs `reindexByChange` against just the matching indexed codebase. An empty file (e.g. a hand-rolled `touch ~/.gemdex/.sync-trigger` hook from before this change) still works — it falls back to syncing every indexed codebase.

The Node script is cross-platform and never fails the hook — if the write can't happen, the gemdex periodic background sync still catches the change.

### 3. Search-preference skill

`skills/code-search/SKILL.md` is a model-invoked skill whose **description** is the persistent nudge: "Use the Gemdex `search_code` MCP tool before Grep/Glob when the user is asking about code by intent or meaning…". The skill body documents the four tools and the exact workflow.

## Layout

```
plugin-droid/
├── .factory-plugin/
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

## Verifying the hook fires

After installing in Droid, run any `Edit`/`Create`/`Write` and check the trigger file:

```bash
stat -f "%Sm" ~/.gemdex/.sync-trigger
cat ~/.gemdex/.sync-trigger
```

The mtime should be updated to within a few seconds of your edit, and the contents should be the absolute path of the workspace you were editing in. If the mtime moves but the file is empty, the hook fired but Droid didn't pipe the JSON payload to stdin — open an issue with `droid --version` and a snippet of the stderr from your session log. If nothing moves, the hook isn't firing at all.
