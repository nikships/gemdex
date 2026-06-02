import * as http from "http";
import { MemoryStore } from "gemdex-core";
import { createConfig } from "./config.js";
import { createMemoryStore } from "./memory.js";

/**
 * `gemdex serve` — the localhost HTTP/JSON sidecar that backs the desktop
 * manager app. It wraps the same gemdex-core MemoryStore + LanceDB store the
 * MCP server uses, binds 127.0.0.1 only, and exposes the management surface
 * (no semantic search — that is MCP-only).
 *
 * Using localhost HTTP (not the Zig bridge) sidesteps the bridge's 16 KiB
 * request/response cap so a 300-line memory is never truncated.
 */

interface ServeOptions {
    port: number;
}

function parseArgs(args: string[]): ServeOptions {
    let port: number | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--port' || arg === '-p') {
            port = parseInt(args[++i], 10);
        } else if (arg.startsWith('--port=')) {
            port = parseInt(arg.slice('--port='.length), 10);
        }
    }

    if (port === undefined) {
        const fromEnv = process.env.GEMDEX_SERVE_PORT;
        port = fromEnv ? parseInt(fromEnv, 10) : 0; // 0 = OS picks a free port
    }
    if (!Number.isFinite(port) || port < 0) port = 0;

    return { port };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // Single-user local app; allow the WebView origin to call us.
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const MAX = 50 * 1024 * 1024; // 50 MiB ceiling for import payloads
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if (raw.trim().length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

export function createServer(store: MemoryStore): http.Server {
    return http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';

        if (method === 'OPTIONS') {
            sendJson(res, 204, {});
            return;
        }

        try {
            // GET /health
            if (method === 'GET' && pathname === '/health') {
                sendJson(res, 200, { ok: true });
                return;
            }

            // GET /memories — list summaries (sorted by updatedAt desc)
            if (method === 'GET' && pathname === '/memories') {
                const memories = await store.list();
                sendJson(res, 200, { memories });
                return;
            }

            // POST /memories — create
            if (method === 'POST' && pathname === '/memories') {
                const body = await readBody(req);
                if (typeof body?.content !== 'string' || body.content.trim().length === 0) {
                    sendJson(res, 400, { error: "'content' is required" });
                    return;
                }
                const memory = await store.save({ content: body.content, title: body.title });
                sendJson(res, 201, { memory });
                return;
            }

            // GET /export — dump all memories as JSONL records
            if (method === 'GET' && pathname === '/export') {
                const records = await store.exportAll();
                sendJson(res, 200, { records });
                return;
            }

            // POST /import — restore/merge (upsert by id)
            if (method === 'POST' && pathname === '/import') {
                const body = await readBody(req);
                const records = Array.isArray(body?.records) ? body.records : [];
                const result = await store.importRecords(records);
                sendJson(res, 200, result);
                return;
            }

            // /memories/:id routes
            const detailMatch = pathname.match(/^\/memories\/(.+)$/);
            if (detailMatch) {
                const id = decodeURIComponent(detailMatch[1]);

                if (method === 'GET') {
                    const memory = await store.get(id);
                    if (!memory) {
                        sendJson(res, 404, { error: 'Memory not found' });
                        return;
                    }
                    sendJson(res, 200, { memory });
                    return;
                }

                if (method === 'PUT') {
                    const body = await readBody(req);
                    if (typeof body?.content !== 'string' || body.content.trim().length === 0) {
                        sendJson(res, 400, { error: "'content' is required" });
                        return;
                    }
                    try {
                        const memory = await store.update(id, { content: body.content, title: body.title });
                        sendJson(res, 200, { memory });
                    } catch (error: any) {
                        sendJson(res, 404, { error: error?.message ?? 'Update failed' });
                    }
                    return;
                }

                if (method === 'DELETE') {
                    await store.delete(id);
                    sendJson(res, 200, { ok: true });
                    return;
                }
            }

            sendJson(res, 404, { error: `No route for ${method} ${pathname}` });
        } catch (error: any) {
            console.error('[serve] request error:', error);
            sendJson(res, 500, { error: error?.message ?? 'Internal error' });
        }
    });
}

export async function runServe(args: string[]): Promise<void> {
    const { port } = parseArgs(args);
    const config = createConfig();
    const store = createMemoryStore(config);
    const server = createServer(store);

    await new Promise<void>((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            const boundPort = typeof address === 'object' && address ? address.port : port;
            // The shell reads this line from stdout to discover the port.
            // console.log is redirected to stderr by index.ts, so write the
            // machine-readable handshake line directly to the real stdout.
            process.stdout.write(`PORT=${boundPort}\n`);
            console.error(`[serve] Gemdex sidecar listening on http://127.0.0.1:${boundPort}`);
            resolve();
        });
    });

    const shutdown = () => {
        console.error('[serve] shutting down sidecar...');
        server.close(() => process.exit(0));
        // Force-exit if close hangs on keep-alive sockets.
        setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
