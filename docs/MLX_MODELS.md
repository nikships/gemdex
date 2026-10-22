# Local MLX model and managed runtime

## Decision

The local package uses **[`mlx-community/embeddinggemma-2-8bit`](https://huggingface.co/mlx-community/embeddinggemma-2-8bit)**,
the MLX conversion of [Google EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)
(released 2026-10-06, Apache-2.0). Gemdex runs the **whole model**: the text
encoder (270M parameters, Gemma 4 decoder, 8192-token context) plus its vision
and audio towers. Text chunks, images, audio and video are embedded into one
**768-dimensional** space, so a text query finds media and a media query finds
text. The model also supports Matryoshka truncation to 512/256/128 dimensions;
Gemdex does not use it.

The immutable HF revision is `7505ef2f8ddef45efef6d060865f27989b3c9cec`
(8-bit affine, group size 64). `packages/core/src/embedding/mlx-manifest.ts` is
the single source of URLs and SHA-256 digests for the model, the standalone
Python and every wheel. It is generated, never edited by hand (see
[Updating the runtime](#updating-the-runtime)).

Earlier releases used `mlx-community/bge-m3-mlx-8bit` (1024 dimensions, CLS
pooling, table `memories_mlx_bge_m3_8bit`), and before that Gemini
(3072 dimensions, table `memories`). Both remain readable legacy indexes; see
[Upgrade from earlier releases](#upgrade-from-earlier-releases).

### Why EmbeddingGemma 2

| Model | Published quality | Footprint / context / licensing |
|---|---|---|
| **EmbeddingGemma 2 (selected 8-bit conversion)** | Google reports 14% higher MTEB (Code) than EmbeddingGemma 1 while retaining its multilingual text accuracy | Text encoder 270M parameters; 768d/MRL; 8192 tokens; Apache-2.0. The conversion's single weight file is 1,234,238,431 bytes because it also carries the BF16 vision/audio towers. |
| BGE-M3 (previous) | 59.56 MTEB multilingual mean-task in Qwen's June 2025 comparison | 603.6 MB weights; 1024d; 8192 tokens; MIT |

These are publisher-reported benchmark snapshots, not a Gemdex retrieval
evaluation and not guarantees for a community quantization. The reason for the
switch is better code/technical retrieval (most Gemdex memories are coding
knowledge), a permissive license, and a smaller vector (768 vs 1024 floats per
chunk). No M5 timing is claimed.

Sources:

- [Google launch post](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2)
  and [developer guide](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/)
  (architecture, task prompts, MRL dimensions, benchmarks).
- [Selected immutable conversion](https://huggingface.co/mlx-community/embeddinggemma-2-8bit/tree/7505ef2f8ddef45efef6d060865f27989b3c9cec)
  and its `validation.json` (8-bit vs PyTorch FP32: minimum text cosine 0.99981).
- [mlx-vlm PR #2446](https://github.com/Blaizzy/mlx-vlm/pull/2446): the MLX
  implementation, released on PyPI in mlx-vlm 0.7.9, which Gemdex installs.

## Correct EmbeddingGemma 2 inference

The retrieval contract comes from the pinned sentence-transformers files, and
the worker asserts it before loading weights:

- `modules.json`: Transformer → Pooling → Normalize (no Dense projection; the
  text model's own `embedding_projection` maps 512 → 768).
- `1_Pooling/config.json`: **mean** pooling over all tokens, **including the
  prompt** (`include_prompt: true`), then L2 normalization.
- `config_sentence_transformers.json`: queries are prefixed with
  `task: search result | query: `, stored documents with
  `title: none | text: `. `MlxEmbedding.embedQuery` and
  `embedQueryContentBatch` send `kind: "query"`; `embed`/`embedBatch`/
  `embedContentBatch` (save, update, import, migration) send `kind: "document"`.
  Titles are not put into the document prompt, so title-only edits never need
  re-embedding.
- Media gets the same prompt followed by the modality placeholder
  (`<|image|>`, `<|audio|>` or `<|video|>`), which the processor expands into
  the media tokens. This matches sentence-transformers, which puts the prompt
  in a system turn ahead of the media.

The worker calls upstream mlx-vlm unmodified: `mlx_vlm.load(model_dir)` for the
model and processor, the processor for tokenization and media preprocessing,
and the model's own pooled `text_embeds`. It asserts `<bos>` first and
`<eos>` last, a 768-dimensional finite result, and at most **8192 tokens** per
input (the model's context). Longer input fails rather than truncating;
MemoryStore's 1500-character chunks are far below it.

Media handling:

- **Images**: PNG, JPEG, WebP, GIF (first frame), decoded with Pillow.
- **Audio**: WAV, MP3 and FLAC decode directly; M4A/AAC/AIFF are converted with
  macOS's built-in `/usr/bin/afconvert` first. Audio is resampled to the model's
  rate. At 40 ms per token, the 5-minute limit is 7,500 tokens; the worker
  raises the processor's default audio length to that.
- **Video**: MP4, MOV, M4V, WebM, sampled by the processor at 1 frame per second
  up to 32 frames, so a longer clip spreads those frames out.

Audio-only matching is noticeably weaker than image or text matching (about 25%
recall@1 on a Clotho audio-to-caption sample), so an optional caption helps:
MemoryStore indexes it as the BM25 text of that attachment's row.

### Similarity threshold

Centroid cosine scores are higher on EmbeddingGemma 2 than on Gemini/BGE.
`DEFAULT_HYGIENE_THRESHOLD` (hygiene clustering and save-time similar-memory
detection) is **0.93**. It was calibrated read-only on 1,463 parents
(1.07M pairs) of the same real store the original 0.90 was tuned on: 0.93
yields the same number of flagged pairs (1,681) as the Gemini baseline at 0.90,
while 0.90 would flag 5,866 (3.5×). At 0.93, 71% of the baseline's flagged
pairs are still flagged. `GEMDEX_SIMILAR_THRESHOLD` still overrides
save-time detection.

## Runtime and security boundary

User prerequisites: Node/Gemdex and **native arm64 macOS 14+**. No preinstalled
Python, pip, uv, HF CLI, Homebrew, compiler, or shell bootstrap script is needed.
Rosetta x64 Node and non-Mac hosts fail clearly at explicit install/inference;
construction and status stay lazy. macOS's built-in `/usr/bin/tar` extracts only
the already SHA-256-verified archive.

The installer downloads about **1.45 GB**:

- CPython **3.12.12**, python-build-standalone release **20260211**,
  `aarch64-apple-darwin-install_only_stripped` (the whole archive is
  hash-pinned).
- **73 wheels (about 207 MB)**: the complete dependency closure of
  **`mlx-vlm==0.7.9`** for macOS 14 arm64 / CPython 3.12, one wheel per package,
  each hash-pinned. They include `mlx`/`mlx-metal` 0.32.4, `transformers`,
  `numpy`, `Pillow`, `opencv-python`, `mlx-audio` and `miniaudio`. This is the
  ordinary upstream package, not a subset. The wheels are installed offline
  with `pip --no-index --no-deps` and deleted after install.
- The model's 14 files (1.2 GB, mostly the single `model.safetensors`).

On disk the install is about **1.9 GB**. No resolver or source build runs on
the user's machine; the closure is resolved once by the maintainer.

Install storage is `~/.gemdex/mlx/<manifest-and-worker-hash>/`; `homeDir`
overrides the **Gemdex root**, not the OS home directory. Because the hash
covers the manifest and worker, every runtime change gets a new directory.
Files whose hash matches one in an older sibling install (e.g. the 1.2 GB
weights) are copied from it (an APFS clone where possible) and verified, so an upgrade does not download the
model again. Older directories are never deleted automatically, since an older
desktop app or npx process may still be using them. Once every client is
upgraded, the user can delete `~/.gemdex/mlx/<hash>` directories other than the
one `npx gemdex-mcp status` reports. The same-hash staging directory retains
only useful completed downloads for interrupted retry. `.part` files are
removed on ordinary offline/hash failures; retries overwrite any crash-left
partial. An exclusive PID lock rejects concurrent installers; dead-owner locks
can be recovered. The installed marker appears only after all download hashes,
the installed-runtime inventory, and a real smoke test pass: one text and one
small PNG must both return normalized 768d vectors, which proves the vision path
loads. The installer does not change settings or index tables.
`npx gemdex-mcp install` is the explicit download action.

### Upgrade from earlier releases

**From the text-only EmbeddingGemma 2 release:** run `npx gemdex-mcp install`
again (new install id; the weights are reused locally). No migration: the
worker produces the same text vectors as the earlier curated runtime (cosine
1.0 in one venv; 0.99984 minimum across the mlx 0.32.3 → 0.32.4 upgrade, which
is Metal rounding). Media saved before this release stays an unembedded blob
until its memory is next updated or re-imported, which embeds it.

**From BGE-M3 or Gemini:** `npx gemdex-mcp migrate` (or Settings → Migrate in
the desktop app) moves parents from every older index into
`memories_mlx_embeddinggemma2_8bit`, in order: `memories_mlx_bge_m3_8bit`
(BGE-M3 releases), then `memories` (Gemini releases). `MemoryStore` takes them
as `legacyCollectionNames`. Until migration finishes, recall and hygiene refuse
to run; list/get/update/delete/export stay available, and an update moves that
memory into the new index. Migration re-embeds each stored chunk's text and each
stored image/audio/video blob, preserves metadata, timestamps and attachment
blobs, and commits destination rows before deleting source rows. A parent with
nothing else to embed gets a title row. Legacy PDFs stay readable blobs, since
EmbeddingGemma 2 has no PDF input. A file the model cannot decode also stays a
readable, unsearchable blob rather than failing the migration. Stable row ids
make it rerunnable. A parent left in two old indexes by an interrupted
migration is counted once.

An upgraded npx package reports the model as not installed until
`npx gemdex-mcp install` runs again (new install id), so the order is
**install, then migrate**. An older desktop app or sidecar still writes to the
BGE-M3 table; rerunning migrate picks those writes up.

### Inference lifecycle

Status is synchronous and cheap (marker only). Before first inference per
provider instance, the engine verifies artifact hashes, the exact worker source,
and the installed Python tree against its recorded digest. This detects
corruption; it is not a security boundary against an attacker who can rewrite
both the user's runtime and verification files. Python runs isolated
(`-I -B`); imports cannot come from user site packages or `PYTHONPATH`.
Inference has no downloader and uses only local file paths. Offline environment
flags are set as an additional guard, not the sole enforcement.

JSONL stdin/stdout frames carry `{id, kind, inputs}`, where each input is
`{text}` or `{path, mimeType}`, with at most 16 inputs and 1 MiB per frame;
stderr is drained, not emitted into MCP stdout. Media bytes never cross the
pipe: `MlxEmbedding` writes them to a private `mkdtemp` directory (files mode
0600) and removes it after the request. One request is in flight per worker;
the provider admits at most 16 batches of at most 256 inputs / 1 MiB of text
each, and each worker request times out after 300 seconds (long video and audio
decode). MemoryStore embeds media one file per request and submits long
parents in bounded batches. The MLX cache is capped at 256 MiB and cleared
after every input; there is no allocation limit, because a 20 s video peaks at
about 5.4 GB. Idle workers are killed after 60 seconds; their pipes are
unreferenced so a finished CLI can exit immediately. Explicit `close()` and
parent process exit kill the child. No port is opened.

Measured on an Apple Silicon Mac: worker start plus model load about 5 s;
warm text about 10 ms, image about 0.12 s, 20 s of video about 5 s (2,449
tokens); 162 s of audio peaks at about 3 GB.

Public APIs, exported by `embedding/index.ts` (already re-exported at core root):

```ts
new MlxEmbedding({ homeDir?: string }); // lazy, multimodal, 768d
installMlxModel({ homeDir?: string, onProgress?: (message: string) => void }): Promise<void>;
getMlxStatus(homeDir?: string): { installed: boolean; model: string; revision: string; dimension: number; path: string };
// embed / embedBatch / embedContentBatch (document prompt),
// embedQuery / embedQueryContentBatch (query prompt), close(): void
```

## Verification

On an Apple Silicon Mac (macOS 27):

- **Text parity:** the full-runtime worker and the previous curated text worker
  produce cosine 1.0 for documents and queries (short, long, multilingual and
  code inputs) in one environment, and at least 0.99984 between the old
  install's mlx 0.32.3 and this install's 0.32.4.
- **Cross-modal smoke:** a red-circle PNG scores 0.82 against the query
  "red circle"; an M4A recording of "how do I reset my password" scores 0.84
  against that query. A smoke check, not a retrieval benchmark.
- **End to end:** an isolated install (weights reused from a sibling), then the
  built stdio MCP server: save PNG/M4A/MP4 by path, recall by text, by image and
  by video file, combined text + file recall, `read_attachment` image content,
  and refusal of PDFs and of text files as recall examples.

Unit tests use real child processes for frame handling, timeouts, crashes,
dimension and bounds checks; controlled installer fixtures cover platform
refusal, offline cleanup/retry, lock recovery, idempotency, integrity failures,
private media temp files, and smoke-before-marker ordering. Store tests cover
media rows, recall by media (RRF fusion), update/import/migration of media, and
multi-index migration.

## Updating the runtime

`scripts/generate-mlx-manifest.py` rewrites `mlx-manifest.ts`. Change its
`MLX_VLM` requirement (or the `REVISION`/`PYTHON` constants) and run, from the
repository root:

```bash
uv run scripts/generate-mlx-manifest.py
```

It resolves the `mlx-vlm` closure with uv for macOS 14 arm64 / CPython 3.12
(`MACOSX_DEPLOYMENT_TARGET=14.0`), picks one wheel per package from the PyPI
JSON API with its SHA-256, and pins every model file from the Hugging Face API
at the revision. Then rebuild, run the installer and store tests, and check text
parity before shipping: install into an isolated Gemdex root and compare the new
worker's text vectors with the previous release's on the same inputs (both
`kind`s). Cosine must be about 0.9998 or higher; a lower score means stored
vectors changed and the release needs a re-embedding migration instead.

```bash
pnpm --filter gemdex-core build
node -e "require('./packages/core/dist/embedding').installMlxModel({ homeDir: '/tmp/gemdex-eg2', onProgress: console.log })"
```

Each inference input is one JSONL line on the installed worker's stdin:
`{"id":1,"kind":"document","inputs":[{"text":"Mars is the Red Planet."}]}`.
Run `<install>/python/bin/python3 -I -B -u <install>/worker.py <install>/model`
for the new release and the previous release's equivalent, then compare the
`vectors` they print.
