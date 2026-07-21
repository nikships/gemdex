---
name: gemdex-consolidate
version: 1.0.0
description: |
  Sweep the user's entire gemdex memory layer and clean it up: fan out parallel
  subagents that read every stored memory, cluster near-duplicates and stale or
  contradicted notes, merge each cluster into one canonical battle-tested memory,
  and HARD-DELETE the losers and the junk. Use when the user says "consolidate my
  memories", "clean up gemdex", "dedupe my memory layer", "merge duplicate
  memories", "prune bad memories", "my memory layer is a mess", or after a burst
  of proactive auto-saves has bloated the store. Autonomous: it merges and deletes
  without per-item confirmation. Requires the gemdex sidecar (local mode needs a
  validated GEMINI_API_KEY).
---

# Consolidate the gemdex memory layer

Proactive saving means the store grows fast and accumulates duplicates, stale
notes, and contradictions. This skill does a full **consolidation sweep**:

> read everything → cluster related memories → merge each cluster into one
> canonical memory → **hard-delete** the merged-away sources and the junk.

It is **autonomous**: once the user asks for a cleanup, it merges and deletes
without asking per item. It uses parallel subagents so a large store is scanned
fast. All destruction goes through the sidecar's `DELETE /memories/:id` route —
the MCP surface has no delete tool, so this skill drives the sidecar directly
via `scripts/gemdex_admin.py`.

⚠️ **Deletes are hard and irreversible.** There is no archive/undo. The safety
model here is *merge-before-delete*: never delete a memory whose unique facts
have not been folded into a surviving canonical memory (or that isn't provably
redundant/wrong). Print a final manifest of every merge and delete.

## Tooling

Everything goes through one helper (boots `gemdex serve`, does the
`PORT=<n> TOKEN=<hex>` handshake, calls the token-gated routes, tears the
sidecar down):

```
python3 scripts/gemdex_admin.py export                 # JSONL: full content of EVERY memory
python3 scripts/gemdex_admin.py list                   # id \t title \t updatedAt
python3 scripts/gemdex_admin.py get <id>               # one full memory
python3 scripts/gemdex_admin.py save   --file body.json   # create canonical merged memory
python3 scripts/gemdex_admin.py update <id> --file body.json
python3 scripts/gemdex_admin.py delete <id> [<id> ...]    # HARD delete
```

`body.json` for save/update is `{ "content": "...", "title": "..." }`.

If the helper prints *"no validated GEMINI_API_KEY"*, stop and tell the user to
set the key in the desktop app or `~/.gemdex/.env` — local mode can't read
memories without it.

## Procedure

### 1. Snapshot the whole store
Run `export` once and save the JSONL to a scratch file. This is the ground
truth every subagent works from — full content, not previews. Also keep a
`list` for a quick id/title/age index.

**Print the snapshot count** (`N memories`). If `N` is small (≤ ~15), skip the
subagent fan-out and do the clustering yourself inline — subagents are only
worth it at scale.

### 2. Cluster (fan out subagents for large stores)
Split the exported memories into batches and launch **parallel `explorer`
subagents** (read-only), one per batch, each returning proposed clusters. Give
each subagent the full text of its batch plus titles of all others so it can
point at cross-batch duplicates. Ask each to return, as strict JSON:

```json
{ "clusters": [
  { "memberIds": ["id1","id2"], "reason": "same notarization workflow",
    "verdict": "duplicate|superseded|contradicted|stale|keep" }
] }
```

Clustering rubric (match gemdex's own hygiene semantics):
- **duplicate** — same knowledge restated; merge into one.
- **superseded** — newer memory replaces an older one (trust `updatedAt`).
- **contradicted** — two memories disagree on a fact; keep the correct/newer,
  delete the wrong one, and note the resolution in the survivor.
- **stale** — clearly outdated (rotated creds, moved paths, old versions).
- **keep** — distinct, still valid; leave untouched.

Merge the subagents' cluster lists yourself and reconcile any id that appears in
two clusters (put it in the strongest-relationship cluster only).

### 3. Merge each cluster → one canonical memory
For every cluster that isn't a lone `keep`, synthesize ONE canonical memory:
- **Preserve every unique fact, command, path, and gotcha** across members.
- Prefer newer info on conflict; explicitly note any unresolved conflict.
- Give it a clear title; keep the best-written structure.
- Choose a **survivor id** (usually the newest/most-recalled member) and
  `update` it with the merged content, OR `save` a fresh canonical memory.
  Prefer `update` on the survivor so its id (and any external references) stay
  stable; only `save` fresh when no member is a good base.

### 4. Delete the losers and the junk (autonomous)
Only after the canonical memory exists and is confirmed written:
- `delete` every merged-away member (all cluster members except the survivor).
- `delete` standalone `stale`/`contradicted-wrong` memories.
- **Never** delete a `keep` or the survivor.

Batch the deletes: `gemdex_admin.py delete <id1> <id2> ...`.

### 5. Manifest
Print a final report:
```
Consolidation sweep complete.
Before: N memories → After: M memories (−K)
Merges:
  • "Notarization workflow" (survivor id …) ← merged 3: idA, idB, idC
Deletes (hard):
  • idA  "old notarize note"      (merged into …)
  • idX  "rotated staging token"  (stale)
```

## Guardrails
- **Merge before delete, always.** A member is only deletable once its unique
  content lives in a survivor (or it's provably redundant/wrong).
- **Autonomous but transparent.** No per-item prompts, but the manifest must
  account for every delete. If a cluster is ambiguous (can't tell which fact is
  correct), keep both and mark it `keep` rather than guess-deleting.
- **Idempotent-ish.** Re-running after a clean sweep should find few/no
  clusters. If the store is already tidy, say so and stop.
- Subagents are **read-only** (`explorer`): they propose clusters; only this
  top-level skill performs `save`/`update`/`delete`.
- One sweep = one `export` snapshot. Don't interleave deletes with clustering;
  finish clustering the snapshot first, then merge, then delete.
