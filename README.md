<div align="center">

<img src="assets/logo-wordmark.jpg" alt="Gemdex — find the code, skip the context bloat" width="780" />

### Semantic code search for AI coding agents — Gemini embeddings × LanceDB × MCP

[![npm version](https://img.shields.io/npm/v/gemdex-mcp?color=cf6a4c&label=gemdex-mcp&logo=npm)](https://www.npmjs.com/package/gemdex-mcp)
[![npm downloads](https://img.shields.io/npm/dm/gemdex-mcp?color=cf6a4c&label=downloads&logo=npm)](https://www.npmjs.com/package/gemdex-mcp)
[![GitHub stars](https://img.shields.io/github/stars/anand-92/gemdex?style=flat&color=e9b949&logo=github)](https://github.com/anand-92/gemdex/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-7a9e7e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-7a9e7e.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-cf6a4c)](https://modelcontextprotocol.io)
[![Powered by Gemini](https://img.shields.io/badge/embeddings-Gemini-4285F4?logo=google)](https://ai.google.dev/)
[![Powered by LanceDB](https://img.shields.io/badge/vector_db-LanceDB-9933ff)](https://lancedb.com/)

**[⭐ Star on GitHub](https://github.com/anand-92/gemdex)** · **[📦 npm](https://www.npmjs.com/package/gemdex-mcp)** · **[💬 Discussions](https://github.com/anand-92/gemdex/discussions)** · **[🐛 Issues](https://github.com/anand-92/gemdex/issues)**

</div>

<p align="center">
  <img src="assets/hero.jpg" alt="A developer searching a giant codebase shelf with the Gemdex device" width="100%" />
</p>

## Why Gemdex

> Loading a whole repo into an LLM's context every turn is slow, expensive, and forgetful.
> Gemdex finds the **right** code first, then hands only those chunks to your agent.

- 🧠 **Semantically smart** — AST-aware chunks embedded with Gemini Embedding 2 (8K context, 3072 dim, Matryoshka-resizable).
- 💸 **Token-cheap** — agents query natural language, get back targeted file:line hits instead of dragging in whole files.
- 🔌 **Plug-and-play** — speaks MCP over stdio, so any compatible client (Claude Code, Cursor, Codex CLI, Windsurf, Cline, Continue, Zed…) can use it instantly.
- 🪶 **Truly embedded** — vectors live in a single directory on your disk (LanceDB). No Docker, no daemon, no SaaS, no telemetry.
- ♻️ **Always fresh** — incremental Merkle-tree change detection + an optional file-trigger watcher keep the index in sync as you code.

## See it in action

<p align="center">
  <img src="assets/mockup-search.jpg" alt="Example Gemdex search returning file paths with line numbers" width="80%" />
</p>

Ask your agent:

```
Find the retry-with-backoff helper.
```

…and instead of grep-spraying or stuffing your repo into the prompt, Gemdex hands back the three files that actually implement it.

## 💰 Pricing — it's a no-brainer

> **TL;DR:** Even with heavy daily use, Gemdex caps out around **$4–6/month** in Gemini API usage.

- 🎁 **Already paying for Google AI Pro ($20/mo)?** You get **$10/mo of free Gemini API credit** bundled into the plan — see [Google's announcement](https://blog.google/innovation-and-ai/technology/developers-tools/gdp-premium-ai-pro-ultra/). That credit alone covers Gemdex with room to spare. Adding Gemdex is genuinely free for you.
- 💸 **Not on the Pro plan?** Still a no-brainer. The few dollars/month Gemdex costs pays itself back many times over by **slashing the tokens your coding agent burns** on every turn — meaning a smaller bill on your Claude / Cursor / Codex / Windsurf subscription *and* faster, more accurate answers from your agent.

Either way: cheaper bills, smarter agents.

## Quickstart (under a minute)

There is **no setup step** for the vector store anymore — LanceDB is embedded
and persists at `~/.gemdex/lance` automatically the first time you index.

### Wire Gemdex into your agent

**Claude Code (one-command plugin install — recommended):**

```bash
/plugin marketplace add anand-92/gemdex
/plugin install gemdex@gemdex
```

You'll be prompted for `GEMINI_API_KEY`. Sensitive values are stored in your OS keychain. The plugin ships:

- the `gemdex` MCP server (no local checkout — runs via `npx -y gemdex-mcp@latest`),
- a `code-search` skill that nudges Claude to prefer `search_code` over `Grep`/`Glob` for semantic queries, and
- a `PostToolUse` hook that auto-reindexes after every `Edit`/`Write`/`MultiEdit`.

See [`plugin/README.md`](plugin/README.md) for the full layout.

**Claude Code (manual, no plugin):**

```bash
claude mcp add gemdex \
  -e GEMINI_API_KEY=your-key \
  -- npx -y gemdex-mcp@latest
```

**Any other MCP client** (Cursor, Codex CLI, Windsurf, Cline, Continue, Zed…):

```json
{
  "mcpServers": {
    "gemdex": {
      "command": "npx",
      "args": ["-y", "gemdex-mcp@latest"],
      "env": {
        "GEMINI_API_KEY": "your-key"
      }
    }
  }
}
```

### Index, then ask

```
Index this codebase.
```

<p align="center">
  <img src="assets/mockup-index.jpg" alt="Indexing progress with chunks being created" width="80%" />
</p>

```
Search for the websocket reconnection logic.
```

Done. The agent now has a tiny, accurate retrieval layer between itself and your code.

### Nudge your agent to actually use it (the single biggest thing you can do)

> Agents won't reach for a new MCP tool on their own. The fastest way to make Gemdex pay off is to **tell your agent, at the top of every session, that it exists and when to prefer it.** Skip this and you'll wonder why your agent still defaults to `grep`.

**For Claude Code** — drop this into `CLAUDE.md` at the repo root (or `~/.claude/CLAUDE.md` to apply globally):

```markdown
## Code search (Gemdex)

`gemdex` MCP exposes `search_code` (hybrid semantic + BM25). Prefer it for intent
queries ("where does X happen?", "find the retry logic"); use `Grep` for known
strings, symbols, log lines, and file globs. If `search_code` isn't in your
toolset, the MCP isn't connected — just use `Grep`/`Read` and don't bring
Gemdex up unless asked.

- **First search this session:** call `get_indexing_status(path=<abs repo path>)`.
  - `indexed` → go.
  - `indexing` → search anyway; flag that results may be partial.
  - `indexfailed` → surface the error, fall back to `Grep`.
  - `not indexed` → call `index_codebase(path=...)` if the user is actively
    working in this repo; otherwise just `Grep` — don't auto-index a path the
    user didn't ask about.
- **Search:** `search_code(path=..., query=<natural language>, limit=5–15)`.
- **Read each hit's `Scores:` line** (`fused=… · dense=#N · bm25=#N`). Both
  ranks ≤ 5 → high confidence. All ranks > 15 → either the codebase doesn't
  have it OR the index is stale. Disambiguate by `Read`ing the cited
  `file:line` — if the content has drifted, refresh with
  `index_codebase(path=..., force=true)` and re-search; otherwise it's a
  genuine miss, fall back to `Grep`.
- **Drift during long sessions:** most clients auto-refresh after edits via a
  `PostToolUse` hook on `~/.gemdex/.sync-trigger`. If yours doesn't, refresh
  manually when results stop matching reality.
```

**For Codex CLI, Cursor, Windsurf, Cline, Continue, Zed** — paste the same snippet into your client's root instructions file. The convention is `AGENTS.md` at the repo root; check your client's docs if unsure.

> If you installed the Claude Code plugin (`/plugin install gemdex@gemdex`), this nudge already ships as a bundled `code-search` skill — you can skip `CLAUDE.md` and it'll still work.

## How it works

<p align="center">
  <img src="assets/architecture.jpg" alt="Gemdex architecture: codebase → AST splitter → Gemini embedding → LanceDB → MCP → agent" width="100%" />
</p>

1. **Your codebase** — pointed at any local directory.
2. **AST splitter** — tree-sitter parses each file and emits semantically-coherent chunks (functions, classes, blocks), falling back to language-agnostic splitting when needed.
3. **Gemini embedding** — chunks become 3072-dim vectors (Matryoshka-resizable to 1536/768/256 if you want smaller, cheaper indexes).
4. **LanceDB** — vectors land in a per-codebase table inside `~/.gemdex/lance`, with a BM25 full-text index on `content` for hybrid retrieval.
5. **MCP → Agent** — your agent calls `search_code` with a natural-language query and receives ranked file:line snippets.

## Features

| | |
|---|---|
| 🌳 **AST-aware chunking** | tree-sitter grammars for TypeScript, JavaScript, Python, Java, C/C++, C#, Go, Rust, PHP, Ruby, Swift, Kotlin, Scala, Markdown |
| 🧬 **Hybrid retrieval** | dense vector + BM25 (LanceDB FTS) fused via Reciprocal Rank Fusion; switch to dense-only with one env var |
| 📐 **Matryoshka dimensions** | drop embedding size to 1536 / 768 / 256 for smaller indexes and faster queries |
| ♻️ **Incremental sync** | Merkle-tree change detection re-embeds only what moved |
| ⚡ **Trigger watcher** | Editor hooks write the workspace path into `~/.gemdex/.sync-trigger`; gemdex scopes the re-sync to that codebase. An empty file (legacy `touch`) still works — it just re-syncs every indexed codebase. |
| 🪶 **Truly embedded** | LanceDB persists in a single directory; no Docker, no daemon, no SaaS dependency, no telemetry |
| 🧰 **4 MCP tools** | `index_codebase`, `search_code`, `clear_index`, `get_indexing_status` |
| 🔧 **Configurable** | custom extensions, custom ignore patterns, custom embedding model, custom Gemini base URL |

## Auto-reindex on every edit (Claude Code)

The easiest path is the bundled plugin (`/plugin install gemdex@gemdex`) — its `PostToolUse` script reads the editor's `cwd` from the hook payload and writes it into `~/.gemdex/.sync-trigger`, so gemdex's watcher re-syncs only the codebase you're editing in.

If you don't want the plugin, you can still wire the hook by hand in `~/.claude/settings.json`. The first form is the new workspace-scoped protocol; the second is the legacy "force a full re-sync" shape and still works:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "jq -r .cwd > ~/.gemdex/.sync-trigger" }] }
    ]
  }
}
```

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "touch ~/.gemdex/.sync-trigger" }] }
    ]
  }
}
```

Equivalent hooks work in Cursor, Codex CLI, and any client that can run a shell command on save — write the editing workspace's absolute path as the first line of `~/.gemdex/.sync-trigger` (or leave it empty to fall back to syncing every indexed codebase).

## Where Gemdex fits

|                                  | grep / ripgrep | Plain RAG over full files | Cloud code-search SaaS | **Gemdex** |
|----------------------------------|:--------------:|:-------------------------:|:----------------------:|:----------:|
| Understands intent, not just strings | ❌ | ✅ | ✅ | ✅ |
| AST-coherent chunks (no half-functions) | ❌ | ❌ | varies | ✅ |
| Hybrid dense + lexical (BM25) | ❌ | rare | ✅ | ✅ |
| Runs 100% locally / self-hosted | ✅ | varies | ❌ | ✅ |
| Designed for AI agents via MCP | ❌ | ❌ | ❌ | ✅ |
| Incremental, on-edit re-index | ❌ | ❌ | ✅ | ✅ |
| Open source, MIT | ✅ | varies | ❌ | ✅ |

## Use as a library

Skip the MCP server and embed Gemdex directly in your own tooling:

```ts
import { Context, LanceDBVectorDatabase, GeminiEmbedding } from 'gemdex-core';

const embedding = new GeminiEmbedding({
  apiKey: process.env.GEMINI_API_KEY!,
  model: 'gemini-embedding-2',
});

// Pass nothing to use the default ~/.gemdex/lance directory, or specify
// `{ uri: '/some/other/path' }` to put the database anywhere you want.
const vectorDatabase = new LanceDBVectorDatabase();

const context = new Context({ embedding, vectorDatabase });

await context.indexCodebase('./my-project');
const results = await context.semanticSearch('./my-project', 'how does auth work', 5);
```

## Packages

| Package | Description |
|---------|-------------|
| [`gemdex-core`](packages/core) | Indexing engine, AST splitters, Gemini embedding client, embedded LanceDB vector store |
| [`gemdex-mcp`](packages/mcp) | MCP server binary that wires the core into an MCP stdio process |

## Configuration

<details>
<summary>All environment variables</summary>

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | yes | — | Google AI Studio API key |
| `LANCEDB_PATH` | no | `~/.gemdex/lance` | Filesystem path for the embedded vector store. All codebases are stored as separate tables under this directory. |
| `EMBEDDING_MODEL` | no | `gemini-embedding-2` | Override Gemini embedding model |
| `EMBEDDING_DIMENSION` | no | model default | Force Matryoshka-resized dimension (256/768/1536/3072) |
| `EMBEDDING_BATCH_SIZE` | no | 100 | Texts per embed request |
| `GEMINI_BASE_URL` | no | Google default | Custom Gemini endpoint |
| `HYBRID_MODE` | no | `true` | Disable to use dense-only vector search |
| `INDEX_MULTIMODAL` | no | `false` | Opt in to PDF and image indexing (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) with `gemini-embedding-2` |
| `CUSTOM_EXTENSIONS` | no | — | Comma-separated extra file extensions (`.vue,.svelte`) |
| `CUSTOM_IGNORE_PATTERNS` | no | — | Comma-separated extra ignore globs |
| `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` | no | — | Readable prefix for LanceDB table names |
| `GEMDEX_BACKGROUND_SYNC` | no | `true` | Periodic background re-index |
| `GEMDEX_SYNC_INTERVAL_MS` | no | `300000` | Background sync period |
| `GEMDEX_TRIGGER_WATCHER` | no | `true` | Watch `~/.gemdex/.sync-trigger` for forced syncs |

</details>

## Build from source

```bash
git clone https://github.com/anand-92/gemdex.git
cd gemdex
pnpm install
pnpm build
```

The MCP entry point lands at `packages/mcp/dist/index.js`. Point your MCP client at `node /absolute/path/to/packages/mcp/dist/index.js` to run a local build.

## Roadmap

- [ ] Cross-repo "search from `~`" mode (single global table)
- [ ] Additional grammars (Vue, Svelte, Zig, Lua, Solidity)
- [ ] First-class watch mode (no `touch` trigger required)
- [ ] Per-language re-rankers
- [ ] CLI (`gemdex search "..."`) for non-MCP workflows
- [ ] Web UI for browsing indexed projects

Have an idea? [Open a discussion](https://github.com/anand-92/gemdex/discussions/new) — early contributors get prioritized.

## Contributing

First time contributors very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, then check the `good-first-issue` label.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=anand-92/gemdex&type=Date)](https://star-history.com/#anand-92/gemdex&Date)

---

<p align="center">
  <img src="assets/star-cta.jpg" alt="If Gemdex saved you tokens, drop a star" width="60%" />
</p>

<div align="center">

If Gemdex makes your agent smarter or your bill smaller, **[give it a ⭐](https://github.com/anand-92/gemdex)** — it's the single biggest thing that helps the project grow.

</div>

## License

MIT. See [LICENSE](LICENSE).
