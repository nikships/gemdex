import { GoogleGenAI } from '@google/genai';
import { GeminiEmbedding } from './gemini-embedding';

const mockEmbedContent = jest.fn();

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
            embedContent: mockEmbedContent,
        },
    })),
}));

describe('GeminiEmbedding', () => {
    beforeEach(() => {
        mockEmbedContent.mockReset();
        (GoogleGenAI as unknown as jest.Mock).mockClear();
    });

    it('exposes Gemini Embedding 2 model metadata and defaults to it', () => {
        const supportedModels = GeminiEmbedding.getSupportedModels();
        expect(supportedModels['gemini-embedding-2']).toMatchObject({ dimension: 3072, contextLength: 8192 });

        const embedding = new GeminiEmbedding({ apiKey: 'test-api-key' });
        expect(embedding.getDimension()).toBe(3072);
        expect(embedding.getSupportedDimensions()).toContain(3072);
        expect(embedding.getSupportedDimensions()).toContain(768);
        expect(embedding.isMultimodal()).toBe(true);
    });

    it('wraps each input in a Content object so embedding-2 returns N embeddings instead of aggregating', async () => {
        mockEmbedContent.mockResolvedValue({
            embeddings: [{ values: [1, 0, 0] }, { values: [0, 1, 0] }],
        });

        const embedding = new GeminiEmbedding({ apiKey: 'test-api-key', model: 'gemini-embedding-2' });
        const embeddings = await embedding.embedBatch(['first chunk', 'second chunk']);

        expect(embeddings).toEqual([
            { vector: [1, 0, 0], dimension: 3 },
            { vector: [0, 1, 0], dimension: 3 },
        ]);
        expect(mockEmbedContent).toHaveBeenCalledTimes(1);
        expect(mockEmbedContent).toHaveBeenCalledWith({
            model: 'gemini-embedding-2',
            contents: [
                { parts: [{ text: 'first chunk' }] },
                { parts: [{ text: 'second chunk' }] },
            ],
            config: { outputDimensionality: 3072 },
        });
    });

    it('uses the same Content-object batching shape for gemini-embedding-001', async () => {
        mockEmbedContent.mockResolvedValue({
            embeddings: [{ values: [1, 0, 0] }, { values: [0, 1, 0] }],
        });

        const embedding = new GeminiEmbedding({ apiKey: 'test-api-key', model: 'gemini-embedding-001' });
        expect(embedding.isMultimodal()).toBe(false);
        await embedding.embedBatch(['first chunk', 'second chunk']);

        expect(mockEmbedContent).toHaveBeenCalledWith({
            model: 'gemini-embedding-001',
            contents: [
                { parts: [{ text: 'first chunk' }] },
                { parts: [{ text: 'second chunk' }] },
            ],
            config: { outputDimensionality: 3072 },
        });
    });

    it('throws a clear error when the response count does not match the inputs (aggregation guard)', async () => {
        mockEmbedContent.mockResolvedValue({ embeddings: [{ values: [1, 0, 0] }] });

        const embedding = new GeminiEmbedding({ apiKey: 'test-api-key', model: 'gemini-embedding-2' });

        await expect(embedding.embedBatch(['first chunk', 'second chunk']))
            .rejects
            .toThrow(/returned 1 embeddings for 2 inputs/);
    });

    it('returns an empty batch without calling the Gemini API', async () => {
        const embedding = new GeminiEmbedding({ apiKey: 'test-api-key' });
        await expect(embedding.embedBatch([])).resolves.toEqual([]);
        expect(mockEmbedContent).not.toHaveBeenCalled();
    });

    it('sends inline media using the @google/genai camelCase request shape', async () => {
        mockEmbedContent.mockResolvedValue({
            embeddings: [{ values: [1, 0, 0] }],
        });

        const embedding = new GeminiEmbedding({ apiKey: 'test-api-key', model: 'gemini-embedding-2' });
        await embedding.embedContentBatch([{
            inlineData: {
                mimeType: 'image/png',
                data: 'base64-image-data',
            },
        }]);

        expect(mockEmbedContent).toHaveBeenCalledWith({
            model: 'gemini-embedding-2',
            contents: [
                {
                    parts: [{
                        inlineData: {
                            mimeType: 'image/png',
                            data: 'base64-image-data',
                        },
                    }],
                },
            ],
            config: { outputDimensionality: 3072 },
        });
    });
});
