import { Embedding, EmbeddingContent, EmbeddingVector, GeminiEmbedding, envManager } from "gemdex-core";
import { GemdexConfig } from "./config.js";

/** Keeps stored Gemini rows readable without pretending cloud inference is available. */
export class UnconfiguredGeminiEmbedding extends Embedding {
    protected maxTokens = 8192;
    constructor(private dimension = 3072) { super(); }
    getDimension(): number { return this.dimension; }
    getProvider(): string { return 'Gemini'; }
    isMultimodal(): boolean { return true; }
    async detectDimension(): Promise<number> { return this.dimension; }
    async embed(_text: string): Promise<EmbeddingVector> {
        throw new Error('Gemini is required to search existing Gemini memories or embed media. Run npx gemdex-mcp setup gemini. Local MLX text remains stored safely.');
    }
    async embedBatch(_texts: string[]): Promise<EmbeddingVector[]> {
        await this.embed('');
        return [];
    }
    async embedContentBatch(_contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        return this.embedBatch([]);
    }
}

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
