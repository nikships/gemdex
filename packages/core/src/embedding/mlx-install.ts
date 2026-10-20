import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile, stat, readdir, readlink } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MLX_ARTIFACTS, MLX_DIMENSION, MLX_MODEL, MLX_REVISION } from './mlx-manifest';
import { MLX_WORKER } from './mlx-worker';
import { MlxProcess } from './mlx-process';

const exec = promisify(execFile);
export const MLX_INSTALL_ID = createHash('sha256').update(JSON.stringify(MLX_ARTIFACTS) + MLX_WORKER).digest('hex');
export function mlxRoot(homeDir = join(homedir(), '.gemdex')): string { return join(homeDir, 'mlx', MLX_INSTALL_ID); }
/** Python arguments for the worker: the pinned model directory. */
export function mlxWorkerArgs(root: string): string[] {
    return ['-I', '-B', '-u', join(root, 'worker.py'), join(root, 'model')];
}
/** Artifacts needed only to build the runtime; removed once it is installed and covered by the runtime digest. */
function isInstallOnly(path: string): boolean {
    return path === 'python.tar.gz' || path.startsWith('wheels/');
}
/** A 32×32 PNG that smoke-tests the vision path of the installed runtime. */
const SMOKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAhklEQVR42u2W0RIAIQRFY/z/L9vXdkosstNMHotzk0mAmdtOw7bZzhcgqyPAZNFQP3Ki+62lDDnRZhmM0jV/zKHLUZhGF2Lr30Hk+DNCcQbx4w+c2+yuQLZA1v/cceqvKJ7Em/BLkSNJDLFo9PPRl1f0VUPwJz1GbbH+qUKVyZmLYpU/vxc9rwonRwCb0LcAAAAASUVORK5CYII=';
export function assertMlxPlatform(): void {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(release().split('.')[0]) < 23) {
        throw new Error('Local MLX embeddings require native Apple Silicon Node.js on macOS 14 or newer. Use Gemini or remote mode on this machine.');
    }
}
export function getMlxStatus(homeDir?: string): { installed: boolean; model: string; revision: string; dimension: number; path: string } {
    const path = mlxRoot(homeDir);
    let installed = false;
    try { installed = readFileSync(join(path, 'installed'), 'utf8') === MLX_INSTALL_ID; } catch { /* not installed */ }
    return { installed, model: MLX_MODEL, revision: MLX_REVISION, dimension: MLX_DIMENSION, path };
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
        if (isInstallOnly(artifact.path)) continue;
        if (await digest(join(root, artifact.path)) !== artifact.sha256) throw new Error(`MLX integrity check failed: ${artifact.path}. Run the explicit model install to repair it.`);
    }
    if (await readFile(join(root, 'worker.py'), 'utf8') !== MLX_WORKER) throw new Error('MLX worker integrity check failed; reinstall the model');
    if (!existsSync(join(root, 'python/bin/python3'))) throw new Error('MLX runtime is missing; reinstall the model');
    if (await runtimeDigest(root) !== await readFile(join(root, 'runtime.sha256'), 'utf8')) throw new Error('MLX installed runtime integrity check failed; reinstall the model');
}

/**
 * Download only during explicit installation. Incomplete files never become artifacts.
 * The deadline is a stall timeout, not a total one: the 1.2 GB weights take
 * longer than any fixed limit on a slow but healthy connection.
 */
export async function downloadMlxArtifact(artifact: { url: string; sha256: string; path: string }, root: string, stallMs = 120_000): Promise<void> {
    const destination = join(root, artifact.path);
    try { if (await digest(destination) === artifact.sha256) return; } catch { /* missing/interrupted */ }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const partial = destination + '.part';
    const controller = new AbortController();
    let stall: NodeJS.Timeout | undefined;
    const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(new Error(`MLX download stalled for ${stallMs / 1000}s: ${artifact.path}`)), stallMs);
    };
    try {
        arm();
        try {
            const response = await fetch(artifact.url, { signal: controller.signal });
            if (!response.ok || !response.body) throw new Error(`MLX download failed (${response.status}): ${artifact.path}`);
            await pipeline(
                Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
                async function* (source: AsyncIterable<Buffer>) { for await (const chunk of source) { arm(); yield chunk; } },
                createWriteStream(partial, { mode: 0o600 }),
                { signal: controller.signal },
            );
        } catch (error) {
            throw controller.signal.aborted ? controller.signal.reason : error;
        }
        clearTimeout(stall);
        if (await digest(partial) !== artifact.sha256) throw new Error(`MLX download integrity check failed: ${artifact.path}`);
        await rename(partial, destination);
    } finally {
        clearTimeout(stall);
        await rm(partial, { force: true });
    }
}

/**
 * Copy an artifact that an earlier install (or a damaged one being repaired)
 * already verified, so an upgrade does not download the 1.2 GB weights again.
 * APFS clones the file when it can, so the copy costs no extra space.
 */
async function reuseLocalArtifact(artifact: { path: string; sha256: string }, stage: string, parent: string): Promise<void> {
    const destination = join(stage, artifact.path);
    if (existsSync(destination)) return;
    let entries: string[];
    try { entries = await readdir(parent); } catch { return; }
    for (const entry of entries) {
        const candidate = join(parent, entry, artifact.path);
        if (candidate === destination || !existsSync(candidate)) continue;
        try {
            if (await digest(candidate) !== artifact.sha256) continue;
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await copyFile(candidate, destination + '.part', constants.COPYFILE_FICLONE);
            if (await digest(destination + '.part') !== artifact.sha256) { await rm(destination + '.part', { force: true }); continue; }
            await rename(destination + '.part', destination);
            return;
        } catch { await rm(destination + '.part', { force: true }); }
    }
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
            await reuseLocalArtifact(artifact, stage, parent);
            await downloadMlxArtifact(artifact, stage);
        }
        // Only the pinned, SHA-256-verified archive is extracted, using macOS's built-in tar.
        await rm(join(stage, 'python'), { recursive: true, force: true });
        await exec('/usr/bin/tar', ['-xzf', join(stage, 'python.tar.gz'), '-C', stage], { timeout: 120_000 });
        const python = join(stage, 'python/bin/python3');
        const wheels = MLX_ARTIFACTS.filter(a => a.path.startsWith('wheels/')).map(a => join(stage, a.path));
        options.onProgress?.('Installing verified offline Python wheels');
        await exec(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-deps', '--no-compile', '--disable-pip-version-check', ...wheels], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
        await writeFile(join(stage, 'worker.py'), MLX_WORKER, { mode: 0o600 });
        await writeFile(join(stage, 'runtime.sha256'), await runtimeDigest(stage), { mode: 0o600 });
        await verifyMlxFiles(stage);
        options.onProgress?.('Smoke-testing local MLX embeddings');
        const smokeImage = join(stage, 'smoke.png');
        await writeFile(smokeImage, Buffer.from(SMOKE_PNG, 'base64'), { mode: 0o600 });
        const worker = new MlxProcess(python, mlxWorkerArgs(stage));
        try {
            await worker.request([{ text: 'Gemdex local embedding installation check' }, { path: smokeImage, mimeType: 'image/png' }], 'document');
        } finally { worker.close(); await rm(smokeImage, { force: true }); }
        for (const artifact of MLX_ARTIFACTS) {
            if (isInstallOnly(artifact.path)) await rm(join(stage, artifact.path), { force: true });
        }
        await rm(join(stage, 'wheels'), { recursive: true, force: true });
        // Commit only after inference passes; failed repair never advertises a new install.
        await writeFile(join(stage, 'installed'), MLX_INSTALL_ID, { mode: 0o600 });
        await rm(root, { recursive: true, force: true });
        await rename(stage, root);
        options.onProgress?.('MLX model installed and verified');
    } finally { await unlock(); }
}
