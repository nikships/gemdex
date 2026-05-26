# gemdex-core

Indexing engine for [Gemdex](https://github.com/anand-92/gemdex) — semantic code search powered by Gemini embeddings and embedded LanceDB.

```bash
npm install gemdex-core
```

```ts
import { Context, LanceDBVectorDatabase, GeminiEmbedding } from 'gemdex-core';

const context = new Context({
  embedding: new GeminiEmbedding({ apiKey: process.env.GEMINI_API_KEY! }),
  // No daemon required. By default LanceDB persists under ~/.gemdex/lance.
  vectorDatabase: new LanceDBVectorDatabase(),
});

await context.indexCodebase('./project');
const hits = await context.semanticSearch('./project', 'database connection setup', 5);
```

See the [main repo](https://github.com/anand-92/gemdex) for full documentation.

## License

MIT
