# gemdex-core

Indexing engine for [Gemdex](https://github.com/anand-92/gemdex) — semantic code search powered by Gemini embeddings and Milvus.

```bash
npm install gemdex-core
```

```ts
import { Context, MilvusVectorDatabase, GeminiEmbedding } from 'gemdex-core';

const context = new Context({
  embedding: new GeminiEmbedding({ apiKey: process.env.GEMINI_API_KEY! }),
  vectorDatabase: new MilvusVectorDatabase({ address: 'localhost:19530' }),
});

await context.indexCodebase('./project');
const hits = await context.semanticSearch('./project', 'database connection setup', 5);
```

See the [main repo](https://github.com/anand-92/gemdex) for full documentation.

## License

MIT
