import {
    LanceDBVectorDatabase,
    LocalMemoryBackend,
    MemoryBackend,
    RemoteMemoryBackend,
    MlxEmbedding,
    getMlxStatus,
    envManager,
} from "gemdex-core";
import { GemdexConfig } from "./config.js";
import { createEmbeddingInstance, UnconfiguredGeminiEmbedding } from "./embedding.js";

/**
 * Build a MemoryBackend backed by the shared embedded LanceDB store
 * (~/.gemdex/lance by default). Both the MCP server and the `gemdex serve`
 * sidecar use this so a memory saved by the agent shows up in the app and
 * vice-versa.
 */
export function createMemoryBackend(config: GemdexConfig, localHomeDir?: string): MemoryBackend {
    if (config.mode === 'remote') {
        if (!config.remote) {
            throw new Error('Remote mode is selected but no resolved Gemdex Server connection is available.');
        }
        return new RemoteMemoryBackend(config.remote);
    }

    const provider = config.embeddingProvider ?? 'gemini';
    if (provider === 'mlx' && !getMlxStatus(localHomeDir).installed) {
        throw new Error('Local MLX is not installed. Run npx gemdex-mcp install on an Apple Silicon Mac.');
    }
    if (provider === 'gemini' && !config.geminiApiKey) {
        throw new Error('Run npx gemdex-mcp setup gemini, install, or init-remote to choose a backend.');
    }
    const embedding = config.geminiApiKey
        ? createEmbeddingInstance(config)
        : new UnconfiguredGeminiEmbedding(Number(envManager.get('EMBEDDING_DIMENSION') ?? 3072));

    const vectorDatabase = new LanceDBVectorDatabase({
        ...(config.lancedbPath && { uri: config.lancedbPath }),
    });

    return new LocalMemoryBackend({
        embedding, vectorDatabase,
        textEmbedding: new MlxEmbedding({ homeDir: localHomeDir }),
        textProvider: () => provider,
    });
}
