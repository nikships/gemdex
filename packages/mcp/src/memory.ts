import { LanceDBVectorDatabase, LocalMemoryBackend, MemoryBackend } from "gemdex-core";
import { GemdexConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";

/**
 * Build a MemoryBackend backed by the shared embedded LanceDB store
 * (~/.gemdex/lance by default). Both the MCP server and the `gemdex serve`
 * sidecar use this so a memory saved by the agent shows up in the app and
 * vice-versa.
 */
export function createMemoryBackend(config: GemdexConfig): MemoryBackend {
    const embedding = createEmbeddingInstance(config);
    logEmbeddingProviderInfo(config, embedding);

    const vectorDatabase = new LanceDBVectorDatabase({
        ...(config.lancedbPath && { uri: config.lancedbPath }),
    });

    return new LocalMemoryBackend({ embedding, vectorDatabase });
}
