import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, stat, readdir, readlink } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MLX_ARTIFACTS, MLX_MODEL, MLX_REVISION } from './mlx-manifest';
import { MLX_WORKER } from './mlx-worker';
import { MlxProcess } from './mlx-process';

const exec = promisify(execFile);
export const MLX_INSTALL_ID = createHash('sha256').update(JSON.stringify(MLX_ARTIFACTS) + MLX_WORKER).digest('hex');
export function mlxRoot(homeDir = join(homedir(), '.gemdex')): string { return join(homeDir, 'mlx', MLX_INSTALL_ID); }
export function assertMlxPlatform(): void {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(release().split('.')[0]) < 23) {
        throw new Error('Local MLX embeddings require native Apple Silicon Node.js on macOS 14 or newer. Use Gemini or remote mode on this machine.');
    }
}
export function getMlxStatus(homeDir?: string): { installed: boolean; model: string; revision: string; dimension: number; path: string } {
    const path = mlxRoot(homeDir);
    let installed = false;
    try { installed = readFileSync(join(path, 'installed'), 'utf8') === MLX_INSTALL_ID; } catch { /* not installed */ }
    return { installed, model: MLX_MODEL, revision: MLX_REVISION, dimension: 1024, path };
}
async function digest(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}
async function runtimeDigest(root: string): Promise<string> {
    const hash = createHash('sha256');
    async function walk(path: string): Promise<void> {
        const entries = await readdir(join(root, path), { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const child = join(path, entry.name);
            if (entry.isDirectory()) await walk(child);
            else hash.update(JSON.stringify([child, entry.isSymbolicLink() ? ['link', await readlink(join(root, child))] : await digest(join(root, child))]));
        }
    }
    await walk('python');
    return hash.digest('hex');
}
export async function verifyMlxFiles(root: string): Promise<void> {
    for (const artifact of MLX_ARTIFACTS) {
        if (await digest(join(root, artifact.path)) !== artifact.sha256) throw new Error(`MLX integrity check failed: ${artifact.path}. Run the explicit model install to repair it.`);
    }
    if (await readFile(join(root, 'worker.py'), 'utf8') !== MLX_WORKER) throw new Error('MLX worker integrity check failed; reinstall the model');
    if (!existsSync(join(root, 'python/bin/python3'))) throw new Error('MLX runtime is missing; reinstall the model');
    if (await runtimeDigest(root) !== await readFile(join(root, 'runtime.sha256'), 'utf8')) throw new Error('MLX installed runtime integrity check failed; reinstall the model');
}

/** Download only during explicit installation. Incomplete files never become artifacts. */
export async function downloadMlxArtifact(artifact: { url: string; sha256: string; path: string }, root: string): Promise<void> {
    const destination = join(root, artifact.path);
    try { if (await digest(destination) === artifact.sha256) return; } catch { /* missing/interrupted */ }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const partial = destination + '.part';
    try {
        const response = await fetch(artifact.url, { signal: AbortSignal.timeout(10 * 60_000) });
        if (!response.ok || !response.body) throw new Error(`MLX download failed (${response.status}): ${artifact.path}`);
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(partial, { mode: 0o600 }));
        if (await digest(partial) !== artifact.sha256) throw new Error(`MLX download integrity check failed: ${artifact.path}`);
        await rename(partial, destination);
    } finally { await rm(partial, { force: true }); }
}

/** PID lock: live installs fail clearly; crashed installs can be retried explicitly. */
async function acquireLock(path: string): Promise<() => Promise<void>> {
    const token = `${process.pid}:${randomUUID()}`;
    try { await writeFile(path, token, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = await readFile(path, 'utf8');
        const pid = Number(owner.split(':')[0]);
        let live = true;
        if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { live = (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
        } else { live = Date.now() - (await stat(path)).mtimeMs < 60_000; }
        if (live) throw new Error('An MLX install is already in progress. Wait for it to finish and retry.');
        // Claim recovery separately so two rescuers cannot unlink each other's new lock.
        const releaseRecovery = await acquireLock(path + '.recovery');
        try {
            if (await readFile(path, 'utf8') !== owner) throw new Error('MLX install lock changed; retry');
            await rm(path);
            await writeFile(path, token, { flag: 'wx', mode: 0o600 });
        } finally { await releaseRecovery(); }
    }
    return async () => { if (await readFile(path, 'utf8') === token) await rm(path); };
}

export async function installMlxModel(options: { homeDir?: string; onProgress?: (message: string) => void } = {}): Promise<void> {
    assertMlxPlatform();
    const root = mlxRoot(options.homeDir);
    const parent = dirname(root);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const unlock = await acquireLock(join(parent, 'install.lock'));
    const stage = root + '.staging';
    try {
        if (getMlxStatus(options.homeDir).installed) {
            try { await verifyMlxFiles(root); options.onProgress?.('MLX model already installed and verified'); return; }
            catch {
                await rm(join(root, 'installed'), { force: true });
                options.onProgress?.('Repairing incomplete or damaged MLX installation');
            }
        }
        await mkdir(stage, { recursive: true, mode: 0o700 });
        for (const artifact of MLX_ARTIFACTS) {
            options.onProgress?.(`Verifying/downloading ${artifact.path}`);
            await downloadMlxArtifact(artifact, stage);
        }
        // Only the pinned, SHA-256-verified archive is extracted, using macOS's built-in tar.
        await rm(join(stage, 'python'), { recursive: true, force: true });
        await exec('/usr/bin/tar', ['-xzf', join(stage, 'python.tar.gz'), '-C', stage], { timeout: 120_000 });
        const python = join(stage, 'python/bin/python3');
        const wheels = MLX_ARTIFACTS.filter(a => a.path.startsWith('wheels/')).map(a => join(stage, a.path));
        options.onProgress?.('Installing verified offline Python wheels');
        await exec(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-deps', '--no-compile', '--disable-pip-version-check', ...wheels], { timeout: 120_000, maxBuffer: 1024 * 1024 });
        await writeFile(join(stage, 'worker.py'), MLX_WORKER, { mode: 0o600 });
        await writeFile(join(stage, 'runtime.sha256'), await runtimeDigest(stage), { mode: 0o600 });
        await verifyMlxFiles(stage);
        options.onProgress?.('Smoke-testing local MLX embeddings');
        const worker = new MlxProcess(python, ['-I', '-B', '-u', join(stage, 'worker.py'), join(stage, 'model')]);
        try { await worker.request(['Gemdex local embedding installation check']); } finally { worker.close(); }
        // Commit only after inference passes; failed repair never advertises a new install.
        await writeFile(join(stage, 'installed'), MLX_INSTALL_ID, { mode: 0o600 });
        await rm(root, { recursive: true, force: true });
        await rename(stage, root);
        options.onProgress?.('MLX model installed and verified');
    } finally { await unlock(); }
}
