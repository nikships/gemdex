import * as http from "http";
import * as crypto from "crypto";
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
    /**
     * When set, the server enforces two security controls:
     *  1. `Origin` header on every non-OPTIONS request must match this value
     *     (or be absent — a same-origin WebView request has no Origin header).
     *  2. Every data route (all routes except /health, /config GET/POST, and
     *     OPTIONS pre-flight) must carry `X-Gemdex-Token: <token>`.
     *
     * Both values are minted per-launch by `runServe` and handed to the
     * WebView via the Zig shell's `gemdex.getApiBase` bridge command. The
     * desktop app embeds them in every fetch call; external pages cannot
     * obtain them through normal browser APIs, so cross-origin requests are
     * effectively blocked even without relying on the browser's CORS
     * enforcement (which is the attacker-controlled layer).
     */
    allowedOrigin?: string;
    token?: string;
}

function buildStore(config: GemdexConfig): MemoryStore | null {
    if (!config.geminiApiKey) return null;
    return createMemoryStore(config);
}

/** Persist the key to ~/.gemdex/.env, expose it to this process, and (re)build the store. */
function configureApiKey(ctx: ServeContext, apiKey: string): void {
    envManager.set('GEMINI_API_KEY', apiKey);
    process.env['GEMINI_API_KEY'] = apiKey;
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

/**
 * Build CORS response headers for a given request context. When an
 * `allowedOrigin` is configured the `Access-Control-Allow-Origin` header is
 * set to that specific origin only; otherwise we fall back to the wildcard so
 * the server still works when run stand-alone (e.g. in tests that don't pass a
 * token/origin, or when invoked directly from the CLI without the desktop app).
 */
function buildCorsHeaders(allowedOrigin: string | undefined): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': allowedOrigin ?? '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Gemdex-Token',
        // Do not reflect credentials — the token header is the auth mechanism.
        'Access-Control-Allow-Credentials': 'false',
    };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, corsHeaders: Record<string, string>): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...corsHeaders,
    });
    res.end(payload);
}

/** Stream raw attachment bytes back to the WebView with their real content type. */
function sendBytes(res: http.ServerResponse, status: number, buf: Buffer, contentType: string, corsHeaders: Record<string, string>): void {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': buf.length,
        ...corsHeaders,
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

/**
 * Check whether the request's `Origin` header is acceptable.
 *
 * - If no `allowedOrigin` is configured (standalone / test mode) all origins
 *   pass so existing behaviour is preserved.
 * - If an `allowedOrigin` is configured, requests whose `Origin` header is
 *   present and does not match are rejected. Requests with *no* `Origin`
 *   header (same-origin WebView loads, CLI tools, curl) are allowed through
 *   — a browser will always set `Origin` on a cross-origin request, so the
 *   absence of the header is a reliable signal that the request is *not*
 *   coming from a foreign web page.
 */
function isOriginAllowed(req: http.IncomingMessage, allowedOrigin: string | undefined): boolean {
    if (!allowedOrigin) return true;
    const origin = req.headers['origin'];
    if (!origin) return true; // absent = same-origin or non-browser caller
    return origin === allowedOrigin;
}

/**
 * Check whether the request carries the correct app token.
 *
 * - If no token is configured all requests pass (standalone / test mode).
 * - The token must appear in the `X-Gemdex-Token` request header.
 * - The comparison is timing-safe to prevent timing oracle attacks.
 */
function isTokenValid(req: http.IncomingMessage, token: string | undefined): boolean {
    if (!token) return true;
    const provided = req.headers['x-gemdex-token'];
    if (typeof provided !== 'string' || provided.length === 0) return false;
    // Constant-time comparison to resist timing attacks.
    try {
        return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
    } catch {
        // Buffers of different lengths — timingSafeEqual would throw.
        return false;
    }
}

export function createServer(ctx: ServeContext): http.Server {
    return http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const corsHeaders = buildCorsHeaders(ctx.allowedOrigin);

        // Reject requests from unexpected origins before doing any work.
        if (!isOriginAllowed(req, ctx.allowedOrigin)) {
            sendJson(res, 403, { error: 'Forbidden' }, corsHeaders);
            return;
        }

        // Handle pre-flight. No token check — the browser sends OPTIONS before
        // it has a chance to include custom headers.
        if (method === 'OPTIONS') {
            sendJson(res, 204, {}, corsHeaders);
            return;
        }

        try {
            // GET /health — unauthenticated; the desktop app polls this before
            // it has a token to send (the token arrives via the bridge after
            // health resolves).
            if (method === 'GET' && pathname === '/health') {
                sendJson(res, 200, { ok: true }, corsHeaders);
                return;
            }

            // GET /config and POST /config are intentionally excluded from the
            // token requirement: the desktop app must be able to submit an API
            // key before authentication is established. These routes do not
            // expose sensitive memory data.
            if (method === 'GET' && pathname === '/config') {
                sendJson(res, 200, { configured: ctx.store !== null }, corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/config') {
                const body = await readBody(req);
                const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
                if (apiKey.length === 0) {
                    sendJson(res, 400, { error: "'apiKey' is required" }, corsHeaders);
                    return;
                }
                try {
                    configureApiKey(ctx, apiKey);
                    sendJson(res, 200, { configured: ctx.store !== null }, corsHeaders);
                } catch (error: any) {
                    sendJson(res, 500, { error: error?.message ?? 'Failed to configure API key' }, corsHeaders);
                }
                return;
            }

            // All remaining routes require a valid token when the server was
            // started with one. This prevents any page the user visits from
            // reading or mutating their memory layer via cross-origin requests.
            if (!isTokenValid(req, ctx.token)) {
                sendJson(res, 401, { error: 'Unauthorized' }, corsHeaders);
                return;
            }

            // Every remaining route needs an embedding-backed store. Until a
            // key is configured, tell the app to prompt for one.
            if (ctx.store === null) {
                sendJson(res, 503, { error: 'GEMINI_API_KEY not configured', needsKey: true }, corsHeaders);
                return;
            }
            const store = ctx.store;

            // GET /memories — list summaries (sorted by updatedAt desc)
            if (method === 'GET' && pathname === '/memories') {
                const memories = await store.list();
                sendJson(res, 200, { memories }, corsHeaders);
                return;
            }

            // POST /memories — create (text and/or inline media attachments)
            if (method === 'POST' && pathname === '/memories') {
                const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                    sendJson(res, 400, { error: "'attachments' must be an array" }, corsHeaders);
                    return;
                }
                const content = typeof body?.content === 'string' ? body.content : '';
                const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
                const hasAttachments = (attachments?.length ?? 0) > 0;
                if (content.trim().length === 0 && !hasAttachments) {
                    sendJson(res, 400, { error: "'content' or at least one attachment is required" }, corsHeaders);
                    return;
                }
                try {
                    const memory = await store.save({ content, title: body.title, ...(attachments && { attachments }) });
                    sendJson(res, 201, { memory }, corsHeaders);
                } catch (error: any) {
                    sendJson(res, 400, { error: error?.message ?? 'Failed to save memory' }, corsHeaders);
                }
                return;
            }

            // GET /export — dump all memories as JSONL records
            if (method === 'GET' && pathname === '/export') {
                const records = await store.exportAll();
                sendJson(res, 200, { records }, corsHeaders);
                return;
            }

            // POST /import — restore/merge (upsert by id)
            if (method === 'POST' && pathname === '/import') {
                const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                const records = Array.isArray(body?.records) ? body.records : [];
                const result = await store.importRecords(records);
                sendJson(res, 200, result, corsHeaders);
                return;
            }

            // POST /recall — relevance search by text and/or inline media.
            // Powers the app's "find similar" (recall-by-example); there is no
            // free-text search box, so query is usually omitted in favor of an
            // attachment lifted from an existing memory.
            if (method === 'POST' && pathname === '/recall') {
                const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                    sendJson(res, 400, { error: "'attachments' must be an array" }, corsHeaders);
                    return;
                }
                const query = typeof body?.query === 'string' ? body.query : '';
                const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;
                const limit = typeof body?.limit === 'number' && body.limit > 0 ? Math.min(body.limit, 50) : 10;
                const hasAttachments = (attachments?.length ?? 0) > 0;
                if (query.trim().length === 0 && !hasAttachments) {
                    sendJson(res, 400, { error: "'query' or at least one attachment is required" }, corsHeaders);
                    return;
                }
                try {
                    const results = await store.recall(query, limit, hasAttachments ? attachments : undefined);
                    sendJson(res, 200, { results }, corsHeaders);
                } catch (error: any) {
                    sendJson(res, 400, { error: error?.message ?? 'Recall failed' }, corsHeaders);
                }
                return;
            }

            // GET /memories/:id/attachments/:attachmentId — raw attachment bytes.
            // Matched BEFORE the greedy /memories/:id detail route below.
            const attachmentMatch = pathname.match(/^\/memories\/([^/]+)\/attachments\/([^/]+)$/);
            if (attachmentMatch) {
                if (method !== 'GET') {
                    sendJson(res, 405, { error: `Method ${method} not allowed on attachment` }, corsHeaders);
                    return;
                }
                const memoryId = decodeURIComponent(attachmentMatch[1]);
                const attachmentId = decodeURIComponent(attachmentMatch[2]);
                const blob = await store.readAttachment(memoryId, attachmentId);
                if (!blob) {
                    sendJson(res, 404, { error: 'Attachment not found' }, corsHeaders);
                    return;
                }
                sendBytes(res, 200, blob.data, blob.mimeType, corsHeaders);
                return;
            }

            // PATCH /memories/:id/attachments — caption-only edit (no re-embed).
            // Matched BEFORE the greedy /memories/:id detail route below.
            const captionsMatch = pathname.match(/^\/memories\/([^/]+)\/attachments$/);
            if (captionsMatch) {
                if (method !== 'PATCH') {
                    sendJson(res, 405, { error: `Method ${method} not allowed on attachments` }, corsHeaders);
                    return;
                }
                const id = decodeURIComponent(captionsMatch[1]);
                const body = await readBody(req);
                if (!Array.isArray(body?.captions)) {
                    sendJson(res, 400, { error: "'captions' must be an array" }, corsHeaders);
                    return;
                }
                const captions: { id: string; caption?: string }[] = [];
                for (const item of body.captions) {
                    if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
                        sendJson(res, 400, { error: "each caption requires a string 'id'" }, corsHeaders);
                        return;
                    }
                    if (item.caption !== undefined && typeof item.caption !== 'string') {
                        sendJson(res, 400, { error: "'caption' must be a string when provided" }, corsHeaders);
                        return;
                    }
                    captions.push({ id: item.id, ...(item.caption !== undefined && { caption: item.caption }) });
                }
                try {
                    const memory = await store.updateAttachmentCaptions(id, captions);
                    sendJson(res, 200, { memory }, corsHeaders);
                } catch (error: any) {
                    const msg = error?.message ?? 'Caption update failed';
                    sendJson(res, /not found/i.test(msg) ? 404 : 400, { error: msg }, corsHeaders);
                }
                return;
            }

            // /memories/:id routes
            const detailMatch = pathname.match(/^\/memories\/(.+)$/);
            if (detailMatch) {
                const id = decodeURIComponent(detailMatch[1]);

                if (method === 'GET') {
                    const memory = await store.get(id);
                    if (!memory) {
                        sendJson(res, 404, { error: 'Memory not found' }, corsHeaders);
                        return;
                    }
                    sendJson(res, 200, { memory }, corsHeaders);
                    return;
                }

                if (method === 'PUT') {
                    const body = await readBody(req, ATTACHMENT_BODY_LIMIT);
                    if (body?.attachments !== undefined && !Array.isArray(body.attachments)) {
                        sendJson(res, 400, { error: "'attachments' must be an array" }, corsHeaders);
                        return;
                    }
                    const hasContent = typeof body?.content === 'string';
                    const hasTitle = typeof body?.title === 'string';
                    const hasAttachments = body?.attachments !== undefined;
                    if (!hasContent && !hasTitle && !hasAttachments) {
                        sendJson(res, 400, { error: "provide at least one of 'content', 'title', or 'attachments'" }, corsHeaders);
                        return;
                    }
                    const input: { content?: string; title?: string; attachments?: any[] } = {};
                    if (hasContent) input.content = body.content;
                    if (hasTitle) input.title = body.title;
                    if (hasAttachments) input.attachments = body.attachments;
                    try {
                        const memory = await store.update(id, input);
                        sendJson(res, 200, { memory }, corsHeaders);
                    } catch (error: any) {
                        const msg = error?.message ?? 'Update failed';
                        sendJson(res, /not found/i.test(msg) ? 404 : 400, { error: msg }, corsHeaders);
                    }
                    return;
                }

                if (method === 'DELETE') {
                    await store.delete(id);
                    sendJson(res, 200, { ok: true }, corsHeaders);
                    return;
                }
            }

            sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
        } catch (error: any) {
            const message = error?.message ?? 'Internal error';
            // readBody rejects with this when the payload exceeds the cap — a
            // client error (oversized attachments), not a server fault.
            if (message === 'Request body too large') {
                sendJson(res, 413, { error: message }, corsHeaders);
                return;
            }
            console.error('[serve] request error:', error);
            sendJson(res, 500, { error: message }, corsHeaders);
        }
    });
}

export async function runServe(args: string[]): Promise<void> {
    const { port } = parseArgs(args);
    const config = createConfig();
    // Boot even without a key; the desktop app will POST one to /config.

    // Mint a per-launch token. 32 random bytes → 64 hex characters. This is
    // handed to the WebView via the `PORT=N TOKEN=<hex>` handshake line and
    // embedded in every fetch call by the frontend. Any other page on the
    // machine cannot obtain the token without reading local process state.
    const token = crypto.randomBytes(32).toString('hex');

    // The allowed origin is the WebView's custom scheme. The zero-native shell
    // loads the frontend from `zero://app` on production and
    // `http://127.0.0.1:5173` in dev. If GEMDEX_WEBVIEW_ORIGIN is set in the
    // environment (injected by the Zig shell in a future build) we honour it;
    // otherwise we accept only `zero://app` as the production origin.
    const allowedOrigin = process.env.GEMDEX_WEBVIEW_ORIGIN ?? 'zero://app';

    const ctx: ServeContext = { config, store: buildStore(config), token, allowedOrigin };
    const server = createServer(ctx);

    await new Promise<void>((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            const boundPort = typeof address === 'object' && address ? address.port : port;
            // The shell reads this line from stdout to discover the port AND
            // the token. Format: `PORT=<n> TOKEN=<hex>` followed by a newline.
            // console.log is redirected to stderr by index.ts, so write the
            // machine-readable handshake line directly to the real stdout.
            process.stdout.write(`PORT=${boundPort} TOKEN=${token}\n`);
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
