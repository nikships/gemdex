import { GeminiEmbedding, envManager } from "gemdex-core";
import { GemdexConfig } from "./config.js";

export function createEmbeddingInstance(config: GemdexConfig): GeminiEmbedding {
    if (!config.geminiApiKey) {
        throw new Error('GEMINI_API_KEY is required');
    }
    console.log(`[EMBEDDING] Configuring Gemini with model: ${config.embeddingModel}`);
    const embedding = new GeminiEmbedding({
        apiKey: config.geminiApiKey,
        model: config.embeddingModel,
        ...(config.geminiBaseUrl && { baseURL: config.geminiBaseUrl }),
    });

    const dimensionEnv = envManager.get('EMBEDDING_DIMENSION');
    if (dimensionEnv) {
        const dimension = parseInt(dimensionEnv, 10);
        if (Number.isFinite(dimension) && dimension > 0) {
            embedding.setOutputDimensionality(dimension);
            console.log(`[EMBEDDING] Output dimension overridden to ${dimension}`);
        }
    }

    return embedding;
}

export function logEmbeddingProviderInfo(config: GemdexConfig, embedding: GeminiEmbedding): void {
    console.log(`[EMBEDDING] ✅ Initialized Gemini embedding provider`);
    console.log(`[EMBEDDING] Model: ${config.embeddingModel}, Dimension: ${embedding.getDimension()}`);
    if (config.geminiBaseUrl) {
        console.log(`[EMBEDDING] Custom base URL: ${config.geminiBaseUrl}`);
    }
}
