import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embedding, EmbeddingContent, EmbeddingVector } from './base-embedding';
import { assertMlxPlatform, getMlxStatus, mlxWorkerArgs, verifyMlxFiles } from './mlx-install';
import { MLX_DIMENSION } from './mlx-manifest';
import { MlxEmbeddingKind, MlxInput, MlxProcess } from './mlx-process';

/** File extensions for media handed to the worker; decoders sniff content, but some pick by extension. */
const MEDIA_EXTENSIONS: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'audio/mp3': '.mp3', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
    'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
    'audio/aiff': '.aiff', 'audio/x-aiff': '.aiff',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v', 'video/webm': '.webm',
};

/**
 * Offline EmbeddingGemma 2 embeddings for text, images, audio and video in one
 * 768-dimensional space. Construction and status never install or spawn.
 */
export class MlxEmbedding extends Embedding {
    protected maxTokens = 8192;
    private worker?: MlxProcess;
    private ready?: Promise<void>;
    private tail: Promise<void> = Promise.resolve();
    private queued = 0;
    private generation = 0;
    constructor(private options: { homeDir?: string } = {}) { super(); }
    getDimension(): number { return MLX_DIMENSION; }
    getProvider(): string { return 'mlx'; }
    isMultimodal(): boolean { return true; }
    async detectDimension(): Promise<number> { await this.embed('dimension check'); return MLX_DIMENSION; }
    async embed(text: string): Promise<EmbeddingVector> { return (await this.embedBatch([text]))[0]; }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> { return this.run(texts.map(text => ({ text })), 'document'); }
    /** EmbeddingGemma 2 uses a distinct retrieval prompt for search queries. */
    async embedQuery(text: string): Promise<EmbeddingVector> { return (await this.run([{ text }], 'query'))[0]; }
    async embedContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> { return this.runContents(contents, 'document'); }
    async embedQueryContentBatch(contents: EmbeddingContent[]): Promise<EmbeddingVector[]> { return this.runContents(contents, 'query'); }

    /** Media bytes go to the worker as files in a private directory that is removed afterwards. */
    private async runContents(contents: EmbeddingContent[], kind: MlxEmbeddingKind): Promise<EmbeddingVector[]> {
        if (contents.every(content => typeof content === 'string')) {
            return this.run((contents as string[]).map(text => ({ text })), kind);
        }
        const directory = await mkdtemp(join(tmpdir(), 'gemdex-mlx-'));
        try {
            const inputs: MlxInput[] = [];
            for (const [index, content] of contents.entries()) {
                if (typeof content === 'string') { inputs.push({ text: content }); continue; }
                const mimeType = content.inlineData.mimeType.toLowerCase();
                const path = join(directory, `${index}${MEDIA_EXTENSIONS[mimeType] ?? ''}`);
                await writeFile(path, Buffer.from(content.inlineData.data, 'base64'), { mode: 0o600 });
                inputs.push({ path, mimeType });
            }
            return await this.run(inputs, kind);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    private async run(inputs: MlxInput[], kind: MlxEmbeddingKind): Promise<EmbeddingVector[]> {
        if (inputs.length === 0) return [];
        if (this.queued >= 16) throw new Error('MLX embedding queue is full; retry after pending requests finish');
        if (inputs.length > 256) throw new Error('MLX embedding batch exceeds 256 inputs; split the batch');
        const textBytes = inputs.reduce((bytes, input) => bytes + ('text' in input ? Buffer.byteLength(input.text) : 0), 0);
        if (textBytes > 1024 * 1024) throw new Error('MLX embedding batch exceeds 1 MiB; split the batch');
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
            for (let i = 0; i < inputs.length; i += 16) {
                if (generation !== this.generation) throw new Error('MLX embedding closed');
                const vectors = await this.worker.request(inputs.slice(i, i + 16), kind);
                results.push(...vectors.map(vector => ({ vector, dimension: MLX_DIMENSION })));
            }
            return results;
        } finally { this.queued--; release(); }
    }
    close(): void { this.generation++; this.worker?.close(); this.worker = undefined; this.ready = undefined; }
}
