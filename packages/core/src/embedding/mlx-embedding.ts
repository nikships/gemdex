import { Embedding, EmbeddingVector } from './base-embedding';
import { assertMlxPlatform, getMlxStatus, mlxWorkerArgs, verifyMlxFiles } from './mlx-install';
import { MLX_DIMENSION } from './mlx-manifest';
import { MlxEmbeddingKind, MlxProcess } from './mlx-process';
import { join } from 'node:path';

/** Offline, text-only EmbeddingGemma 2 embeddings. Construction and status never install or spawn. */
export class MlxEmbedding extends Embedding {
    protected maxTokens = 2048;
    private worker?: MlxProcess;
    private ready?: Promise<void>;
    private tail: Promise<void> = Promise.resolve();
    private queued = 0;
    private generation = 0;
    constructor(private options: { homeDir?: string } = {}) { super(); }
    getDimension(): number { return MLX_DIMENSION; }
    getProvider(): string { return 'mlx'; }
    async detectDimension(): Promise<number> { await this.embed('dimension check'); return MLX_DIMENSION; }
    async embed(text: string): Promise<EmbeddingVector> { return (await this.embedBatch([text]))[0]; }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> { return this.run(texts, 'document'); }
    /** EmbeddingGemma 2 uses a distinct retrieval prompt for search queries. */
    async embedQuery(text: string): Promise<EmbeddingVector> { return (await this.run([text], 'query'))[0]; }
    private async run(texts: string[], kind: MlxEmbeddingKind): Promise<EmbeddingVector[]> {
        if (texts.length === 0) return [];
        if (this.queued >= 16) throw new Error('MLX embedding queue is full; retry after pending requests finish');
        if (texts.length > 256) throw new Error('MLX embedding batch exceeds 256 texts; split the batch');
        if (texts.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 1024 * 1024) throw new Error('MLX embedding batch exceeds 1 MiB; split the batch');
        this.queued++;
        const generation = this.generation;
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            if (generation !== this.generation) throw new Error('MLX embedding closed');
            assertMlxPlatform();
            const status = getMlxStatus(this.options.homeDir);
            if (!status.installed) throw new Error('MLX model is not installed. Run the explicit model install first; inference never downloads files.');
            this.ready ??= verifyMlxFiles(status.path).catch(error => { this.ready = undefined; throw error; });
            await this.ready;
            if (generation !== this.generation) throw new Error('MLX embedding closed');
            this.worker ??= new MlxProcess(join(status.path, 'python/bin/python3'), mlxWorkerArgs(status.path));
            const results: EmbeddingVector[] = [];
            for (let i = 0; i < texts.length; i += 16) {
                if (generation !== this.generation) throw new Error('MLX embedding closed');
                const vectors = await this.worker.request(texts.slice(i, i + 16), kind);
                results.push(...vectors.map(vector => ({ vector, dimension: MLX_DIMENSION })));
            }
            return results;
        } finally { this.queued--; release(); }
    }
    close(): void { this.generation++; this.worker?.close(); this.worker = undefined; this.ready = undefined; }
}
