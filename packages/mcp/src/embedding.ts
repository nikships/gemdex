import { GeminiEmbedding } from "gemdex-core";
import { ContextMcpConfig } from "./config.js";

export function createEmbeddingInstance(config: ContextMcpConfig): GeminiEmbedding {
    if (!config.geminiApiKey) {
        throw new Error('GEMINI_API_KEY is required');
    }
    console.log(`[EMBEDDING] Configuring Gemini with model: ${config.embeddingModel}`);
    return new GeminiEmbedding({
        apiKey: config.geminiApiKey,
        model: config.embeddingModel,
        ...(config.geminiBaseUrl && { baseURL: config.geminiBaseUrl }),
    });
}

export function logEmbeddingProviderInfo(config: ContextMcpConfig, embedding: GeminiEmbedding): void {
    console.log(`[EMBEDDING] ✅ Initialized Gemini embedding provider`);
    console.log(`[EMBEDDING] Model: ${config.embeddingModel}, Dimension: ${embedding.getDimension()}`);
    if (config.geminiBaseUrl) {
        console.log(`[EMBEDDING] Custom base URL: ${config.geminiBaseUrl}`);
    }
}
