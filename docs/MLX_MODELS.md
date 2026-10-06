# Local MLX model and managed runtime

## Decision

The local package uses **[`mlx-community/embeddinggemma-2-8bit`](https://huggingface.co/mlx-community/embeddinggemma-2-8bit)**,
the MLX conversion of [Google EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)
(released 2026-10-06, Apache-2.0). Gemdex runs only its **text encoder**
(270M parameters, Gemma 4 decoder, 8192-token context) and stores full
**768-dimensional** vectors. The model can also embed images, audio and video,
and supports Matryoshka truncation to 512/256/128 dimensions; Gemdex uses neither.

The immutable HF revision is `7505ef2f8ddef45efef6d060865f27989b3c9cec`
(8-bit affine, group size 64). `packages/core/src/embedding/mlx-manifest.ts` is
the single source of URLs and SHA-256 digests for the model, tokenizer,
standalone runtime, wheels and the upstream architecture source.

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
- [mlx-vlm PR #2446](https://github.com/Blaizzy/mlx-vlm/pull/2446), merged as
  `fec3f50379bb2cb0760ef3c8a68ebce9585e4d97`: the MLX implementation. At the
  time of the switch it was not yet in a PyPI release.

## Correct EmbeddingGemma 2 inference

The retrieval contract comes from the pinned sentence-transformers files, and
the worker asserts it before loading weights:

- `modules.json`: Transformer → Pooling → Normalize (no Dense projection; the
  text model's own `embedding_projection` maps 512 → 768).
- `1_Pooling/config.json`: **mean** pooling over all tokens, **including the
  prompt** (`include_prompt: true`), then L2 normalization.
- `config_sentence_transformers.json`: queries are prefixed with
  `task: search result | query: `, stored documents with
  `title: none | text: `. `MlxEmbedding.embedQuery` sends `kind: "query"`;
  `embed`/`embedBatch` (save, update, import, migration) send `kind: "document"`.
  Titles are not put into the document prompt, so title-only edits never need
  re-embedding.

The worker tokenizes with the Rust `Tokenizer.from_file`, adds special tokens,
and asserts `<bos>`=2 first and `<eos>`=1 last. Media placeholder ids are
replaced by padding before the embedding lookup, as upstream does. Token
embeddings are scaled by `sqrt(hidden_size)`; non-quantized weights and
activations stay BF16 (do not cast to float16). Each text is evaluated
separately (no padded batch), with an all-ones attention mask, so the sliding
(512-token) and full attention layers see exactly the reference masks. The
mean is computed in float32.

The worker **rejects inputs above 2048 actual tokens** rather than silently
truncating. This bounds attention memory and is ample for normal Gemdex
1500-character chunks. It is a runtime limit, not the model's 8192-token context.

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

The installer downloads about **1.33 GB**: CPython **3.12.12**,
python-build-standalone release **20260211**,
`aarch64-apple-darwin-install_only_stripped` (includes pip 26.0.1; the whole
archive is hash-pinned), plus these individually hash-pinned wheels, installed
offline with `--no-index --no-deps`:

- `mlx==0.32.3`, `mlx-metal==0.32.3` (macOS 14 arm64 binaries; the conversion
  was produced and validated with MLX 0.32.3)
- `tokenizers==0.23.2` (arm64 Rust ABI3 binary)

and one hash-pinned source file, `arch/embedding_gemma2/language.py`, fetched
from mlx-vlm commit `fec3f503` on `raw.githubusercontent.com` (content at a
commit SHA is immutable).

This is a **curated text runtime**, not an mlx-vlm installation. mlx-vlm's
package imports numpy, Pillow, transformers, KV caches and the vision/audio
towers. The upstream text encoder file needs only MLX plus two sibling names:
`RMSNormNoScale` (`mx.fast.rms_norm` without a scale) and the `TextConfig`
dataclass. The worker defines those two in a private `gemdex_eg2` import
namespace and imports the **unmodified** pinned `language.py` against them. It
loads only `language_model.*` tensors. MLX loads safetensors lazily, so the
unused BF16 tower tensors are never read into memory; measured RSS is ~750 MB
versus ~2.2 GB for upstream `load_embedding_model`. No transitive package
resolver or source build runs on the user's machine.

Install storage is `~/.gemdex/mlx/<manifest-and-worker-hash>/`; `homeDir`
overrides the **Gemdex root**, not the OS home directory. Because the hash
covers the manifest and worker, the BGE-M3 runtime from an earlier release lives
in a different directory. It is not reused or deleted automatically, since an
older desktop app or npx process may still be using it. Once every client is
upgraded and migrated, the user can delete old `~/.gemdex/mlx/<hash>`
directories other than the one `npx gemdex-mcp status` reports. The
same-hash staging directory retains only useful completed downloads for
interrupted retry. `.part` files are removed on ordinary offline/hash failures;
retries overwrite any crash-left partial. An exclusive PID lock rejects
concurrent installers; dead-owner locks can be recovered. The installed marker
appears only after all download hashes, installed-runtime inventory, and a real
768d normalized embedding smoke test pass. The installer does not change
settings or index tables. `npx gemdex-mcp install` is the explicit download
action.

### Upgrade from earlier releases

`npx gemdex-mcp migrate` (or Settings → Migrate in the desktop app) moves
parents from every older index into `memories_mlx_embeddinggemma2_8bit`, in
order: `memories_mlx_bge_m3_8bit` (BGE-M3 releases), then `memories` (Gemini
releases). `MemoryStore` takes them as `legacyCollectionNames`. Until migration
finishes, recall and hygiene refuse to run; list/get/update/delete/export stay
available, and an update moves that memory into the new index. Migration
re-embeds each stored chunk's text (or the title for an attachment-only parent),
preserves metadata, timestamps and attachment blobs, and commits destination
rows before deleting source rows. Stable row ids make it rerunnable. A parent
left in two old indexes by an interrupted migration is counted once. Legacy
media remains readable but is not media-searchable.

An upgraded npx package reports the model as not installed until
`npx gemdex-mcp install` runs again (new install id), so the order is
**install, then migrate**. An older desktop app or sidecar still writes to the
BGE-M3 table; rerunning migrate picks those writes up.

### Inference lifecycle

Status is synchronous and cheap (marker only). Before first inference per
provider instance, the engine verifies artifact hashes, the exact worker source,
and the extracted/installed Python tree against its recorded digest. This
detects corruption; it is not a security boundary against an attacker who can
rewrite both the user's runtime and verification files. Python runs isolated
(`-I -B`); imports cannot come from user site packages or `PYTHONPATH`.
Inference has no downloader and uses only local file paths. Offline environment
flags are set as an additional guard, not the sole enforcement.

JSONL stdin/stdout frames carry `{id, kind, texts}` with at most 16 texts and
1 MiB per frame; stderr is drained, not emitted into MCP stdout. One request is
in flight per worker, the provider admits at most 16 batches of at most 256
texts / 1 MiB each, and each worker request times out after 120 seconds.
MemoryStore submits long parents in bounded batches rather than imposing this
per-request cap on a whole memory. The MLX cache is capped at 256 MiB and its
allocation limit at 4 GiB. Idle workers are killed after 60 seconds; their pipes
are unreferenced so a finished CLI can exit immediately. Explicit `close()` and
parent process exit kill the child. No port is opened.

Public APIs, exported by `embedding/index.ts` (already re-exported at core root):

```ts
new MlxEmbedding({ homeDir?: string }); // lazy, text-only, 768d
installMlxModel({ homeDir?: string, onProgress?: (message: string) => void }): Promise<void>;
getMlxStatus(homeDir?: string): { installed: boolean; model: string; revision: string; dimension: number; path: string };
// embedding.embed / embedBatch (document prompt), embedQuery (query prompt), close(): void
```

## Verification

All pinned artifacts were downloaded and their SHA-256 values checked against
Hugging Face LFS metadata and PyPI digests. On an Apple Silicon Mac (macOS 27):

- **Import closure:** the exact embedded worker ran in a venv containing only
  the three pinned wheels (`--no-deps`).
- **Architecture parity:** in one process, the worker's model and upstream
  mlx-vlm `load_embedding_model` (at `fec3f503`) have identical parameters
  (851 tensors) and produce bit-identical hidden states and a final cosine of
  1.0. Token ids match the transformers `AutoTokenizer` for 11 cases (queries,
  documents, multilingual, whitespace, a literal `<|image|>` marker, and a
  1,378-token input that exercises the 512-token sliding window).
- **Cross-build:** against upstream running with the macOS 26 `mlx-metal`
  build, the minimum cosine was 0.99987 (Metal kernel rounding).
- **Retrieval smoke:** Mars query → Mars passage 0.903 vs Venus 0.700; password
  query → recovery passage 0.905 vs banana 0.545. This is a smoke check, not a
  retrieval benchmark.
- **Throughput:** ~1.4 s cold load plus first embedding; ~9 ms per short
  document warm.
- **End to end:** `install`, `status`, `migrate` and stdio `recall` were run
  through the built CLI against an isolated HOME seeded with BGE-M3-era and
  Gemini-era tables.

Unit tests use real child processes for frame handling, timeouts, crashes,
dimension and bounds checks; controlled installer fixtures cover platform
refusal, offline cleanup/retry, lock recovery, idempotency, integrity failures,
and smoke-before-marker ordering. Store tests cover multi-index migration.

### Maintainer parity check

From the repository root (uv is a maintainer tool here, never a user
prerequisite), this reruns the parity check against upstream mlx-vlm:

```bash
pnpm --filter gemdex-core build
uv venv /tmp/gemdex-eg2-ref --python 3.12
uv pip install --python /tmp/gemdex-eg2-ref/bin/python mlx==0.32.3 'transformers>=5.18.0' \
  'git+https://github.com/Blaizzy/mlx-vlm.git@fec3f50379bb2cb0760ef3c8a68ebce9585e4d97'
node -e "
const fs = require('node:fs');
const { MLX_ARTIFACTS } = require('./packages/core/dist/embedding/mlx-manifest');
const { downloadMlxArtifact } = require('./packages/core/dist/embedding/mlx-install');
const { MLX_WORKER } = require('./packages/core/dist/embedding/mlx-worker');
(async () => {
  for (const a of MLX_ARTIFACTS.filter(a => !a.path.startsWith('wheels/') && a.path !== 'python.tar.gz'))
    await downloadMlxArtifact(a, '/tmp/gemdex-eg2');
  fs.writeFileSync('/tmp/gemdex-eg2/worker.py', MLX_WORKER);
})();"
/tmp/gemdex-eg2-ref/bin/python - <<'PY'
import io, sys, runpy
from pathlib import Path
import mlx.core as mx
from mlx_vlm.embedding_loader import load_embedding_model
upstream = load_embedding_model(Path('/tmp/gemdex-eg2/model'))
sys.argv = ['worker.py', '/tmp/gemdex-eg2/model', '/tmp/gemdex-eg2/arch/embedding_gemma2']
stdout, sys.stdin = sys.stdout, io.TextIOWrapper(io.BytesIO(b''))
worker = runpy.run_path('/tmp/gemdex-eg2/worker.py')
sys.stdout = stdout
ids = mx.array([worker['tokenizer'].encode(worker['PREFIX']['document'] + 'Mars is the Red Planet.').ids])
lm = worker['model'].language_model
h = lm(lm.embed_tokens(ids) * mx.array(512 ** 0.5, dtype=mx.bfloat16), mx.ones(ids.shape, dtype=mx.int32))
v = mx.mean(h[0].astype(mx.float32), axis=0); v = v / mx.linalg.norm(v)
print('cosine vs upstream:', mx.sum(upstream(input_ids=ids).text_embeds[0] * v).item())
PY
```
