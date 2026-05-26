import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';
import { Embedding, EmbeddingContent, EmbeddingVector } from './embedding';
import { VectorDatabase } from './vectordb';

class RecordingEmbedding extends Embedding {
    protected maxTokens = 8192;
    public batches: EmbeddingContent[][] = [];

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: [text.length, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.batches.push(texts);
        return texts.map((text) => ({ vector: [text.length, 0, 0], dimension: 3 }));
    }

    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> {
        this.batches.push(contents);
        return contents.map((content, index) => ({
            vector: [typeof content === 'string' ? content.length : index + 1, 0, 0],
            dimension: 3,
        }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return 'recording';
    }
}

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(false),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    getCollectionDescription: jest.fn().mockResolvedValue(''),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(0),
});

describe('Context multimodal indexing', () => {
    let tempRoot: string;
    let originalHome: string | undefined;
    let originalHybridMode: string | undefined;
    let originalIndexMultimodal: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gemdex-multimodal-'));
        const homeDir = path.join(tempRoot, 'home');
        await fs.mkdir(homeDir, { recursive: true });
        originalHome = process.env.HOME;
        originalHybridMode = process.env.HYBRID_MODE;
        originalIndexMultimodal = process.env.INDEX_MULTIMODAL;
        process.env.HOME = homeDir;
        process.env.HYBRID_MODE = 'false';
        delete process.env.INDEX_MULTIMODAL;
    });

    afterEach(async () => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;

        if (originalHybridMode === undefined) delete process.env.HYBRID_MODE;
        else process.env.HYBRID_MODE = originalHybridMode;

        if (originalIndexMultimodal === undefined) delete process.env.INDEX_MULTIMODAL;
        else process.env.INDEX_MULTIMODAL = originalIndexMultimodal;

        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it('does not include media extensions when INDEX_MULTIMODAL is off', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'app.ts'), 'export const value = 1;');
        await fs.writeFile(path.join(project, 'diagram.png'), Buffer.from('not-a-real-png'));

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            embedding: new RecordingEmbedding(),
            vectorDatabase,
        });

        expect(context.getSupportedExtensions()).not.toContain('.png');

        const stats = await context.indexCodebase(project);

        expect(stats.indexedFiles).toBe(1);
        const insertedDocuments = vectorDatabase.insert.mock.calls.flatMap(([, documents]) => documents);
        expect(insertedDocuments).toHaveLength(1);
        expect(insertedDocuments[0].relativePath).toBe('app.ts');
    });

    it('indexes PDF and PNG as inline media chunks when INDEX_MULTIMODAL is on', async () => {
        process.env.INDEX_MULTIMODAL = 'true';
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'guide.pdf'), Buffer.from('%PDF-1.4\n% test pdf\n'));
        await fs.writeFile(
            path.join(project, 'diagram.png'),
            Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
        );

        const embedding = new RecordingEmbedding();
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            embedding,
            vectorDatabase,
        });

        expect(context.getSupportedExtensions()).toEqual(expect.arrayContaining(['.pdf', '.png']));

        const stats = await context.indexCodebase(project);

        expect(stats).toMatchObject({ indexedFiles: 2, totalChunks: 2, status: 'completed' });
        const insertedDocuments = vectorDatabase.insert.mock.calls.flatMap(([, documents]) => documents);
        expect(insertedDocuments).toHaveLength(2);

        const pdfDoc = insertedDocuments.find((doc) => doc.relativePath === 'guide.pdf');
        const imageDoc = insertedDocuments.find((doc) => doc.relativePath === 'diagram.png');
        expect(pdfDoc?.content).toContain('PDF page 1');
        expect(pdfDoc?.metadata).toMatchObject({ mediaType: 'pdf', page: 1, mimeType: 'application/pdf' });
        expect(imageDoc?.content).toContain('Image file');
        expect(imageDoc?.metadata).toMatchObject({ mediaType: 'image', mimeType: 'image/png' });

        const inlineInputs = embedding.batches.flat().filter((content): content is Exclude<EmbeddingContent, string> => typeof content !== 'string');
        expect(inlineInputs).toHaveLength(2);
        expect(inlineInputs.map((input) => input.inlineData.mimeType)).toEqual(
            expect.arrayContaining(['application/pdf', 'image/png'])
        );
    });
});
