import * as http from "http";
import * as crypto from "crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    checkClaudeCode,
    ClaudeCodeReadiness,
    DEFAULT_CLAUDE_MODEL,
    HygieneManager,
    HygieneReport,
    INFERENCE_MODELS,
    INFERENCE_PRICING_AS_OF,
    IngestManager,
    IngestSourceFolder,
    LocalMemoryBackend,
    MemoryBackend,
    MemoryStore,
    antigravityPresetFolder,
    buildCorsHeaders,
    claudePresetFolder,
    codexPresetFolder,
    discoverSessionFiles,
    factoryPresetFolder,
    getMlxStatus,
    handleMemoryApiRequest,
    readBody,
    sendJson,
} from "gemdex-core";
import { ClientConfigStore } from "./cli-config.js";
import { createConfig, GemdexConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createMemoryBackend, INSTALL_HINT } from "./memory.js";
import { installLocalModel, localModelStatus, localModelStatusWithLegacy, LocalModelStatus, migrateLegacyMemories } from './local-model.js';

/** Read a string field from a parsed JSON body, trimmed; '' when absent or non-string. */
function trimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export type ClaudeCodeState = Omit<ClaudeCodeReadiness, 'status' | 'checkedAt'> & {
    status: ClaudeCodeReadiness['status'] | 'checking';
    checkedAt?: number;
};

/**
 * Mutable server context. The sidecar boots even before the local model is
 * installed (the desktop app offers the explicit install), so `store` may be
 * null; memory routes answer 503 until it exists.
 */
export interface ServeContext {
    config: GemdexConfig;
    store: MemoryBackend | null;
    clientConfigStore?: ClientConfigStore;
    createBackend?: (config: GemdexConfig) => MemoryBackend;
    /** True when the local embedding model is installed. Injectable for tests. */
    isModelInstalled?: () => boolean;
    /**
     * When set, the server enforces two security controls:
     *  1. `Origin` header on every non-OPTIONS request must match this value
     *     (or be absent — a same-origin WebView request has no Origin header).
     *  2. Every data route (all routes except /health, /config*, and
     *     OPTIONS pre-flight) must carry `X-Gemdex-Token: <token>`.
     *
     * Both values are minted per-launch by `runServe` and handed to the app
     * through the stdout handshake. External pages cannot obtain them through
     * normal browser APIs, so cross-origin requests are blocked even without
     * relying on the browser's CORS enforcement.
     */
    allowedOrigin?: string;
    token?: string;
    /** Lazily created chat-history ingestion orchestrator. */
    ingestManager?: IngestManager;
    /** Lazily created memory-hygiene orchestrator. */
    hygieneManager?: HygieneManager;
    /** Latest Claude Code probe (ingestion + hygiene readiness). */
    claudeCode?: ClaudeCodeState;
    /** In-flight Claude Code probe. */
    claudeCheck?: Promise<void>;
    /** Injectable probe for tests. */
    checkClaudeCode?: () => Promise<ClaudeCodeReadiness>;
    localModelJob?: LocalModelStatus;
}

function modelInstalled(ctx: ServeContext): boolean {
    return (ctx.isModelInstalled ?? (() => getMlxStatus(clientConfigStore(ctx).rootDir).installed))();
}

function buildStore(ctx: ServeContext): MemoryBackend | null {
    if (!modelInstalled(ctx)) return null;
    return (ctx.createBackend ?? ((config) => createMemoryBackend(config, clientConfigStore(ctx).rootDir)))(ctx.config);
}

function clientConfigStore(ctx: ServeContext): ClientConfigStore {
    ctx.clientConfigStore ??= new ClientConfigStore();
    return ctx.clientConfigStore;
}

function startClaudeCheck(ctx: ServeContext): Promise<void> {
    if (ctx.claudeCheck) return ctx.claudeCheck;
    ctx.claudeCode = { ...(ctx.claudeCode ?? {}), status: 'checking' };
    const probe = (ctx.checkClaudeCode ?? (() => checkClaudeCode()))();
    const check = probe
        .then((readiness) => { ctx.claudeCode = readiness; })
        .catch((error: unknown) => {
            ctx.claudeCode = { status: 'error', message: errorMessage(error), checkedAt: Date.now() };
        })
        .finally(() => {
            if (ctx.claudeCheck === check) ctx.claudeCheck = undefined;
        });
    ctx.claudeCheck = check;
    return check;
}

function claudeState(ctx: ServeContext): ClaudeCodeState {
    return ctx.claudeCode ?? { status: 'checking' };
}

function claudeReady(ctx: ServeContext): boolean {
    return claudeState(ctx).status === 'ready';
}

function requireClaudeReady(ctx: ServeContext, feature: string): void {
    const state = claudeState(ctx);
    if (state.status === 'ready') return;
    if (state.status === 'checking') {
        throw new Error(`${feature} is waiting for the Claude Code check to finish. Try again in a moment.`);
    }
    throw new Error(`${feature} needs Claude Code. ${state.message ?? `Claude Code status: ${state.status}.`}`);
}

function embeddingStatus(ctx: ServeContext): LocalModelStatus {
    return ctx.localModelJob ?? localModelStatus(clientConfigStore(ctx));
}

interface DesktopConfigSummary {
    configured: boolean;
    embedding: LocalModelStatus;
    claudeCode: ClaudeCodeState;
}

function configSummary(ctx: ServeContext): DesktopConfigSummary {
    return {
        configured: ctx.store !== null,
        embedding: embeddingStatus(ctx),
        claudeCode: claudeState(ctx),
    };
}

function ingestManager(ctx: ServeContext): IngestManager {
    ctx.ingestManager ??= new IngestManager();
    return ctx.ingestManager;
}

function hygieneManager(ctx: ServeContext): HygieneManager {
    ctx.hygieneManager ??= new HygieneManager();
    return ctx.hygieneManager;
}

function localStore(ctx: ServeContext): MemoryStore {
    if (!(ctx.store instanceof LocalMemoryBackend)) {
        throw new Error('Memory hygiene needs the local memory store.');
    }
    return ctx.store.getStore();
}

function inferenceModels(): unknown[] {
    return Object.entries(INFERENCE_MODELS).map(([model, info]) => ({
        model,
        description: info.description,
        inputUsdPerMTok: info.inputUsdPerMTok,
        outputUsdPerMTok: info.outputUsdPerMTok,
        isDefault: model === DEFAULT_CLAUDE_MODEL,
    }));
}

function hygieneReportSummary(ctx: ServeContext): { report: HygieneReport | null; models: unknown[]; pricingAsOf: string; hygieneReady: boolean } {
    return {
        report: hygieneManager(ctx).getReport(),
        models: inferenceModels(),
        pricingAsOf: INFERENCE_PRICING_AS_OF,
        hygieneReady: claudeReady(ctx),
    };
}

/** Validate a JSON body field as a non-empty array of non-empty strings. */
function stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length === 0
        || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        throw new Error(`'${field}' must be a non-empty array of strings.`);
    }
    return value;
}

/**
 * Resolve the request's `sources` array into scan folders. Presets resolve to
 * their well-known dot-folders; custom entries must carry an absolute path.
 */
function resolveIngestFolders(ctx: ServeContext, sources: unknown): IngestSourceFolder[] {
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error("'sources' must be a non-empty array.");
    }
    const folders: IngestSourceFolder[] = [];
    for (const entry of sources) {
        const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const source = record.source;
        if (source === 'claude') {
            folders.push(claudePresetFolder());
        } else if (source === 'factory') {
            folders.push(factoryPresetFolder());
        } else if (source === 'codex') {
            folders.push(codexPresetFolder());
        } else if (source === 'antigravity') {
            folders.push(antigravityPresetFolder());
        } else if (source === 'custom') {
            const folderPath = trimmedString(record.path);
            if (!folderPath || !path.isAbsolute(folderPath)) {
                throw new Error("Custom sources require an absolute 'path'.");
            }
            folders.push({ source: 'custom', path: folderPath });
        } else {
            throw new Error("Each source must be 'claude', 'factory', 'codex', 'antigravity', or 'custom'.");
        }
    }
    return folders;
}

function folderSummary(folder: IngestSourceFolder): { source: string; path: string; exists: boolean; sessionCount: number } {
    const exists = fs.existsSync(folder.path);
    return {
        source: folder.source,
        path: folder.path,
        exists,
        sessionCount: exists ? discoverSessionFiles([folder]).length : 0,
    };
}

function ingestSourcesSummary(ctx: ServeContext): unknown {
    const configStore = clientConfigStore(ctx);
    return {
        presets: [claudePresetFolder(), factoryPresetFolder(), codexPresetFolder(), antigravityPresetFolder()]
            .map(folderSummary),
        customFolders: configStore.listIngestFolders()
            .map((folderPath) => folderSummary({ source: 'custom', path: folderPath })),
        models: inferenceModels(),
        pricingAsOf: INFERENCE_PRICING_AS_OF,
        ingestReady: claudeReady(ctx),
        claudeCode: claudeState(ctx),
    };
}

/**
 * `gemdex serve` — the localhost HTTP/JSON sidecar that backs the desktop
 * manager app. It wraps the same gemdex-core MemoryBackend + LanceDB store the
 * MCP server uses, binds 127.0.0.1 only, and exposes the management surface.
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
    if (!ctx.claudeCode) void startClaudeCheck(ctx);
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
            // it has a token to send.
            if (method === 'GET' && pathname === '/health') {
                sendJson(res, 200, { ok: true }, corsHeaders);
                return;
            }

            // A model installed by the CLI while the sidecar runs mounts the
            // store on the next request, without a sidecar restart.
            const jobRunning = ctx.localModelJob?.status === 'installing' || ctx.localModelJob?.status === 'migrating';
            if (ctx.store === null && !jobRunning && modelInstalled(ctx)) {
                ctx.store = buildStore(ctx);
                ctx.localModelJob = undefined;
            }

            // Configuration status is readable without the token so the app can
            // show setup state before data-route authentication is established.
            if (method === 'GET' && pathname === '/config') {
                sendJson(res, 200, configSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/config/check') {
                await startClaudeCheck(ctx);
                sendJson(res, 200, configSummary(ctx), corsHeaders);
                return;
            }

            // All remaining routes require a valid token when the server was
            // started with one. This prevents any page the user visits from
            // reading or mutating their memory layer via cross-origin requests.
            if (!isTokenValid(req, ctx.token)) {
                sendJson(res, 401, { error: 'Unauthorized' }, corsHeaders);
                return;
            }

            if (pathname === '/settings/embedding' && method === 'GET') {
                sendJson(res, 200, ctx.localModelJob ?? await localModelStatusWithLegacy(clientConfigStore(ctx)), corsHeaders);
                return;
            }
            if (pathname.startsWith('/settings/embedding/') && method === 'POST') {
                if (ctx.localModelJob?.status === 'installing' || ctx.localModelJob?.status === 'migrating') {
                    sendJson(res, 409, { error: 'A local model operation is already running.' }, corsHeaders);
                    return;
                }
                const installing = pathname === '/settings/embedding/install';
                if (!installing && pathname !== '/settings/embedding/migrate') {
                    sendJson(res, 404, { error: 'Unknown local model action.' }, corsHeaders);
                    return;
                }
                const configStore = clientConfigStore(ctx);
                if (!installing && !modelInstalled(ctx)) {
                    sendJson(res, 400, { error: INSTALL_HINT }, corsHeaders);
                    return;
                }
                ctx.localModelJob = { ...localModelStatus(configStore), status: installing ? 'installing' : 'migrating' };
                const job = ctx.localModelJob;
                const operation = installing
                    ? installLocalModel(configStore, (message) => { job.message = message; })
                    : migrateLegacyMemories(configStore, (completed, total) => { job.completed = completed; job.total = total; });
                void operation.then(async () => {
                    ctx.store = buildStore(ctx);
                    ctx.localModelJob = {
                        ...await localModelStatusWithLegacy(configStore),
                        message: installing ? 'Installed.' : 'Migration complete.',
                    };
                }).catch(async (error: unknown) => {
                    const message = errorMessage(error);
                    // Re-read status so a failed migration still reports
                    // legacyMemories; the app hides its Migrate retry without it.
                    const latest = await localModelStatusWithLegacy(configStore).catch(() => job);
                    ctx.localModelJob = { ...job, ...latest, status: 'error', message };
                });
                sendJson(res, 202, job, corsHeaders);
                return;
            }

            if (ctx.store === null) {
                sendJson(res, 503, { error: INSTALL_HINT, needsInstall: true }, corsHeaders);
                return;
            }

            if (method === 'GET' && pathname === '/ingest/sources') {
                sendJson(res, 200, ingestSourcesSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/ingest/folders') {
                const body = await readBody(req);
                const folderPath = trimmedString(body?.path);
                try {
                    if (!folderPath) throw new Error("'path' is required");
                    clientConfigStore(ctx).addIngestFolder(folderPath);
                    sendJson(res, 200, ingestSourcesSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'DELETE' && pathname === '/ingest/folders') {
                const body = await readBody(req);
                const folderPath = trimmedString(body?.path);
                if (!folderPath) {
                    sendJson(res, 400, { error: "'path' is required" }, corsHeaders);
                    return;
                }
                clientConfigStore(ctx).removeIngestFolder(folderPath);
                sendJson(res, 200, ingestSourcesSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/ingest/scan') {
                const body = await readBody(req);
                try {
                    const folders = resolveIngestFolders(ctx, body?.sources);
                    sendJson(res, 200, ingestManager(ctx).scan(folders), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/ingest/start') {
                const body = await readBody(req);
                try {
                    const folders = resolveIngestFolders(ctx, body?.sources);
                    const model = trimmedString(body?.model) || undefined;
                    const manager = ingestManager(ctx);
                    requireClaudeReady(ctx, 'Chat-history ingestion');
                    if (manager.isRunning()) {
                        sendJson(res, 409, { error: 'An ingestion run is already in progress.' }, corsHeaders);
                        return;
                    }
                    const store = ctx.store;
                    // Fire and forget: the run is polled via GET /ingest/status.
                    // Errors are captured in the manager's progress state.
                    void manager.run({ folders, model }, store).catch(() => undefined);
                    sendJson(res, 200, { started: true }, corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'GET' && pathname === '/ingest/status') {
                sendJson(res, 200, ingestManager(ctx).getProgress(), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/ingest/cancel') {
                const manager = ingestManager(ctx);
                if (manager.isRunning()) {
                    manager.cancel();
                    sendJson(res, 200, { cancelled: 'run' }, corsHeaders);
                    return;
                }
                sendJson(res, 200, { cancelled: 'none' }, corsHeaders);
                return;
            }

            if (method === 'GET' && pathname === '/hygiene/report') {
                sendJson(res, 200, hygieneReportSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/scan') {
                const body = await readBody(req);
                try {
                    const threshold = typeof body?.threshold === 'number' ? body.threshold : undefined;
                    sendJson(res, 200, await hygieneManager(ctx).scan(localStore(ctx), threshold), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/start') {
                const body = await readBody(req);
                try {
                    const model = trimmedString(body?.model) || undefined;
                    const threshold = typeof body?.threshold === 'number' ? body.threshold : undefined;
                    const manager = hygieneManager(ctx);
                    const store = localStore(ctx);
                    requireClaudeReady(ctx, 'Memory hygiene');
                    if (manager.isRunning()) {
                        sendJson(res, 409, { error: 'A hygiene run is already in progress.' }, corsHeaders);
                        return;
                    }
                    // Fire and forget: the run is polled via GET /hygiene/status.
                    // Errors are captured in the manager's progress state.
                    void manager.run({ model, threshold }, store).catch(() => undefined);
                    sendJson(res, 200, { started: true }, corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'GET' && pathname === '/hygiene/status') {
                sendJson(res, 200, hygieneManager(ctx).getProgress(), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/cancel') {
                try {
                    const manager = hygieneManager(ctx);
                    if (manager.isRunning()) {
                        manager.cancel();
                        sendJson(res, 200, { cancelled: true }, corsHeaders);
                    } else {
                        sendJson(res, 200, { cancelled: false }, corsHeaders);
                    }
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/apply') {
                const body = await readBody(req);
                try {
                    const ids = stringArray(body?.ids, 'ids');
                    sendJson(res, 200, await hygieneManager(ctx).apply(ids, ctx.store), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/hygiene/dismiss') {
                const body = await readBody(req);
                try {
                    const clusterIds = stringArray(body?.clusterIds, 'clusterIds');
                    hygieneManager(ctx).dismiss(clusterIds);
                    sendJson(res, 200, { dismissed: clusterIds.length }, corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            const handled = await handleMemoryApiRequest(req, res, {
                store: ctx.store,
                corsHeaders,
            });
            if (!handled) {
                sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
            }
        } catch (error: any) {
            const message = error?.message ?? 'Internal error';
            if (message === 'Request body too large') {
                sendJson(res, 413, { error: message }, corsHeaders);
                return;
            }
            if (message === 'Invalid JSON body') {
                sendJson(res, 400, { error: message }, corsHeaders);
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

    // Mint a per-launch token. 32 random bytes → 64 hex characters, handed to
    // the app via the `PORT=N TOKEN=<hex>` handshake line.
    const token = crypto.randomBytes(32).toString('hex');

    // Browsers always send Origin on cross-origin requests; the native app
    // sends none. GEMDEX_WEBVIEW_ORIGIN allows one embedded web origin.
    const allowedOrigin = process.env.GEMDEX_WEBVIEW_ORIGIN ?? 'zero://app';

    const ctx: ServeContext = {
        config,
        store: null,
        token,
        allowedOrigin,
        clientConfigStore: new ClientConfigStore(),
    };
    ctx.store = buildStore(ctx);
    void startClaudeCheck(ctx);
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
