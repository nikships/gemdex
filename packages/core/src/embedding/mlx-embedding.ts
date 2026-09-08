import { join } from 'node:path';
import { Embedding, EmbeddingVector } from './base-embedding';
import { assertMlxPlatform, getMlxStatus, verifyMlxFiles } from './mlx-install';
import { MlxProcess } from './mlx-process';

/** Offline, text-only BGE-M3 embeddings. Construction and status never install or spawn. */
export class MlxEmbedding extends Embedding {
    protected maxTokens = 2048;
    private worker?: MlxProcess;
    private ready?: Promise<void>;
    private tail: Promise<void> = Promise.resolve();
    private queued = 0;
    private generation = 0;
    constructor(private options: { homeDir?: string } = {}) { super(); }
    getDimension(): number { return 1024; }
    getProvider(): string { return 'mlx'; }
    async detectDimension(): Promise<number> { await this.embed('dimension check'); return 1024; }
    async embed(text: string): Promise<EmbeddingVector> { return (await this.embedBatch([text]))[0]; }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
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
            this.worker ??= new MlxProcess(join(status.path, 'python/bin/python3'), ['-I', '-B', '-u', join(status.path, 'worker.py'), join(status.path, 'model')]);
            const results: EmbeddingVector[] = [];
            for (let i = 0; i < texts.length; i += 16) {
                if (generation !== this.generation) throw new Error('MLX embedding closed');
                const vectors = await this.worker.request(texts.slice(i, i + 16));
                results.push(...vectors.map(vector => ({ vector, dimension: 1024 })));
            }
            return results;
        } finally { this.queued--; release(); }
    }
    close(): void { this.generation++; this.worker?.close(); this.worker = undefined; this.ready = undefined; }
}
