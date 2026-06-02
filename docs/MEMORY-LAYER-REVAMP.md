# Gemdex Revamp — From Code Search to a Memory Layer

> **Status:** Design spec, pre-implementation. No code yet.
> **One-liner:** Gemdex becomes a global, persistent **memory layer** for AI
> coding agents — explicit save/recall of facts, credentials, and playbooks —
> instead of a per-repo semantic code search index.

---

## 1. Why

Today Gemdex derives a throwaway index *from your files* so an agent can search
code. That's a per-repo, ephemeral, read-only view of something that already
exists on disk.

A memory layer is the opposite: a **deliberately written, durable store** that
is the source of truth. You teach your agent something once, and it remembers
forever, across every repo and every session.

The motivating workflows:

- *During a session:* "We just figured out the right way to wire up the Junie
  review workflow — **save that to memory.**"
- *Weeks later, different repo:* "Set up the Junie review workflow here —
  **check your memory layer** for how we do it."
- *Different machine, different app:* "Notarize and sign this build — **the
  credentials and steps are in my memory layer.**"

The retrieval engine Gemdex already has (Gemini embeddings + LanceDB hybrid
dense/BM25 search) is exactly what a memory layer needs. We keep the engine,
throw away the file-indexing machinery, and add a deliberate write/edit
lifecycle plus a desktop app to manage it.

---

## 0. For the implementing agent — read this first

This spec is a handoff. Before writing code:

1. **You do not know zero-native from general training.** It is a niche Zig
   desktop shell. **Load its skill first** and keep it open while building the
   desktop app (§7):
   ```bash
   npm install -g zero-native             # CLI (also runnable via npx)
   npx zero-native skills get core --full # mental model, app.zon, bridge, packaging
   npx zero-native skills get automation  # smoke-testing a running app
   ```
   The full zero-native build steps you'll need are distilled in §7.6, but load
   the skill for the authoritative reference and current syntax.

2. **Reuse, don't rebuild, the retrieval engine.** `gemdex-core` already has a
   working `GeminiEmbedding` client and `LanceDBVectorDatabase` with hybrid
   (dense + BM25 / RRF) search. Keep them. The revamp is mostly **subtraction**
   (rip out file indexing — §11) plus **three thin additions**: a memory
   chunk/store module, the 3 MCP tools (§6), and the desktop app + its Node
   sidecar (§7).

3. **Build order suggestion:** (a) memory module + store in core → (b) 3 MCP
   tools → (c) `gemdex serve` sidecar HTTP mode → (d) zero-native shell that
   spawns it → (e) web UI → (f) plugin/skill + README rewrite.

---

## 2. Product principles

These are firm and shape every downstream decision.

1. **Power-dev tool, not consumer software.** The audience is developers who
   know what they're doing. No hand-holding.
2. **One global pool.** No scopes, no projects, no tags, no buckets. Every
   memory is searchable from everywhere. Embeddings do the disambiguation —
   the user should never sort memories into folders.
3. **Zero guardrails by design.** Users may store API keys, credentials,
   account details, anything — in plaintext, locally. There is **no** secret
   redaction, no encryption mandate, no safety enforcement. Storing sensitive
   data is the user's informed choice.
4. **Explicit only.** The agent saves and recalls **only when told.** No
   proactive capture, no auto-summarization of sessions, no background recall.
5. **Local and embedded.** Memories live on the user's disk in LanceDB. No
   daemon, no SaaS, no telemetry. (Consistent with Gemdex today.)
6. **Keep the name.** Still "gemdex" / `gemdex-mcp` / `~/.gemdex`. This is a
   repurpose, not a rebrand — preserves the npm package and GitHub stars.

---

## 3. Scope at a glance

### Added
- 3 MCP tools: `save_memory`, `recall`, `update_memory`.
- A global memory store (one LanceDB table) with parent-document chunking.
- A zero-native desktop app to **manage** memories (browse / create / edit /
  delete / export / import).
- A small Node "serve" mode that backs the desktop app over localhost.

### Removed (see §11 for the full list)
- All code-search MCP tools (`index_codebase`, `search_code`, `clear_index`,
  `get_indexing_status`).
- File-derived indexing: AST/tree-sitter splitters, Merkle incremental sync,
  file watchers / `.sync-trigger`, background sync, multimodal file indexing,
  per-repo snapshot management.

### Reused (mostly verbatim)
- `GeminiEmbedding` client.
- `LanceDBVectorDatabase` + hybrid (dense + BM25, RRF) retrieval.
- MCP stdio server scaffold.
- Claude Code plugin mechanism (skill + config wiring).

---

## 4. The memory model

### 4.1 What a memory is

A memory has exactly two user-facing fields:

| Field | Required | Notes |
|-------|----------|-------|
| `content` | yes | Free text. A one-line fact or a 300-line playbook — anything. |
| `title` | no | Human/agent-given name. If absent, the UI auto-derives one (e.g. first line / a short summary) for list display. |

**System metadata** (stored, not user-facing, **not** used for ranking):

| Field | Purpose |
|-------|---------|
| `id` | Stable identifier returned by `save_memory`, used by `update_memory` and the UI. |
| `created_at`, `updated_at` | Timestamps. Used by the UI for sorting/browsing and by export. *Ranking stays pure-relevance — these never bias search.* |

> **Explicitly out of scope:** origin/provenance tracking (which repo/cwd a
> memory came from), tags, categories, memory "type" taxonomies, importance/pin
> flags. The global pool + embeddings make these unnecessary.

### 4.2 Parent-document chunking (the key design choice)

The concern that drove this: *"If I save 300 lines as one memory, I don't want
recall to hand back a fragment and then re-search for the rest."*

**Guarantee: recall always returns the full memory. Never a fragment.**

How we get there without sacrificing retrieval precision on long memories:

- On save, a memory is split internally into retrieval **chunks**. Each chunk
  is embedded separately and stored with a `parent_id` pointing back to its
  memory.
- A short memory is simply a single chunk.
- On recall, hybrid search ranks **chunks** (so any sub-topic inside a long
  playbook can trigger a precise hit), but each matching chunk is resolved to
  its **full parent memory**, and results are **deduplicated by `parent_id`**.
- The caller receives whole memories, stitched and complete — even when only
  one paragraph of a 300-line memory matched the query.

This is the well-worn "parent document retriever" / "small-to-big" pattern.
Net effect: sharp matching on long content, but the agent always gets the
entire memory back in one shot.

> **Storage shape (implementation note):** one logical store keyed by memory,
> with chunk-level rows carrying `parent_id` + the chunk vector + chunk text,
> and the full parent `content`/`title` retrievable for stitching. Exact table
> layout (single table with a `is_parent` flag vs. parent+chunk tables) is a
> build-time call; the contract above is what matters.

---

## 5. Retrieval

- **Hybrid, exactly as today:** dense vector (Gemini) + BM25 (LanceDB FTS),
  fused with Reciprocal Rank Fusion. `HYBRID_MODE=false` still falls back to
  dense-only.
- **Pure relevance ranking.** No recency boost, no importance/pinning, no
  decay. Best semantic+lexical match wins, full stop.
- **Returns full parent memories**, deduped (see §4.2), each with `id`,
  `title`, `content`, and the fused score.

---

## 6. MCP tool surface (3 tools)

Deliberately minimal. Delete/list/export/import live in the desktop app, not
the agent surface — the agent's job is save, recall, and edit.

### `save_memory`
Persist a new memory.

- **Input:** `content` (string, required), `title` (string, optional).
- **Behavior:** chunk → embed each chunk via Gemini → store with a new
  `parent_id`. Set `created_at`/`updated_at`.
- **Returns:** the new memory `id` (and the resolved/auto-derived title).
- **When the agent should call it:** only when the user explicitly says to
  remember/save something ("save this to memory", "remember that…").

### `recall`
Retrieve memories by natural language.

- **Input:** `query` (string, required), `limit` (number, optional, default
  ~5–10).
- **Behavior:** hybrid search over chunks → resolve to full parents → dedupe →
  rank by fused relevance.
- **Returns:** a list of full memories (`id`, `title`, `content`, score).
- **When the agent should call it:** only when the user points it at memory
  ("check your memory layer", "how do we usually do X", "what were those
  credentials").

### `update_memory`
Revise an existing memory in place.

- **Input:** `id` (string, required), `content` (string, required), `title`
  (string, optional).
- **Behavior:** delete the memory's existing chunks → re-chunk → re-embed →
  re-insert under the same `id`. Bump `updated_at`.
- **No delete via MCP.** Deletion is a deliberate management action and lives
  in the desktop app. (Earlier idea of "edit to empty = delete" is dropped to
  keep the contract clean; the agent edits, the human deletes.)

> **Embeddings required:** `save_memory`, `recall`, and `update_memory` all hit
> Gemini and therefore require `GEMINI_API_KEY`.

---

## 7. Desktop app (zero-native) — management UI

### 7.1 What it's for

A **manage-only** native app that opens straight into the user's memory layer:

- Browse / list all memories (sorted by recency via `updated_at`).
- View a memory's full content + title.
- Create a new memory.
- Edit an existing memory.
- Delete a memory.
- **Export** all memories to a portable file.
- **Import** memories from such a file.

**No semantic search box in the UI** (per decision). Semantic recall is an
agent/MCP capability; the UI is a fast local manager. Browsing/deleting/
export/import are plain DB reads/writes (no embeddings); only **create/edit**
trigger a Gemini embed, and that happens server-side in the sidecar, never in
the browser.

### 7.2 Architecture (Option A: thin Zig shell + ephemeral Node sidecar)

The crux: the native shell is **Zig**, but all memory logic lives in **Node**
(`gemdex-core` → LanceDB via Rust bindings). Zig cannot and should not touch
the store. So:

```
┌─────────────────────────────────────────────────────────────┐
│  zero-native desktop app                                      │
│                                                               │
│   ┌───────────────┐         spawns on launch,                 │
│   │  Zig shell    │────────▶ kills on close                   │
│   │  (runner)     │              │                            │
│   │  window +     │              ▼                            │
│   │  CSP/nav      │      ┌──────────────────┐                 │
│   │  policy       │      │  Node sidecar    │                 │
│   └───────┬───────┘      │  `gemdex serve`  │                 │
│           │              │  • wraps         │                 │
│           │ loads        │    gemdex-core   │                 │
│           ▼              │  • owns LanceDB   │                │
│   ┌───────────────┐      │    for the UI    │                 │
│   │  WebView      │      │  • embeds on      │                │
│   │  (web UI)     │ fetch│    create/edit   │                 │
│   │               │─────▶│  • localhost     │                 │
│   │  browse/edit/ │ JSON │    HTTP/JSON     │                 │
│   │  export/import│◀─────│    127.0.0.1:PORT│                 │
│   └───────────────┘      └────────┬─────────┘                 │
└───────────────────────────────────┼───────────────────────────┘
                                     │
                                     ▼
                          ┌────────────────────┐
                          │  LanceDB store      │
                          │  ~/.gemdex/...      │
                          └────────▲───────────┘
                                   │ direct access
                          ┌────────┴───────────┐
                          │  gemdex-mcp         │  ← separate process,
                          │  (agent's MCP)      │     spawned by the agent
                          └────────────────────┘
```

Responsibilities:

- **Zig shell** is brain-dead: opens the window, applies navigation + CSP
  policy (allowing `connect-src` to `127.0.0.1:<port>`), spawns the Node
  sidecar on launch, kills it on exit. **No memory logic in Zig.**
- **Node sidecar (`gemdex serve`)** is a new run-mode of the gemdex package. It
  wraps `gemdex-core`, owns LanceDB access for the UI, performs Gemini
  embedding on create/edit, and exposes a localhost HTTP/JSON API (list, get,
  create, update, delete, export, import).
- **Web UI** talks to the sidecar with `fetch`. Using localhost HTTP (not the
  Zig bridge) **sidesteps the bridge's 16 KiB request/response cap** — critical
  so a 300-line memory is never truncated. The zero-native skill explicitly
  warns against forcing large data through one bridge response.

### 7.2.1 Sidecar localhost API (the UI ↔ sidecar contract)

`gemdex serve` binds `127.0.0.1:<port>` and exposes JSON over HTTP. This is the
**management** surface (no semantic search — that's MCP-only). Suggested
endpoints (final shapes are build-time, but cover these operations):

| Method + path | Purpose | Body / returns |
|---|---|---|
| `GET /health` | readiness probe for the shell handshake | `{ ok: true }` |
| `GET /memories` | list for browsing (sorted by `updated_at` desc) | returns `[{ id, title, preview, created_at, updated_at }]` — `preview` is a truncated content snippet so the list stays light |
| `GET /memories/:id` | full memory for the detail view | `{ id, title, content, created_at, updated_at }` |
| `POST /memories` | create | body `{ content, title? }` → embeds via Gemini → `{ id }` |
| `PUT /memories/:id` | edit | body `{ content, title? }` → re-chunk + re-embed |
| `DELETE /memories/:id` | delete (UI-only capability) | `{ ok: true }` |
| `GET /export` | dump all memories | streams the portable file (§7.5) |
| `POST /import` | restore/merge | accepts the portable file (§7.5) |

Notes for the implementer:
- **Bind localhost only.** Never `0.0.0.0`. This is a single-user local app.
- `create`/`edit`/`import` need `GEMINI_API_KEY` (they embed); `list`/`get`/
  `delete`/`export` do not.
- The sidecar shares the **same `gemdex-core` + LanceDB store** the MCP server
  uses (`~/.gemdex/...`), so a memory saved by the agent shows up in the app and
  vice-versa.

### 7.3 The required UX (non-negotiable)

> *"User just adds the MCP and goes. Then they install the app and on launch it
> instantly opens their memory layer to manage. No extra commands."*

- **Agent side:** user adds `gemdex-mcp` to their MCP client (one line / one
  plugin install) and sets `GEMINI_API_KEY`. Done. Save/recall/update work.
- **App side:** user installs the app and launches it. The app **auto-spawns
  the sidecar itself** and opens directly into the memory manager. **The user
  never runs a sidecar command.**

To honor "launch and it just works," the app must carry everything it needs to
start the sidecar with no user action. Recommended: **bundle the Node serve
runtime (and the per-platform LanceDB native binding) inside the packaged
app**, so it's self-contained and works regardless of the user's Node setup.
(Fallback option: transparently invoke `npx -y gemdex serve` on launch when a
system Node is present — still no user command, but slower cold start and needs
network the first time.) Final bundling mechanism is a build-time decision; the
**contract is "no manual step."**

#### Shell ↔ sidecar handshake (launch sequence)

The Zig shell drives this in its `start_fn` lifecycle callback (see §7.6):

1. **Spawn** the sidecar as a child process: `gemdex serve --port 0`
   (`--port 0` = let the OS pick a free port to avoid collisions). Capture the
   child PID so it can be killed on exit.
2. **Discover the port.** Two clean options — pick one at build time:
   - sidecar prints `PORT=<n>` (or a JSON line) to stdout on bind; shell reads
     it; **or**
   - shell picks a free port itself and passes it in via `--port <n>` / env.
3. **Pass the port to the web UI.** Inject it into the WebView as a global
   (e.g. `window.GEMDEX_API = "http://127.0.0.1:<port>"`) or expose a trivial
   `getApiBase` bridge command the UI calls once on load. The UI then `fetch`es
   that base for every operation in §7.2.1.
4. **Wait for readiness.** UI (or shell) polls `GET /health` until `ok` before
   rendering the list, so the window never shows an empty/error state on a cold
   start.
5. **Lifecycle.** On window close / app quit (`stop_fn`), the shell **kills the
   sidecar child**. The sidecar is ephemeral — it exists only while the app is
   open. No lingering process, no daemon.

#### CSP / navigation policy

The packaged UI is served from `zero://app`, but it must be allowed to talk to
the local sidecar. In `app.zon` security policy, the production CSP must include
the sidecar in `connect-src`:

```
connect-src 'self' http://127.0.0.1:*;
```

and `security.navigation.allowed_origins` keeps `zero://app` (main-frame
navigation stays locked down — only `fetch`/XHR reaches the sidecar). Keep
external links denied. See §7.6 and the zero-native core skill for the exact
manifest shape.

### 7.4 Concurrency

Two processes can open the store: the agent's `gemdex-mcp` (direct access) and
the app's sidecar. Reads are always safe. The rare case is a **simultaneous
write** from both at once, reconciled by **LanceDB's optimistic concurrency**
(versioned manifests; retry-on-conflict on the writer side). No always-on
daemon, no lock server. This keeps the "no daemon" promise; the trade is a tiny
write-collision window handled by retry.

### 7.5 Export / import

- **Export:** dump all memories to a portable file (JSONL recommended): one
  record per memory with `id`, `title`, `content`, `created_at`, `updated_at`.
  Optionally include stored embeddings to make re-import offline/fast.
- **Import:** restore/merge from such a file. If embeddings are present and the
  model/dimension match, reuse them; otherwise re-embed via Gemini on import.
  Merge policy (overwrite by `id` vs. insert-as-new) is a build-time detail to
  settle; default suggestion: upsert by `id`.

### 7.6 zero-native build guide (concrete steps)

> **Load the skill first** (`npx zero-native skills get core --full`) — it is
> the authoritative reference. This subsection is the distilled path for *this*
> app so the handoff is self-contained. Commands verified against
> `zero-native` CLI v0.2.0.

**Scaffold.** Pick a web framework for the frontend (Vite/React is a good fit
for a simple manager UI; `next`, `vue`, `svelte` also supported):

```bash
npm install -g zero-native
zero-native init gemdex-app --frontend react   # next|vite|react|svelte|vue
cd gemdex-app
zig build run                                  # first run installs frontend deps + opens the window
```

**Generated files you will edit** (see `references/project-anatomy.md` in the
skill):

- `app.zon` — manifest. Set `id` (e.g. `com.gemdex.memory`), `display_name`
  ("Gemdex Memory"), `windows` (one `main` window, `restore_state = true`), the
  `frontend` dist/dev config, `web_engine = "system"`, and the **security
  policy** (CSP `connect-src` for the sidecar — §7.3). Keep `permissions` /
  `capabilities` minimal.
- `src/main.zig` — `App` state + WebViewSource. Use the dynamic
  `frontend.sourceFromEnv` pattern (dev server in dev, packaged assets in prod).
- `src/runner.zig` — `Runtime.init` wiring. **This is where the sidecar
  lifecycle lives:** spawn `gemdex serve` in the start path, kill it on stop.
- `build.zig` — build graph (frontend install/build/dev steps are pre-wired by
  the template).
- `frontend/` — the management UI (browse/create/edit/delete/export/import).
  Plain web code calling the sidecar via `fetch` (§7.2.1).

**Where the sidecar spawn goes.** In `src/runner.zig` / the `App` lifecycle,
use `start_fn` to launch the child process and `stop_fn` to terminate it (Zig's
`std.process.Child`). The Zig side does **nothing** with memories — it only
manages the child process and hands the port to the WebView (§7.3).

**Dev loop.** Run the frontend dev server + native shell together:

```bash
zig build dev          # or: zero-native dev --manifest app.zon --binary zig-out/bin/<bin>
```

`dev` starts the frontend, waits for readiness, sets `ZERO_NATIVE_FRONTEND_URL`,
launches the shell, and tears the frontend down on exit.

**Smoke test (optional but recommended).** Build with automation and verify the
window comes up (see `npx zero-native skills get automation`):

```bash
zig build run -Dautomation=true
zero-native automate wait        # blocks until ready=true
zero-native automate snapshot    # confirm app/window/source metadata
```

**Package for distribution.** Produces a self-contained app bundle:

```bash
zig build package
# or, per-platform:
zero-native package --target macos --binary zig-out/bin/<bin> --assets frontend/dist \
  --signing adhoc            # use `identity` + --team-id/--entitlements for notarization
zero-native package-linux   --binary zig-out/bin/<bin>
zero-native package-windows --binary zig-out/bin/<bin>.exe
```

> **Packaging must include the bundled sidecar runtime** (§7.3) so the installed
> app launches with zero user steps. Validate the manifest before release:
> `zero-native doctor --strict --manifest app.zon`.

**Where the desktop app lives in the repo.** Add it as a new workspace member,
e.g. `packages/app/` (or a top-level `app/`), alongside `packages/core` and
`packages/mcp`. It depends on the published `gemdex` package for `gemdex serve`,
or invokes the bundled sidecar — not on `gemdex-core` directly (Zig can't import
it).

---

## 8. Embeddings & storage config

**Embeddings stay on Gemini** (`gemini-embedding-2`), lowest-churn and
consistent with the kept name. `GEMINI_API_KEY` required.

Env vars **kept**: `GEMINI_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`,
`EMBEDDING_BATCH_SIZE`, `GEMINI_BASE_URL`, `HYBRID_MODE`, `LANCEDB_PATH`
(default `~/.gemdex/lance`, now holding the single global memory store).

Env vars **removed** (code-search only): `INDEX_MULTIMODAL`,
`CUSTOM_EXTENSIONS`, `CUSTOM_IGNORE_PATTERNS`, `GEMDEX_BACKGROUND_SYNC`,
`GEMDEX_SYNC_INTERVAL_MS`, `GEMDEX_TRIGGER_WATCHER`,
`CODE_CHUNKS_COLLECTION_NAME_OVERRIDE`, splitter selection.

New sidecar var (app only): a localhost port for `gemdex serve` (auto-chosen,
overridable).

---

## 9. End-to-end flows

**Save (agent):**
```
User: "Save how we set up the Junie review workflow to memory."
Agent → save_memory(content=<the writeup>, title="Junie review workflow setup")
      → returns id
```

**Recall (agent, later, different repo):**
```
User: "Set up the Junie review workflow here — check your memory layer."
Agent → recall(query="set up Junie review workflow")
      → gets the full playbook memory back → follows it
```

**Edit (agent):**
```
User: "The notarization step changed — update that memory."
Agent → update_memory(id=<id>, content=<revised>)
```

**Manage (human, desktop app):**
```
Launch app → memory list appears instantly → user deletes a stale credential,
edits a playbook, exports a backup. No commands run.
```

---

## 10. Plugin / skill changes

The Claude Code plugin is repurposed:

- **Remove** the `code-search` skill and the `PostToolUse` auto-reindex hook
  (no files to track anymore).
- **Add** a **memory skill** that nudges the agent on *when* to use the tools:
  - `save_memory` when the user says remember/save to memory.
  - `recall` when the user points at memory ("check your memory", "how do we
    usually…", "where are the … credentials").
  - `update_memory` to revise.
  - **Explicit only** — never auto-capture a session, never recall unprompted.
- The MCP still ships via `npx -y gemdex-mcp@latest`; `GEMINI_API_KEY` prompt
  unchanged.

---

## 11. Removal checklist (the "revamp" deletions)

- **MCP tools:** `index_codebase`, `search_code`, `clear_index`,
  `get_indexing_status`.
- **Core indexing:** AST/tree-sitter splitters and all grammars; LangChain
  character splitter; Merkle-tree incremental sync; file watcher /
  `~/.gemdex/.sync-trigger`; periodic background sync; multimodal (PDF/image)
  indexing; per-repo snapshot manager; per-repo table naming.
- **MCP package:** `snapshot.ts`, `sync.ts`, splitter wiring, and code-search
  handlers in `handlers.ts`; the code-search tool definitions in `index.ts`.
- **Config/env:** the code-search vars listed in §8.
- **Docs/branding:** rewrite `README.md` around the memory layer; update
  package descriptions. Keep the `gemdex` name throughout.

> Net effect: `gemdex-core` shrinks to **embedding + LanceDB hybrid retrieval +
> memory chunking**; the file-derived indexing subsystem is gone.

---

## 12. Non-goals (v1)

- No scoping, tagging, or project buckets.
- No secret encryption, redaction, or any safety enforcement.
- No proactive/automatic capture or recall.
- No semantic search inside the desktop UI.
- No recency/importance ranking, pinning, TTL, or auto-expiry.
- No cloud sync or multi-machine sync service (export/import covers backup).
- No always-on daemon.

---

## 13. Open build-time decisions (don't block the spec)

These don't change the product; settle them during implementation:

1. **Store layout** — single table with an `is_parent` flag vs. separate
   parent/chunk tables (contract in §4.2 holds either way).
2. **Sidecar packaging** — bundle Node + LanceDB native binding into the app
   (recommended, fully self-contained) vs. transparent `npx` fallback. Must
   preserve "no manual step."
3. **Import merge policy** — upsert by `id` (suggested default) vs.
   insert-as-new vs. user choice in the UI.
4. **Export embeddings** — include vectors for fast offline re-import vs.
   content-only and always re-embed.
5. **Chunking parameters** — chunk size/overlap and the title auto-derivation
   heuristic.
6. **Write-conflict retry policy** — backoff/retry count for the rare
   simultaneous-write case.

---

## 14. Naming

Stays **gemdex** (`gemdex-mcp`, `gemdex-core`, `~/.gemdex`). The README and
taglines change from "semantic code search" to "memory layer for AI coding
agents," but the package identity, npm listing, and GitHub repo/stars are
preserved.
