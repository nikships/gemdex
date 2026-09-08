import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { MlxEmbedding } from './mlx-embedding';
import { MlxProcess } from './mlx-process';
import { MLX_ARTIFACTS } from './mlx-manifest';
import { getMlxStatus, installMlxModel, downloadMlxArtifact, mlxRoot, verifyMlxFiles } from './mlx-install';

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), release: () => '25.0.0' }));
jest.mock('./mlx-manifest', () => ({ MLX_MODEL: 'fixture/model', MLX_REVISION: 'immutable', MLX_ARTIFACTS: [
    { path: 'python.tar.gz', url: 'https://fixture.invalid/python', sha256: require('node:crypto').createHash('sha256').update('fixture').digest('hex') },
] }));
jest.mock('node:child_process', () => {
    const actual = jest.requireActual('node:child_process');
    return { ...actual, execFile: (command: string, args: string[], options: unknown, callback: (error: Error | null, stdout?: string) => void) => {
        if (command === '/usr/bin/tar') {
            const fs = require('node:fs'); const path = require('node:path');
            const root = args[args.length - 1];
            fs.mkdirSync(path.join(root, 'python/bin'), { recursive: true });
            fs.writeFileSync(path.join(root, 'python/bin/python3'), 'fixture python');
        }
        callback(null, '');
    } };
});

describe('managed installer with controlled artifacts/runtime smoke fixture', () => {
    let home: string;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'gemdex-mlx-'));
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        Object.defineProperty(process, 'arch', { value: 'arm64' });
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('fixture'));
        jest.spyOn(MlxProcess.prototype, 'request').mockResolvedValue([[1, ...Array(1023).fill(0)]]);
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        Object.defineProperty(process, 'platform', platform);
        Object.defineProperty(process, 'arch', arch);
        await rm(home, { recursive: true, force: true });
    });
    test('lazy text-only constructor and no BGE query instruction', async () => {
        const embedding = new MlxEmbedding({ homeDir: home });
        expect(embedding.getDimension()).toBe(1024);
        expect(embedding.isMultimodal()).toBe(false);
        expect(getMlxStatus(home).installed).toBe(false);
        await expect(embedding.embedContentBatch([{ inlineData: { mimeType: 'image/png', data: '' } }])).rejects.toThrow('inline media');
        await expect(embedding.embed('text')).rejects.toThrow('not installed');
        expect(fetch).not.toHaveBeenCalled();
        const spy = jest.spyOn(embedding, 'embed').mockResolvedValue({ vector: [], dimension: 1024 });
        await embedding.embedQuery('question');
        expect(spy).toHaveBeenCalledWith('question');
    });
    test('refuses unsupported platforms before writes/downloads', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const embedding = new MlxEmbedding({ homeDir: home });
        await expect(installMlxModel({ homeDir: home })).rejects.toThrow('Apple Silicon');
        await expect(embedding.embed('x')).rejects.toThrow('Apple Silicon');
        expect(fetch).not.toHaveBeenCalled();
        expect(existsSync(join(home, 'mlx'))).toBe(false);
    });
    test('commits after smoke, is idempotent offline and checks installed runtime corruption', async () => {
        await installMlxModel({ homeDir: home });
        expect(getMlxStatus(home).installed).toBe(true);
        expect(MlxProcess.prototype.request).toHaveBeenCalledTimes(1);
        (fetch as jest.Mock).mockRejectedValue(new Error('offline'));
        await installMlxModel({ homeDir: home });
        expect(fetch).toHaveBeenCalledTimes(1);
        await verifyMlxFiles(mlxRoot(home));
        await writeFile(join(mlxRoot(home), 'python/bin/python3'), 'damaged');
        await expect(verifyMlxFiles(mlxRoot(home))).rejects.toThrow('runtime integrity');
        await expect(installMlxModel({ homeDir: home })).rejects.toThrow('offline');
        expect(getMlxStatus(home).installed).toBe(false);
    });
    test('serializes concurrent embeddings, bounds queue and cancels waiting work', async () => {
        await installMlxModel({ homeDir: home });
        const embedding = new MlxEmbedding({ homeDir: home });
        const outputs = await Promise.all([embedding.embed('a'), embedding.embed('b')]);
        expect(outputs.map(x => x.dimension)).toEqual([1024, 1024]);
        const pending = Array.from({ length: 16 }, () => embedding.embed('c'));
        const settled = Promise.allSettled(pending);
        const overflow = embedding.embed('overflow');
        embedding.close();
        await expect(overflow).rejects.toThrow('queue is full');
        expect((await settled).every(result => result.status === 'rejected')).toBe(true);
        await expect(embedding.embedBatch(Array(257).fill(''))).rejects.toThrow('256 texts');
        await expect(embedding.embed('x'.repeat(1024 * 1024 + 1))).rejects.toThrow('1 MiB');
    });
    test('offline failure cleans partial/lock, retries; smoke failure never marks installed', async () => {
        (fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
        await expect(installMlxModel({ homeDir: home })).rejects.toThrow('offline');
        expect(existsSync(join(dirname(mlxRoot(home)), 'install.lock'))).toBe(false);
        expect(existsSync(mlxRoot(home) + '.staging/python.tar.gz.part')).toBe(false);
        (MlxProcess.prototype.request as jest.Mock).mockRejectedValueOnce(new Error('smoke failed'));
        await expect(installMlxModel({ homeDir: home })).rejects.toThrow('smoke failed');
        expect(getMlxStatus(home).installed).toBe(false);
        await installMlxModel({ homeDir: home });
        expect(getMlxStatus(home).installed).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2); // verified stage reused on retry
    });
    test('concurrent install refuses live lock, dead PID lock can recover', async () => {
        const parent = dirname(mlxRoot(home));
        await mkdir(parent, { recursive: true });
        await writeFile(join(parent, 'install.lock'), `${process.pid}:active`);
        await expect(installMlxModel({ homeDir: home })).rejects.toThrow('already in progress');
        await writeFile(join(parent, 'install.lock'), '2147483647:dead');
        await installMlxModel({ homeDir: home });
        expect(getMlxStatus(home).installed).toBe(true);
    });
    test('hash mismatch cannot commit; verified download resumes without network', async () => {
        (fetch as jest.Mock).mockResolvedValueOnce(new Response('wrong bytes'));
        await expect(downloadMlxArtifact(MLX_ARTIFACTS[0], home)).rejects.toThrow('integrity');
        expect(existsSync(join(home, 'python.tar.gz'))).toBe(false);
        expect(existsSync(join(home, 'python.tar.gz.part'))).toBe(false);
        await downloadMlxArtifact(MLX_ARTIFACTS[0], home);
        await downloadMlxArtifact(MLX_ARTIFACTS[0], home);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
