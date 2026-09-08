/** Embedded so tsc/npm packaging needs no Python asset-copy step. */
export const MLX_WORKER = String.raw`
import os, sys, json, math, types, importlib, importlib.metadata
from pathlib import Path
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
# stdout belongs exclusively to the JSONL protocol, including during imports/load.
protocol = sys.stdout
sys.stdout = sys.stderr
import mlx.core as mx
import mlx.nn as nn
from tokenizers import Tokenizer
mx.set_cache_limit(256 * 1024 * 1024)
mx.set_memory_limit(4 * 1024 * 1024 * 1024)
# Load the pinned architecture, not mlx_embeddings.__init__: its convenience
# API eagerly imports vision/gradio/HF download helpers which this text worker
# neither needs nor installs. The upstream architecture/base files are unmodified.
architecture = types.ModuleType('gemdex_mlx_models')
architecture.__path__ = [str(importlib.metadata.distribution('mlx-embeddings').locate_file('mlx_embeddings/models'))]
sys.modules['gemdex_mlx_models'] = architecture
from gemdex_mlx_models.xlm_roberta import Model, ModelArgs
root = Path(sys.argv[1])
config = json.loads((root / 'config.json').read_text())
if config['model_type'] != 'xlm-roberta' or config['hidden_size'] != 1024:
    raise ValueError('Unexpected BGE-M3 model configuration')
model = Model(ModelArgs.from_dict(config))
weights = model.sanitize(mx.load(str(root / 'model.safetensors')))
nn.quantize(model, **config['quantization'], class_predicate=lambda path, module: hasattr(module, 'to_quantized') and path + '.scales' in weights)
model.load_weights(list(weights.items()), strict=True)
model.eval()
mx.eval(model.parameters())
tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
tokenizer.no_truncation()
tokenizer.no_padding()
def embed(text):
    # BGE-M3 uses CLS pooling, not the conversion README's mean pooling example
    # or mlx-embeddings' generic text_embeds/pooler_output. No query instruction.
    tokens = tokenizer.encode(text if text else ' ', add_special_tokens=True).ids
    if len(tokens) > 2048:
        raise ValueError('MLX input exceeds 2048 tokens; split the text into smaller chunks')
    if not tokens or tokens[0] != 0 or tokens[-1] != 2:
        raise ValueError('BGE-M3 tokenizer must add CLS and SEP tokens')
    hidden = model(mx.array([tokens])).last_hidden_state
    vector = hidden[0, 0, :].astype(mx.float32)
    vector = vector / mx.maximum(mx.linalg.norm(vector), 1e-12)
    mx.eval(vector)
    result = vector.tolist()
    if len(result) != 1024 or not all(math.isfinite(x) for x in result):
        raise ValueError('Invalid MLX embedding')
    return result
while True:
    line = sys.stdin.buffer.readline(1024 * 1024 + 1)
    if not line:
        break
    if len(line) > 1024 * 1024:
        raise ValueError('Oversized protocol frame')
    request = json.loads(line)
    try:
        texts = request['texts']
        if not isinstance(texts, list) or not 1 <= len(texts) <= 16 or not all(isinstance(t, str) for t in texts):
            raise ValueError('Invalid text batch')
        response = {'id': request['id'], 'vectors': [embed(t) for t in texts]}
    except Exception as error:
        response = {'id': request['id'], 'error': str(error)}
    protocol.write(json.dumps(response, allow_nan=False) + '\n')
    protocol.flush()
`;
