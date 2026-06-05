# gemdex-core

Memory-layer engine for [Gemdex](https://github.com/anand-92/gemdex) — a global,
persistent memory store for AI coding agents, powered by Gemini embeddings and
embedded LanceDB hybrid retrieval.

```bash
npm install gemdex-core
```

```ts
import { MemoryStore, LanceDBVectorDatabase, GeminiEmbedding } from 'gemdex-core';

const memory = new MemoryStore({
  embedding: new GeminiEmbedding({ apiKey: process.env.GEMINI_API_KEY! }),
  // No daemon required. By default LanceDB persists under ~/.gemdex/lance.
  vectorDatabase: new LanceDBVectorDatabase(),
});

const { id } = await memory.save({ content: 'how we deploy: …', title: 'Deploy' });
const hits = await memory.recall('how do we deploy', 5);
console.log(hits[0].content); // full memory, never a fragment
```

`MemoryStore` uses parent-document chunking: long memories are split into
retrieval chunks for sharp hybrid (dense + BM25) matching, but `recall` always
resolves matches back to the complete parent memory, deduped by id.

To use a self-hosted Gemdex Server, swap in the HTTP backend. The server owns
embedding execution, so remote clients do not need `GEMINI_API_KEY`:

```ts
import { RemoteMemoryBackend } from 'gemdex-core';

const memory = new RemoteMemoryBackend({
  url: process.env.GEMDEX_REMOTE_URL!,
  token: process.env.GEMDEX_REMOTE_TOKEN!,
});

await memory.save({ content: 'stored and embedded by my server' });
const hits = await memory.recall('stored by my server');
```

`RemoteMemoryBackend` accepts inline base64 attachments only. Resolve local file
paths in the calling integration before invoking it.

See the [main repo](https://github.com/anand-92/gemdex) for full documentation.

## License

MIT
