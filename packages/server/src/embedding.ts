import {
    Embedding,
    EmbeddingContent,
    EmbeddingVector,
    GeminiEmbedding,
} from 'gemdex-core';
import type { ServerConfig } from './config.js';

const MISSING_KEY_ERROR =
    'GEMINI_API_KEY is required on gemdex-server for save, recall, update, and import embedding operations.';

class MissingServerEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 3072;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        throw new Error(MISSING_KEY_ERROR);
    }

    async embedBatch(_texts: string[]): Promise<EmbeddingVector[]> {
        throw new Error(MISSING_KEY_ERROR);
    }

    async embedContentBatch(_contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        throw new Error(MISSING_KEY_ERROR);
    }

    getDimension(): number {
        return 3072;
    }

    getProvider(): string {
        return 'Gemini (not configured)';
    }

    isMultimodal(): boolean {
        return true;
    }
}

export function createServerEmbedding(config: ServerConfig): Embedding {
    if (!config.geminiApiKey) return new MissingServerEmbedding();
    return new GeminiEmbedding({
        apiKey: config.geminiApiKey,
        model: config.embeddingModel,
        ...(config.geminiBaseUrl && { baseURL: config.geminiBaseUrl }),
        ...(config.embeddingDimension && { outputDimensionality: config.embeddingDimension }),
    });
}
