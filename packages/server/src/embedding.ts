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

    constructor(
        private readonly dimension = 3072,
        private readonly model = 'gemini-embedding-2',
    ) {
        super();
    }

    async detectDimension(): Promise<number> {
        return this.dimension;
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
        return this.dimension;
    }

    getProvider(): string {
        return 'Gemini (not configured)';
    }

    isMultimodal(): boolean {
        return this.model === 'gemini-embedding-2';
    }
}

export function createServerEmbedding(config: ServerConfig): Embedding {
    if (!config.geminiApiKey) {
        return new MissingServerEmbedding(config.embeddingDimension, config.embeddingModel);
    }
    return new GeminiEmbedding({
        apiKey: config.geminiApiKey,
        model: config.embeddingModel,
        ...(config.geminiBaseUrl && { baseURL: config.geminiBaseUrl }),
        ...(config.embeddingDimension && { outputDimensionality: config.embeddingDimension }),
    });
}
