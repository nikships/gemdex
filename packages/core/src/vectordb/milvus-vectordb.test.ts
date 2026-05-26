jest.mock('@zilliz/milvus2-sdk-node', () => ({
    MilvusClient: jest.fn(),
    DataType: {
        VarChar: 'VarChar',
        FloatVector: 'FloatVector',
        SparseFloatVector: 'SparseFloatVector',
        Int64: 'Int64',
    },
    MetricType: {
        COSINE: 'COSINE',
        BM25: 'BM25',
    },
    FunctionType: {
        BM25: 'BM25',
    },
    LoadState: {
        LoadStateLoaded: 'LoadStateLoaded',
    },
}));

import { MilvusVectorDatabase } from './milvus-vectordb';

const successStatus = { error_code: 'Success', reason: '' };

function createMilvusClientMock(overrides: Record<string, jest.Mock> = {}) {
    return {
        createCollection: jest.fn().mockResolvedValue(successStatus),
        createIndex: jest.fn().mockResolvedValue(successStatus),
        getIndexBuildProgress: jest.fn().mockResolvedValue({
            status: successStatus,
            indexed_rows: 0,
            total_rows: 0,
        }),
        describeIndex: jest.fn().mockResolvedValue({
            status: successStatus,
            index_descriptions: [],
        }),
        loadCollection: jest.fn().mockResolvedValue(successStatus),
        describeCollection: jest.fn().mockResolvedValue({ status: successStatus }),
        ...overrides,
    };
}

async function createDatabaseWithMockClient(client: Record<string, jest.Mock>): Promise<MilvusVectorDatabase> {
    const db = new MilvusVectorDatabase({ address: 'localhost:19530' });
    await (db as any).initializationPromise;
    (db as any).client = client;
    return db;
}

describe('MilvusVectorDatabase createHybridCollection sparse index handling', () => {
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('skips explicit sparse index creation when Milvus has already auto-created one', async () => {
        const client = createMilvusClientMock({
            describeIndex: jest.fn().mockResolvedValue({
                status: successStatus,
                index_descriptions: [
                    {
                        field_name: 'sparse_vector',
                        index_name: '',
                    },
                ],
            }),
        });
        const db = await createDatabaseWithMockClient(client);

        await db.createHybridCollection('hybrid_collection', 768);

        expect(client.createIndex).toHaveBeenCalledTimes(1);
        expect(client.createIndex).toHaveBeenCalledWith(expect.objectContaining({
            field_name: 'vector',
            index_name: 'vector_index',
        }));
        expect(client.getIndexBuildProgress).toHaveBeenCalledWith({
            collection_name: 'hybrid_collection',
            field_name: 'sparse_vector',
        });
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('treats duplicate sparse index statuses as a no-op without contradictory error logging', async () => {
        const duplicateStatus = {
            error_code: 'UnexpectedError',
            reason: 'index duplicates[indexName=]',
            code: 702,
        };
        const client = createMilvusClientMock({
            createIndex: jest.fn()
                .mockResolvedValueOnce(successStatus)
                .mockResolvedValueOnce(duplicateStatus),
            getIndexBuildProgress: jest.fn(({ field_name }) => Promise.resolve(
                field_name === 'sparse_vector'
                    ? { status: duplicateStatus, indexed_rows: 0, total_rows: 0 }
                    : { status: successStatus, indexed_rows: 0, total_rows: 0 }
            )),
        });
        const db = await createDatabaseWithMockClient(client);

        await db.createHybridCollection('hybrid_collection', 768);

        expect(client.createIndex).toHaveBeenCalledWith(expect.objectContaining({
            field_name: 'sparse_vector',
            index_name: 'sparse_vector_index',
        }));
        expect(errorSpy).not.toHaveBeenCalled();

        const logOutput = logSpy.mock.calls.map(call => call.join(' ')).join('\n');
        expect(logOutput).toContain('already exists or was auto-created by Milvus');
        expect(logOutput).not.toContain('Full response');
        expect(logOutput).not.toContain("Index on field 'sparse_vector' is ready!");
    });
});
