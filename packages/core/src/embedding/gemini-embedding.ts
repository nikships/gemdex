import { GoogleGenAI } from '@google/genai';
import { Embedding, EmbeddingVector } from './base-embedding';
import type { EmbeddingContent } from './base-embedding';

type GeminiModelInfo = {
    dimension: number;
    contextLength: number;
    description: string;
    supportedDimensions?: number[];
};

const DEFAULT_MODEL = 'gemini-embedding-2';

export interface GeminiEmbeddingConfig {
    model?: string;
    apiKey: string;
    baseURL?: string;
    outputDimensionality?: number;
}

export class GeminiEmbedding extends Embedding {
    private client: GoogleGenAI;
    private config: GeminiEmbeddingConfig;
    private dimension: number = 3072;
    protected maxTokens: number = 8192;

    constructor(config: GeminiEmbeddingConfig) {
        super();
        this.config = { ...config, model: config.model || DEFAULT_MODEL };
        this.client = new GoogleGenAI({
            apiKey: config.apiKey,
            ...(config.baseURL && { httpOptions: { baseUrl: config.baseURL } }),
        });

        this.updateDimensionForModel(this.config.model!);
        if (config.outputDimensionality) {
            this.dimension = config.outputDimensionality;
        }
    }

    private updateDimensionForModel(model: string): void {
        const modelInfo = GeminiEmbedding.getSupportedModels()[model];
        if (modelInfo) {
            this.dimension = modelInfo.dimension;
            this.maxTokens = modelInfo.contextLength;
        } else {
            this.dimension = 3072;
            this.maxTokens = 8192;
        }
    }

    async detectDimension(): Promise<number> {
        return this.dimension;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        const [vector] = await this.embedBatch([text]);
        return vector;
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return this.embedContentBatch(texts);
    }

    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        if (contents.length === 0) return [];

        const model = this.config.model!;

        // gemini-embedding-2 is multimodal and aggregates a flat string array into
        // a SINGLE embedding. Wrapping each input in a Content object
        // ({ parts: [{ text }] }) tells the API to return one embedding per input.
        // This shape is also valid for gemini-embedding-001, so use it uniformly.
        // Ref: https://ai.google.dev/gemini-api/docs/embeddings#embedding-aggregation
        const requestContents = contents.map((content) => ({
            parts: [
                typeof content === 'string'
                    ? { text: this.preprocessText(content) }
                    : {
                        inline_data: {
                            mime_type: content.inlineData.mimeType,
                            data: content.inlineData.data,
                        },
                    },
            ],
        }));

        const dim = this.config.outputDimensionality || this.dimension;
        const response = await this.client.models.embedContent({
            model,
            contents: requestContents,
            config: { outputDimensionality: dim },
        });

        const embeddings = response.embeddings;
        if (!embeddings) {
            throw new Error('Gemini API returned no embeddings');
        }
        if (embeddings.length !== contents.length) {
            throw new Error(
                `Gemini API returned ${embeddings.length} embeddings for ${contents.length} inputs. ` +
                `This usually means the model aggregated inputs; check that each input is wrapped in a Content object.`
            );
        }

        return embeddings.map((embedding: { values?: number[] }) => {
            const values = embedding.values;
            if (!values) {
                throw new Error('Gemini API returned an embedding with no values');
            }
            return { vector: values, dimension: values.length };
        });
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return 'Gemini';
    }

    setModel(model: string): void {
        this.config.model = model;
        this.updateDimensionForModel(model);
    }

    setOutputDimensionality(dimension: number): void {
        this.config.outputDimensionality = dimension;
        this.dimension = dimension;
    }

    getClient(): GoogleGenAI {
        return this.client;
    }

    static getSupportedModels(): Record<string, GeminiModelInfo> {
        return {
            'gemini-embedding-2': {
                dimension: 3072,
                contextLength: 8192,
                description: 'Gemini Embedding 2 — multimodal, 8K context, 3072 dim',
                supportedDimensions: [3072, 1536, 768, 256],
            },
            'gemini-embedding-001': {
                dimension: 3072,
                contextLength: 2048,
                description: 'Gemini Embedding 1 — text only, 2K context',
                supportedDimensions: [3072, 1536, 768, 256],
            },
        };
    }

    getSupportedDimensions(): number[] {
        const modelInfo = GeminiEmbedding.getSupportedModels()[this.config.model!];
        return modelInfo?.supportedDimensions || [this.dimension];
    }

    isDimensionSupported(dimension: number): boolean {
        return this.getSupportedDimensions().includes(dimension);
    }
}
