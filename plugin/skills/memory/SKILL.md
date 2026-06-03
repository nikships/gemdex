---
description: Use the Gemdex memory layer MCP tools (`save_memory`, `recall`, `update_memory`) to give the agent durable, global memory across repos and sessions. EXPLICIT ONLY — save when the user says remember/save to memory, recall when the user points at memory ("check your memory layer", "how do we usually do X", "where are the … credentials"), update to revise. Never auto-capture a session and never recall unprompted. Memories are one global pool; embeddings handle disambiguation. Requires GEMINI_API_KEY. If these tools aren't in your toolset, the MCP isn't connected.
---

# Gemdex memory layer

`gemdex` MCP exposes three tools that read/write a **global, persistent memory
layer** stored locally (LanceDB at `~/.gemdex/`). Memory is shared across every
repo and session, so something saved here is recallable everywhere. Retrieval is
hybrid semantic + BM25 and always returns **whole memories, never fragments**.

If `save_memory` / `recall` / `update_memory` aren't in your toolset, the MCP
isn't connected — don't bring it up unless asked.

## The three tools

- `save_memory(content, title?, attachments?)` — persist a new memory. Returns its `id`.
- `recall(query, limit?, attachments?)` — retrieve full memories by natural
  language (and/or media), ranked by relevance. Default `limit` ~10.
- `update_memory(id, content?, title?, attachments?)` — replace an existing
  memory in place under the same `id`.

There is **no delete tool** — deletion is a deliberate human action in the
Gemdex desktop app. The agent saves, recalls, and edits; the human manages.

### Attaching media (image / audio / video / PDF)

`save_memory`, `update_memory`, and `recall` accept an optional `attachments`
array. Each attachment is **either** a local file `path` **or** inline base64
`data` — prefer `path`: the local server reads and encodes the bytes, so you
never emit base64 in the tool call.

> "Remember this screenshot — it's the login bug." (file at /tmp/login-bug.png)
→ `save_memory(content="login bug repro", attachments=[{ path: "/tmp/login-bug.png" }])`

> "Find the memory that matches this diagram." (file at ./arch.png)
→ `recall(attachments=[{ path: "./arch.png" }])`

`mimeType` is inferred from the file extension (png/jpg/jpeg, mp3/wav, mp4/mov,
pdf); pass it explicitly to override. Requires the gemini-embedding-2 model.

## When to use them — EXPLICIT ONLY

This is the most important rule. Act only when the user clearly points at memory.

**Save** when the user says to remember/save:
> "Save how we set up the Junie review workflow to memory."
→ `save_memory(content=<the writeup>, title="Junie review workflow setup")`

**Recall** when the user points at memory or asks how "we" usually do something:
> "Set up the Junie review workflow here — check your memory layer."
> "How do we usually deploy?" · "What were those signing credentials?"
→ `recall(query="set up Junie review workflow")` → follow the returned playbook.

**Update** when the user asks to revise a stored memory:
> "The notarization step changed — update that memory."
→ get the `id` (from a prior save/recall), then `update_memory(id, content=<revised>)`.

## Do NOT

- Do **not** capture or summarize a session into memory unprompted.
- Do **not** recall in the background or "just in case." Only when the user
  asks you to consult memory.
- Do **not** sort memories into buckets/tags — there is one global pool;
  embeddings do the disambiguation. Just write a clear `content`.

## Notes

- Memories can hold anything the user chooses, including credentials — stored
  in plaintext locally by design. Treat returned content as sensitive.
- `recall` returns each memory's `id`, `title`, full `content`, and a relevance
  score line (`fused=…`). Use the content directly; cite the `title` when
  helpful.
- All three tools embed via Gemini and require `GEMINI_API_KEY`.
