# Local MLX model and managed runtime

## Decision

The user explicitly selected **[`mlx-community/bge-m3-mlx-8bit`](https://huggingface.co/mlx-community/bge-m3-mlx-8bit)**,
superseding issue #119's original Qwen candidate. This is a user selection, **not
a claim that BGE-M3 won an M5 benchmark**. It is text-only, XLM-RoBERTa, MIT
licensed, 1024 dimensions, with 603,620,090 bytes of quantized weights.
Gemdex uses its dense vectors only; BGE's sparse and ColBERT outputs are not used.

The immutable HF revision is `7eca4a1c6ea1a0c5efc37598b369012f3985910f`.
`packages/core/src/embedding/mlx-manifest.ts` is the single source of URLs and
SHA-256 digests for the model, tokenizer, standalone runtime, and wheels.

### Quality versus speed: evidence, not a synthetic score

The requested weights are 30% quality and 30% speed. The other 40% was not
specified; reliability, footprint, and licensing are qualitative tie-breakers,
not invented numerical weights. Without same-machine speed data and a defined
quality normalization, a weighted total would be misleading.

| Model | Published quality | Footprint / context / licensing | Speed evidence |
|---|---|---|---|
| **BGE-M3 (selected 8-bit conversion)** | Original BGE-M3: 59.56 MTEB multilingual mean-task in Qwen's comparison | Actual selected weights 603.6 MB decimal; 1024d; original 8192-token context; MIT | No measured M5 timing here. The 8-bit conversion's quality/speed is not established by the original model score. |
| Qwen3-Embedding-0.6B | 64.33 multilingual; 70.70 English v2 mean-task | Original issue's DWQ 4-bit weights 335,296,756 bytes; 1024d; 32K context; Apache-2.0 | Smaller weights suggest less bandwidth pressure, not a measured latency advantage across architectures. |
| Qwen3-Embedding-4B | 69.45 multilingual; 74.60 English v2 mean-task | 2560d native/MRL; 32K; Apache-2.0; substantially larger than 0.6B | Higher published quality, but no same-M5 measurement supports accepting its added load/memory/latency cost here. |
| EmbeddingGemma 308M | 61.15 multilingual v2; 69.67 English v2 at 768d full precision. Google's Q4_0 QAT: 60.62 / 69.31 respectively | 768d/MRL; 2K; Gemma terms rather than Apache/MIT; Google reports <200 MB RAM with quantization | Google reports <15 ms for 256 input tokens on **EdgeTPU**, not Apple MLX. Cannot extrapolate to M5. |

These are publisher-reported, differently dated benchmark snapshots, not our
Gemdex retrieval evaluation, not guarantees for community quantizations, and
not interchangeable task/type averages. Qwen's higher published quality alone
does not override the user's BGE choice. EmbeddingGemma's smaller footprint and
EdgeTPU result are useful context, not evidence of better M5 speed.

Sources:

- [Qwen official model table and MTEB results](https://github.com/QwenLM/Qwen3-Embedding)
  (June 2025 comparison, including BGE-M3).
- [Google model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card)
  (full-precision and QAT tables, context, dimensions, prompt instructions).
- [Google launch measurements](https://developers.googleblog.com/introducing-embeddinggemma/)
  (EdgeTPU hardware explicitly identified).
- [BGE original model card](https://huggingface.co/BAAI/bge-m3) and
  [FlagEmbedding implementation](https://github.com/FlagOpen/FlagEmbedding/blob/master/FlagEmbedding/inference/embedder/encoder_only/m3.py).
- [Selected immutable conversion](https://huggingface.co/mlx-community/bge-m3-mlx-8bit/tree/7eca4a1c6ea1a0c5efc37598b369012f3985910f).

For an eventual M5 Pro 48 GB comparison, hold corpus, retrieval labels, token
lengths, output dimensions where supported, and concurrency constant. Record
cold load, warm query p50/p95, ingestion throughput, peak memory, and retrieval
Recall@10/nDCG@10 on coding-memory queries. Run plugged in, record OS/Metal and
runtime versions, and measure the actual quantized artifacts. No M5 timing is
claimed in this change.

## Correct BGE inference

The conversion README's example uses **mean pooling**, and mlx-embeddings
0.0.5's generic `text_embeds` also mean-pools. Those are **not the BGE-M3 dense
retrieval contract**: FlagEmbedding defaults to `pooling_method="cls"`.
The worker takes `last_hidden_state[0, 0, :]`, casts to float32, and L2-normalizes.
It does not use the transformed `pooler_output`. It sends the same unprefixed
text for queries and documents; no Qwen instruction survives the model switch.

The pinned `tokenizer.json` contains XLM-R special-token processing. We use the
Rust `Tokenizer.from_file` directly, add special tokens, assert CLS=0 and SEP=2,
and disable padding/truncation. Each text is evaluated separately (no padded
batch ambiguity), with the model in evaluation mode (dropout off), bidirectional
attention, and its native position IDs. Strict weight loading and the install
smoke test reject an incompatible conversion before marking it installed.

The model supports 8192 tokens, but this initial managed worker deliberately
**rejects inputs above 2048 actual tokens** rather than silently truncating.
This bounds XLM-R attention memory and is ample for normal Gemdex 1500-character
chunks. Long queries must be shortened/split. This is a runtime limit, not a
claim that BGE has a 2048-token model context.

## Runtime and security boundary

User prerequisites: Node/Gemdex and **native arm64 macOS 14+**. No preinstalled
Python, pip, uv, HF CLI, Homebrew, compiler, or shell bootstrap script is needed.
Rosetta x64 Node and non-Mac hosts fail clearly at explicit install/inference;
construction and status stay lazy. macOS's built-in `/usr/bin/tar` extracts only
the already SHA-256-verified archive.

The installer downloads CPython **3.12.12**, python-build-standalone release
**20260211**, `aarch64-apple-darwin-install_only_stripped`, which includes pip
26.0.1. The entire archive (including pip) is hash-pinned. It installs these
four individually hash-pinned wheels offline with `--no-index --no-deps`:

- `mlx==0.29.3`, `mlx-metal==0.29.3` (macOS 14 arm64 binaries)
- `mlx-embeddings==0.0.5` (upstream architecture code)
- `tokenizers==0.22.2` (arm64 Rust ABI3 binary)

This is a **curated text runtime**, not a full installation of the general
mlx-embeddings convenience API. Its top-level imports eagerly bring in
mlx-vlm/vision/Gradio dependencies, and tokenizers' HF convenience loader has
network dependencies. We use neither. A private import namespace loads the
unmodified `models/xlm_roberta.py` and `models/base.py` from the verified wheel;
these need only MLX and Python's standard library. `Tokenizer.from_file` needs
only its Rust extension. All imports actually used by this worker are covered
by the pinned runtime and four wheels. No transitive package resolver or
source build runs on the user's machine. Do not replace this with a top-level
`import mlx_embeddings` without explicitly updating and verifying its runtime.

Install storage is `~/.gemdex/mlx/<manifest-and-worker-hash>/`; `homeDir`
overrides the **Gemdex root**, not the OS home directory. The same-hash staging
directory retains only useful completed downloads for interrupted retry.
`.part` files are removed on ordinary offline/hash failures; retries overwrite
any crash-left partial. An exclusive PID lock rejects concurrent installers;
dead-owner locks can be recovered. The installed marker appears only after
all download hashes, installed-runtime inventory, and a real 1024d normalized
embedding smoke test pass. The core installer does not change settings or banks;
the CLI/sidecar wrapper activates MLX text after successful installation by
writing `GEMINI_API_KEY=local` (exact lowercase). That sentinel is the only
activation path for managed local text; `GEMDEX_EMBEDDING_PROVIDER` alone does
not enable it, and a missing key does not fall through to MLX. Moving
existing text requires the separate explicit migration action.

Status is synchronous and cheap (marker only). Before first inference per
provider instance, the engine verifies artifact hashes, the exact worker source,
and the extracted/installed Python tree against its recorded digest. This
detects corruption; it is not a security boundary against an attacker who can
rewrite both the user's runtime and verification files. Python runs isolated
(`-I -B`); imports cannot come from user site packages or `PYTHONPATH`.
Inference has no downloader and uses only local file paths. Offline environment
flags are set as an additional guard, not the sole enforcement.

JSONL stdin/stdout pipes carry at most 16 texts per frame and 1 MiB per frame;
stderr is drained, not emitted into MCP stdout. One request is in flight per
worker, the provider admits at most 16 batches of at most 256 texts / 1 MiB each, and each
worker request times out after 120 seconds.
MemoryStore submits long parents in bounded batches rather than imposing this
per-request cap on a whole memory. The MLX cache is capped at 256 MiB and
its allocation limit at 4 GiB. Idle workers are killed after 60 seconds; their
pipes are unreferenced so a finished CLI can exit immediately. Explicit
`close()` and parent process exit kill the child. No port is opened.

Public APIs, exported by `embedding/index.ts` (already re-exported at core root):

```ts
new MlxEmbedding({ homeDir?: string }); // lazy, text-only, 1024d
installMlxModel({ homeDir?: string, onProgress?: (message: string) => void }): Promise<void>;
getMlxStatus(homeDir?: string): { installed: boolean; model: string; revision: string; dimension: number; path: string };
// embedding.embed / embedBatch / embedContentBatch, plus close(): void
// Embedding.embedQuery defaults to embed; BGE needs no instruction override.
```

## Verification and reproducible Linux CPU smoke

All 14 pinned artifacts, including the **actual Mac runtime/wheels and the full
603.6 MB weights**, were downloaded with the production downloader and verified
against committed SHA-256 values. The standalone archive was inspected for
Python and bundled pip. Unit tests use real child processes for frame handling,
timeouts, crashes, and bounds; controlled installer fixtures cover platform
refusal, offline cleanup/retry, lock recovery, idempotency, integrity failures,
and smoke-before-marker ordering.

Additionally, MLX 0.29.3 provides a Linux CPU backend. The exact packaged worker
ran against the actual BGE weights using a minimal Linux environment, with CPU
replacing Metal. Three vectors were 1024d with norms 0.99999973, 0.99999993,
0.99999950. A password query had cosine 0.78188 with a password-recovery passage
versus 0.38384 with an unrelated banana passage. This is a smoke check, **not a
retrieval benchmark**. It validates architecture, strict weights, tokenization,
CLS pooling and protocol; **Mac installation, Metal inference, and M5 timings
remain unverified**.

From the repository root, this optional maintainer check reproduces the Linux
CPU run (uv is a maintainer test tool here, never a user prerequisite):

```bash
pnpm --filter gemdex-core build
uv venv /tmp/gemdex-bge-smoke --python 3.12
uv pip install --python /tmp/gemdex-bge-smoke/bin/python --no-deps \
  mlx==0.29.3 mlx-cpu==0.29.3 mlx-embeddings==0.0.5 tokenizers==0.22.2
node <<'JS'
const fs = require('node:fs');
const { MLX_ARTIFACTS } = require('./packages/core/dist/embedding/mlx-manifest');
const { downloadMlxArtifact } = require('./packages/core/dist/embedding/mlx-install');
const { MLX_WORKER } = require('./packages/core/dist/embedding/mlx-worker');
const { MlxProcess } = require('./packages/core/dist/embedding/mlx-process');
(async () => {
  const root = '/tmp/gemdex-bge-artifacts';
  for (const artifact of MLX_ARTIFACTS) await downloadMlxArtifact(artifact, root);
  fs.writeFileSync(root + '/worker.py', MLX_WORKER);
  const worker = new MlxProcess('/tmp/gemdex-bge-smoke/bin/python',
    ['-I', '-B', '-u', root + '/worker.py', root + '/model']);
  try {
    const vectors = await worker.request(['How can I reset a password?',
      'Reset your password using the account recovery page.', 'The banana is a yellow fruit.']);
    console.log(vectors.map(v => ({ dimensions: v.length, norm: Math.hypot(...v) })));
    console.log(vectors.slice(1).map(v => v.reduce((s, x, i) => s + x * vectors[0][i], 0)));
  } finally { worker.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
```

The Mac path remains gated by its own actual install-time smoke, and must be
exercised on Apple hardware before calling this M5-verified.
