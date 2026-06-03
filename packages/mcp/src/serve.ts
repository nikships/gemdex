import * as http from "http";
import { MemoryStore, envManager } from "gemdex-core";
import { createConfig, GemdexConfig } from "./config.js";
import { createMemoryStore } from "./memory.js";

/**
 * Mutable server context. The sidecar boots even when no GEMINI_API_KEY is
 * configured yet (a .app launched from Finder doesn't inherit the user's
 * interactive shell env), so the desktop app can prompt for the key and POST
 * it to /config. Until then `store` is null and the data routes answer 503.
 */
interface ServeContext {
    config: GemdexConfig;
    store: MemoryStore | null;
}

function buildStore(config: GemdexConfig): MemoryStore | null {
    if (!config.geminiApiKey) return null;
    return createMemoryStore(config);
}

/** Persist the key to ~/.gemdex/.env, expose it to this process, and (re)build the store. */
function configureApiKey(ctx: ServeContext, apiKey: string): void {
    envManager.set('GEMINI_API_KEY', apiKey);
    process.env.GEMINI_API_KEY = apiKey;
    ctx.config = createConfig();
    ctx.store = buildStore(ctx.config);
}

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

const CORS_HEADERS = {
    // Single-user local app; allow the WebView origin to call us.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...CORS_HEADERS,
    });
    res.end(payload);
}

/** Stream raw attachment bytes back to the WebView with their real content type. */
function sendBytes(res: http.ServerResponse, status: number, buf: Buffer, contentType: string): void {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': buf.length,
        ...CORS_HEADERS,
    });
    res.end(buf);
}

// Default JSON body ceiling. Routes that accept inline base64 attachments pass
// a larger limit (ATTACHMENT_BODY_LIMIT) since media payloads are much bigger.
const DEFAULT_BODY_LIMIT = 50 * 1024 * 1024; // 50 MiB
const ATTACHMENT_BODY_LIMIT = 100 * 1024 * 1024; // 100 MiB for create/update/import with media

function readBody(req: http.IncomingMessage, maxBytes: number = DEFAULT_BODY_LIMIT): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
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

export function createServer(ctx: ServeContext): http.Server {
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

            // GET /config — is a GEMINI_API_KEY configured yet?
            if (method === 'GET' && pathname === '/config') {
                sendJson(res, 200, { configured: ctx.store !== null });
                return;
            }

            // POST /config — set the GEMINI_API_KEY (persisted to ~/.gemdex/.env)
            if (method === 'POST' && pathname === '/config') {
                const body = await readBody(req);
                const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
                if (apiKey.length === 0) {
                    sendJson(res, 400, { error: "'apiKey' is required" });
                    return;
                }
                try {
                    configureApiKey(ctx, apiKey);
                    sendJson(res, 200, { configured: ctx.store !== null });
                } catch (error: any) {
                    sendJson(res, 500, { error: error?.message ?? 'Failed to configure API key' });
                }
                return;
            }

            // Every remaining route needs an embedding-backed store. Until a
            // key is configured, tell the app to prompt for one.
            if (ctx.store === null) {
                sendJson(res, 503, { error: 'GEMINI_API_KEY not configured', needsKey: true });
                return;
            }
            const store = ctx.store;

            // GET /memories — list summaries (sorted by updatedAt desc)
            if (method === 'GET' && pathname === '/memories') {
                const memories = await store.list();
                sendJson(res, 200, { memories });
                return;
            }

            // POST /memories — create (text and/or inline media attachments)
            if (method === 'POST' && pathname === '/memories') {
                const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                    sendJson(res, 400, { error: "'attachments' must be an array" });
                    return;
                }
                const content = typeof body?.content === 'string' ? body.content : '';
                const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
                const hasAttachments = (attachments?.length ?? 0) > 0;
                if (content.trim().length === 0 && !hasAttachments) {
                    sendJson(res, 400, { error: "'content' or at least one attachment is required" });
                    return;
                }
                try {
                    const memory = await store.save({ content, title: body.title, ...(attachments && { attachments }) });
                    sendJson(res, 201, { memory });
                } catch (error: any) {
                    sendJson(res, 400, { error: error?.message ?? 'Failed to save memory' });
                }
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
                const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                const records = Array.isArray(body?.records) ? body.records : [];
                const result = await store.importRecords(records);
                sendJson(res, 200, result);
                return;
            }

            // POST /recall — relevance search by text and/or inline media.
            // Powers the app's "find similar" (recall-by-example); there is no
            // free-text search box, so query is usually omitted in favor of an
            // attachment lifted from an existing memory.
            if (method === 'POST' && pathname === '/recall') {
                const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                    sendJson(res, 400, { error: "'attachments' must be an array" });
                    return;
                }
                const query = typeof body?.query === 'string' ? body.query : '';
                const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
                const limit = typeof body?.limit === 'number' && body.limit > 0 ? Math.min(body.limit, 50) : 10;
                const hasAttachments = (attachments?.length ?? 0) > 0;
                if (query.trim().length === 0 && !hasAttachments) {
                    sendJson(res, 400, { error: "'query' or at least one attachment is required" });
                    return;
                }
                try {
                    const results = await store.recall(query, limit, hasAttachments ? attachments : undefined);
                    sendJson(res, 200, { results });
                } catch (error: any) {
                    sendJson(res, 400, { error: error?.message ?? 'Recall failed' });
                }
                return;
            }

            // GET /memories/:id/attachments/:attachmentId — raw attachment bytes.
            // Matched BEFORE the greedy /memories/:id detail route below.
            const attachmentMatch = pathname.match(/^\/memories\/([^/]+)\/attachments\/([^/]+)$/);
            if (attachmentMatch) {
                if (method !== 'GET') {
                    sendJson(res, 405, { error: `Method ${method} not allowed on attachment` });
                    return;
                }
                const memoryId = decodeURIComponent(attachmentMatch[1]);
                const attachmentId = decodeURIComponent(attachmentMatch[2]);
                const blob = await store.readAttachment(memoryId, attachmentId);
                if (!blob) {
                    sendJson(res, 404, { error: 'Attachment not found' });
                    return;
                }
                sendBytes(res, 200, blob.data, blob.mimeType);
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
                    const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                    if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                        sendJson(res, 400, { error: "'attachments' must be an array" });
                        return;
                    }
                    const hasContent = typeof body?.content === 'string';
                    const hasTitle = typeof body?.title === 'string';
                    const hasAttachments = body?.attachments !== undefined;
                    if (!hasContent && !hasTitle && !hasAttachments) {
                        sendJson(res, 400, { error: "provide at least one of 'content', 'title', or 'attachments'" });
                        return;
                    }
                    const input: { content?: string; title?: string; attachments?: any[] } = {};
                    if (hasContent) input.content = body.content;
                    if (hasTitle) input.title = body.title;
                    if (hasAttachments) input.attachments = body.attachments;
                    try {
                        const memory = await store.update(id, input);
                        sendJson(res, 200, { memory });
                    } catch (error: any) {
                        const msg = error?.message ?? 'Update failed';
                        sendJson(res, /not found/i.test(msg) ? 404 : 400, { error: msg });
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
            const message = error?.message ?? 'Internal error';
            // readBody rejects with this when the payload exceeds the cap — a
            // client error (oversized attachments), not a server fault.
            if (message === 'Request body too large') {
                sendJson(res, 413, { error: message });
                return;
            }
            console.error('[serve] request error:', error);
            sendJson(res, 500, { error: message });
        }
    });
}

export async function runServe(args: string[]): Promise<void> {
    const { port } = parseArgs(args);
    const config = createConfig();
    // Boot even without a key; the desktop app will POST one to /config.
    const ctx: ServeContext = { config, store: buildStore(config) };
    const server = createServer(ctx);

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
