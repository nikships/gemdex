/** Embedded so tsc/npm packaging needs no Python asset-copy step. */
export const MLX_WORKER = String.raw`
import os, sys, json, math, types, importlib
from dataclasses import dataclass
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
root = Path(sys.argv[1])
architecture = Path(sys.argv[2])
def read(name):
    return json.loads((root / name).read_text())
config = read('config.json')
text_config = config['text_config']
if (config['model_type'] != 'embedding_gemma2' or text_config['model_type'] != 'embedding_gemma2_text'
        or text_config['embedding_dim'] != 768 or text_config['hidden_activation'] != 'gelu_pytorch_tanh'):
    raise ValueError('Unexpected EmbeddingGemma 2 model configuration')
pooling = read('1_Pooling/config.json')
if pooling.get('pooling_mode') != 'mean' or pooling.get('embedding_dimension') != 768 or pooling.get('include_prompt') is not True:
    raise ValueError('EmbeddingGemma 2 must use prompt-inclusive mean pooling')
if [module['type'].rsplit('.', 1)[-1] for module in read('modules.json')] != ['Transformer', 'Pooling', 'Normalize']:
    raise ValueError('Unexpected EmbeddingGemma 2 sentence-transformers modules')
prompts = read('config_sentence_transformers.json')['prompts']
PREFIX = {'query': prompts['query'], 'document': prompts['document']}
if PREFIX != {'query': 'task: search result | query: ', 'document': 'title: none | text: '}:
    raise ValueError('Unexpected EmbeddingGemma 2 retrieval prompts')

# The pinned, unmodified upstream mlx-vlm text encoder (language.py) imports
# exactly two names from sibling modules whose real files pull in numpy, PIL,
# KV caches and the vision/audio towers. These definitions match upstream for
# the text path, so only MLX and the standard library are needed.
class RMSNormNoScale(nn.Module):
    def __init__(self, dim, eps=1e-6):
        super().__init__()
        self.eps = eps
    def __call__(self, x):
        return mx.fast.rms_norm(x, None, self.eps)
@dataclass
class TextConfig:
    vocab_size: int
    hidden_size: int
    intermediate_size: int
    num_hidden_layers: int
    num_attention_heads: int
    num_key_value_heads: int
    head_dim: int
    hidden_size_per_layer_input: int
    embedding_dim: int
    rms_norm_eps: float
    sliding_window: int
    attention_bias: bool
    pad_token_id: int
    layer_types: list
    per_layer_config: dict
    rope_parameters: dict
text = TextConfig(**{name: text_config[name] for name in TextConfig.__dataclass_fields__})
text.per_layer_config = {f'{int(index):02d}': value for index, value in text.per_layer_config.items()}
if len(text.layer_types) != text.num_hidden_layers or text.layer_types[-1] != 'full_attention':
    raise ValueError('Unexpected EmbeddingGemma 2 layer layout')
def namespace(name, **attributes):
    module = types.ModuleType(name)
    module.__dict__.update(attributes)
    sys.modules[name] = module
namespace('gemdex_eg2', __path__=[])
namespace('gemdex_eg2.gemma4', __path__=[])
namespace('gemdex_eg2.gemma4.language', RMSNormNoScale=RMSNormNoScale)
namespace('gemdex_eg2.embedding_gemma2', __path__=[str(architecture)])
namespace('gemdex_eg2.embedding_gemma2.config', TextConfig=TextConfig)
language = importlib.import_module('gemdex_eg2.embedding_gemma2.language')
class Encoder(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.language_model = language.TextModel(config)
model = Encoder(text)
# The checkpoint also carries BF16 vision/audio towers; text-only Gemdex never
# evaluates them, so their lazily loaded arrays are never read into memory.
weights = {}
for key, value in mx.load(str(root / 'model.safetensors')).items():
    key = key.removeprefix('model.')
    if key.startswith('language_model.') and 'rotary_emb.inv_freq' not in key:
        weights[key] = value
nn.quantize(model, **config['quantization'], class_predicate=lambda path, module: hasattr(module, 'to_quantized') and path + '.scales' in weights)
model.load_weights(list(weights.items()), strict=True)
model.eval()
mx.eval(model.parameters())
del weights
tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
tokenizer.no_truncation()
tokenizer.no_padding()
BOS, EOS, PAD = text_config['bos_token_id'], text_config['eos_token_id'], text.pad_token_id
MEDIA = {config['image_token_id'], config['audio_token_id'], config['video_token_id']}
SCALE = text.hidden_size ** 0.5
def embed(kind, value):
    # Retrieval prompts are part of the model contract: queries and documents
    # are prefixed differently, and pooling includes the prompt tokens.
    tokens = tokenizer.encode(PREFIX[kind] + value, add_special_tokens=True).ids
    if len(tokens) > 2048:
        raise ValueError('MLX input exceeds 2048 tokens; split the text into smaller chunks')
    if len(tokens) < 2 or tokens[0] != BOS or tokens[-1] != EOS:
        raise ValueError('EmbeddingGemma 2 tokenizer must add BOS and EOS tokens')
    # Upstream replaces media placeholder ids with padding before embedding.
    ids = mx.array([[PAD if token in MEDIA else token for token in tokens]])
    lm = model.language_model
    hidden = lm.embed_tokens(ids)
    hidden = hidden * mx.array(SCALE, dtype=hidden.dtype)
    hidden = lm(hidden, mx.ones(ids.shape, dtype=mx.int32))
    vector = mx.mean(hidden[0].astype(mx.float32), axis=0)
    vector = vector / mx.maximum(mx.linalg.norm(vector), 1e-12)
    mx.eval(vector)
    result = vector.tolist()
    if len(result) != 768 or not all(math.isfinite(x) for x in result):
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
        texts, kind = request['texts'], request.get('kind')
        if kind not in PREFIX:
            raise ValueError('Invalid embedding kind')
        if not isinstance(texts, list) or not 1 <= len(texts) <= 16 or not all(isinstance(t, str) for t in texts):
            raise ValueError('Invalid text batch')
        response = {'id': request['id'], 'vectors': [embed(kind, t) for t in texts]}
    except Exception as error:
        response = {'id': request['id'], 'error': str(error)}
    protocol.write(json.dumps(response, allow_nan=False) + '\n')
    protocol.flush()
`;
