# Gemdex — Claude Code plugin

This plugin wires the [Gemdex](https://github.com/anand-92/gemdex) **memory
layer** MCP server into Claude Code, with:

- The `gemdex` MCP server (registered via `npx -y gemdex-mcp@latest` — no local
  checkout needed), exposing `save_memory`, `recall`, `update_memory`, and
  `list_memories`.
- A `memory` skill that nudges Claude to save / recall / update **only when the
  user explicitly points at memory** — never proactively.

No Docker, no daemon — Gemdex stores its memories in an embedded LanceDB at
`~/.gemdex/lance` by default. Memory is one global pool, shared across every
repo and session.

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
| `lancedb_path` | optional | Filesystem path for the embedded memory store. Leave blank to use `~/.gemdex/lance`. |

## What it does, exactly

### 1. MCP server registration

`plugin.json` ships an inline `mcpServers.gemdex` entry that runs
`npx -y gemdex-mcp@latest`, with `GEMINI_API_KEY` and `LANCEDB_PATH` populated
from `userConfig`. The server exposes four tools to Claude:

- `save_memory(content, title?)` — persist a new memory; returns its `id`.
- `recall(query, limit?, detail?)` — retrieve full memories by natural language,
  each with its relative age and attachments; `detail="summary"` returns previews.
- `update_memory(id, content?, edits?, title?)` — revise an existing memory in
  place. Use `edits` (find-and-replace) for partial changes to large memories,
  or `content` for a full rewrite.
- `list_memories(filter?, limit?)` — browse stored memories newest-first as
  compact summaries (read-only catalog, not search).

Deletion is intentionally **not** an agent tool — it's a human action in the
Gemdex desktop app.

### 2. Memory skill

`skills/memory/SKILL.md` ships a model-invoked skill whose **description** is
the persistent nudge: save when the user says remember/save, recall when the
user points at memory ("check your memory layer", "how do we usually do X"),
update to revise — and **explicit only**, never auto-capture or recall
unprompted.

## Layout

```
plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── memory/
│       └── SKILL.md
└── README.md
```
