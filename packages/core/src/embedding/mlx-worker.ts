/** Embedded so tsc/npm packaging needs no Python asset-copy step. */
export const MLX_WORKER = String.raw`
import os, sys, json, math, subprocess, tempfile
from pathlib import Path
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
# stdout belongs exclusively to the JSONL protocol, including during imports/load.
protocol = sys.stdout
sys.stdout = sys.stderr
import numpy as np
import mlx.core as mx
from PIL import Image
from mlx_vlm import load
from mlx_vlm.utils import load_audio
mx.set_cache_limit(256 * 1024 * 1024)
root = Path(sys.argv[1])
def read(name):
    return json.loads((root / name).read_text())
config = read('config.json')
text_config = config['text_config']
if (config['model_type'] != 'embedding_gemma2' or text_config['model_type'] != 'embedding_gemma2_text'
        or text_config['embedding_dim'] != 768 or not config.get('vision_config') or not config.get('audio_config')):
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
model, processor = load(str(root))
model.eval()
BOS, EOS = text_config['bos_token_id'], text_config['eos_token_id']
# The model's whole context window; one input (prompt + text or media tokens) must fit.
MAX_TOKENS = 8192
SAMPLE_RATE = processor.feature_extractor.sampling_rate
MAX_AUDIO_SECONDS = 300
# 40 ms per audio token: five minutes of audio is 7,500 tokens.
processor.audio_seq_length = MAX_AUDIO_SECONDS * 1000 // processor.audio_ms_per_token
# miniaudio decodes these directly; macOS's built-in afconvert handles the rest.
DIRECT_AUDIO = {'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac'}

def read_audio(path, mime):
    if mime in DIRECT_AUDIO:
        return load_audio(path, sr=SAMPLE_RATE)
    with tempfile.TemporaryDirectory() as scratch:
        wav = os.path.join(scratch, 'audio.wav')
        subprocess.run(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@%d' % SAMPLE_RATE, '-c', '1', path, wav],
                       check=True, capture_output=True, timeout=120)
        return load_audio(wav, sr=SAMPLE_RATE)

def prepare(kind, item):
    prefix = PREFIX[kind]
    if 'text' in item:
        if not isinstance(item['text'], str):
            raise ValueError('Invalid text input')
        return {'text': [prefix + item['text']]}
    path, mime = item.get('path'), item.get('mimeType')
    if not isinstance(path, str) or not isinstance(mime, str):
        raise ValueError('Media input requires a path and mimeType')
    if mime.startswith('image/'):
        with Image.open(path) as image:
            image.seek(0)
            frame = image.convert('RGB')
        return {'text': [prefix + '<|image|>'], 'images': [frame]}
    if mime.startswith('audio/'):
        samples = read_audio(path, mime)
        if len(samples) == 0:
            raise ValueError('Audio contains no samples')
        if len(samples) > MAX_AUDIO_SECONDS * SAMPLE_RATE:
            raise ValueError('Audio is %ds long; the limit is %ds' % (len(samples) // SAMPLE_RATE, MAX_AUDIO_SECONDS))
        return {'text': [prefix + '<|audio|>'], 'audio': [samples],
                'audio_kwargs': {'max_length': MAX_AUDIO_SECONDS * SAMPLE_RATE}}
    if mime.startswith('video/'):
        return {'text': [prefix + '<|video|>'], 'videos': [path]}
    raise ValueError('Unsupported media type ' + mime)

def embed(kind, item):
    # Retrieval prompts are part of the model contract: queries and documents
    # are prefixed differently, media included, and pooling includes the prompt tokens.
    inputs = processor(return_tensors='np', **prepare(kind, item))
    ids = inputs['input_ids']
    if ids.shape[0] != 1 or ids.shape[1] > MAX_TOKENS:
        raise ValueError('Input is %d tokens; EmbeddingGemma 2 accepts at most %d' % (ids.shape[1], MAX_TOKENS))
    if ids.shape[1] < 2 or ids[0, 0] != BOS or ids[0, -1] != EOS:
        raise ValueError('EmbeddingGemma 2 processor must add BOS and EOS tokens')
    arrays = {name: mx.array(value) for name, value in inputs.items() if isinstance(value, np.ndarray)}
    vector = model(**arrays).text_embeds[0].astype(mx.float32)
    mx.eval(vector)
    result = vector.tolist()
    mx.clear_cache()
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
        items, kind = request['inputs'], request.get('kind')
        if kind not in PREFIX:
            raise ValueError('Invalid embedding kind')
        if not isinstance(items, list) or not 1 <= len(items) <= 16 or not all(isinstance(i, dict) for i in items):
            raise ValueError('Invalid input batch')
        response = {'id': request['id'], 'vectors': [embed(kind, item) for item in items]}
    except Exception as error:
        response = {'id': request['id'], 'error': str(error)}
    protocol.write(json.dumps(response, allow_nan=False) + '\n')
    protocol.flush()
`;
