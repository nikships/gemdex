import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

/** One in-flight request; no unbounded queue, stdout or stderr accumulation. */
export class MlxProcess {
    private child?: ChildProcessWithoutNullStreams;
    private pending?: { id: number; count: number; resolve: (vectors: number[][]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
    private sequence = 0;
    private output = '';
    private idle?: NodeJS.Timeout;
    private readonly onExit = () => this.close();

    constructor(private command: string, private args: string[], private timeoutMs = 120_000) {}

    request(texts: string[]): Promise<number[][]> {
        if (this.pending) return Promise.reject(new Error('MLX worker is busy; await the previous embedding request'));
        if (texts.length < 1 || texts.length > 16) return Promise.reject(new Error('MLX batch must contain 1–16 texts'));
        const id = ++this.sequence;
        const frame = JSON.stringify({ id, texts }) + '\n';
        if (Buffer.byteLength(frame) > 1024 * 1024) return Promise.reject(new Error('MLX request exceeds 1 MiB'));
        clearTimeout(this.idle);
        if (!this.child) {
            const child = spawn(this.command, this.args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
            });
            this.child = child;
            process.once('exit', this.onExit);
            child.stderr.on('data', () => { /* drain; do not leak input or flood host logs */ });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                if (this.child !== child) return;
                this.output += chunk;
                if (Buffer.byteLength(this.output) > 1024 * 1024) return this.fail(new Error('MLX worker response exceeds 1 MiB'));
                const end = this.output.indexOf('\n');
                if (end === -1) return;
                const line = this.output.slice(0, end);
                this.output = this.output.slice(end + 1);
                try {
                    const response = JSON.parse(line);
                    const pending = this.pending;
                    if (!pending || response.id !== pending.id || this.output.length) throw new Error('Invalid MLX worker response id/framing');
                    if (typeof response.error === 'string') throw new Error(`MLX embedding failed: ${response.error.slice(0, 500)}`);
                    if (!Array.isArray(response.vectors) || response.vectors.length !== pending.count ||
                        !response.vectors.every((v: unknown) => Array.isArray(v) && v.length === 1024 && v.every(x => typeof x === 'number' && Number.isFinite(x)) && Math.abs(Math.hypot(...v) - 1) < 0.01)) {
                        throw new Error('Invalid MLX worker vectors (expected normalized 1024-dimensional vectors)');
                    }
                    clearTimeout(pending.timer);
                    this.pending = undefined;
                    pending.resolve(response.vectors);
                    this.idle = setTimeout(() => this.close(), 60_000);
                    this.idle.unref();
                    this.setReferenced(false);
                } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
            });
            child.on('error', error => { if (this.child === child) this.fail(error); });
            child.stdin.on('error', error => { if (this.child === child) this.fail(error); });
            child.on('exit', code => { if (this.child === child) this.fail(new Error(`MLX worker exited (${code}); rerun the explicit model install to verify the runtime`)); });
        }
        this.setReferenced(true);
        return new Promise((resolve, reject) => {
            this.pending = { id, count: texts.length, resolve, reject, timer: setTimeout(() => this.fail(new Error('MLX worker timed out')), this.timeoutMs) };
            this.child!.stdin.write(frame);
        });
    }

    private setReferenced(referenced: boolean): void {
        // Idle pipes must not keep a one-shot CLI alive. The process exit hook
        // still kills the child; a long-lived server reuses it until idle expiry.
        const method = referenced ? 'ref' : 'unref';
        this.child?.[method]();
        for (const stream of this.child?.stdio ?? []) {
            const pipe = stream as { ref?: () => void; unref?: () => void } | null;
            pipe?.[method]?.();
        }
    }

    private fail(error: Error): void {
        const pending = this.pending;
        this.pending = undefined;
        if (pending) { clearTimeout(pending.timer); pending.reject(error); }
        this.close();
    }

    close(): void {
        clearTimeout(this.idle);
        process.removeListener('exit', this.onExit);
        const child = this.child;
        this.child = undefined;
        this.output = '';
        if (child) { child.stdin.destroy(); child.kill('SIGKILL'); }
        if (this.pending) this.fail(new Error('MLX worker closed'));
    }
}
