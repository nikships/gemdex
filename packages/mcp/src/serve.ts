import * as http from "http";
import * as crypto from "crypto";
import { MemoryBackend, RemoteMemoryBackend, envManager } from "gemdex-core";
import { buildCorsHeaders, handleMemoryApiRequest, readBody, sendJson } from "gemdex-core";
import { ClientConfigStore, StoredRemote, tokenEnvVarForRemote } from "./cli-config.js";
import { createConfig, GemdexConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createMemoryBackend } from "./memory.js";

/** Read a string field from a parsed JSON body, trimmed; '' when absent or non-string. */
function trimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Mutable server context. The sidecar boots even when no GEMINI_API_KEY is
 * configured yet (a .app launched from Finder doesn't inherit the user's
 * interactive shell env), so the desktop app can prompt for the key and POST
 * it to /config. Until then `store` is null and the data routes answer 503.
 */
export interface ServeContext {
    config: GemdexConfig;
    store: MemoryBackend | null;
    clientConfigStore?: ClientConfigStore;
    createBackend?: (config: GemdexConfig) => MemoryBackend;
    fetch?: typeof fetch;
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

function buildStore(
    config: GemdexConfig,
    createBackend: (config: GemdexConfig) => MemoryBackend = createMemoryBackend,
): MemoryBackend | null {
    if (config.mode === 'local' && !config.geminiApiKey) return null;
    return createBackend(config);
}

/** Persist the key to ~/.gemdex/.env, expose it to this process, and (re)build the store. */
function configureApiKey(ctx: ServeContext, apiKey: string): void {
    envManager.set('GEMINI_API_KEY', apiKey);
    process.env['GEMINI_API_KEY'] = apiKey;
    ctx.config = {
        ...ctx.config,
        geminiApiKey: apiKey,
    };
    if (ctx.config.mode === 'local') {
        ctx.store = buildStore(ctx.config, ctx.createBackend);
    }
}

interface DesktopRemoteSummary extends StoredRemote {
    name: string;
    hasToken: boolean;
}

interface DesktopSettingsSummary {
    mode: 'local' | 'remote';
    activeRemote?: string;
    configured: boolean;
    localConfigured: boolean;
    remotes: DesktopRemoteSummary[];
}

function clientConfigStore(ctx: ServeContext): ClientConfigStore {
    ctx.clientConfigStore ??= new ClientConfigStore();
    return ctx.clientConfigStore;
}

function createBackend(ctx: ServeContext, config: GemdexConfig): MemoryBackend {
    return (ctx.createBackend ?? createMemoryBackend)(config);
}

function localConfig(ctx: ServeContext): GemdexConfig {
    return {
        ...ctx.config,
        mode: 'local',
        geminiApiKey: ctx.config.geminiApiKey ?? envManager.get('GEMINI_API_KEY'),
        remoteName: undefined,
        remote: undefined,
    };
}

function resolveStoredRemote(
    ctx: ServeContext,
    name: string,
): { remote: StoredRemote; token: string } {
    const configStore = clientConfigStore(ctx);
    const remote = configStore.get(name);
    if (!remote) throw new Error(`Remote "${name}" is not configured.`);
    const token = configStore.getEnv(remote.tokenEnvVar)?.trim();
    if (!token) throw new Error(`Remote "${name}" does not have a configured bearer token.`);
    return { remote, token };
}

function remoteConfig(ctx: ServeContext, name: string): GemdexConfig {
    const { remote, token } = resolveStoredRemote(ctx, name);
    return {
        ...ctx.config,
        mode: 'remote',
        remoteName: name,
        remote: { url: remote.url, token },
    };
}

function settingsSummary(ctx: ServeContext): DesktopSettingsSummary {
    const configStore = clientConfigStore(ctx);
    return {
        mode: ctx.config.mode,
        ...(ctx.config.mode === 'remote' && ctx.config.remoteName && { activeRemote: ctx.config.remoteName }),
        configured: ctx.store !== null,
        localConfigured: Boolean(ctx.config.geminiApiKey ?? envManager.get('GEMINI_API_KEY')),
        remotes: configStore.list().map((remote) => ({
            ...remote,
            hasToken: Boolean(configStore.getEnv(remote.tokenEnvVar)?.trim()),
        })),
    };
}

async function testRemoteConnection(
    ctx: ServeContext,
    name: string,
): Promise<{ reachable: boolean; authenticated: boolean; detail?: string }> {
    const { remote, token } = resolveStoredRemote(ctx, name);
    try {
        const response = await (ctx.fetch ?? fetch)(`${remote.url}/v1/health`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            return {
                reachable: false,
                authenticated: false,
                detail: `Health check returned HTTP ${response.status}.`,
            };
        }
    } catch (error) {
        return {
            reachable: false,
            authenticated: false,
            detail: errorMessage(error),
        };
    }

    try {
        await new RemoteMemoryBackend({ url: remote.url, token, fetch: ctx.fetch }).list();
        return { reachable: true, authenticated: true };
    } catch (error) {
        return {
            reachable: true,
            authenticated: false,
            detail: errorMessage(error),
        };
    }
}

async function migrateLocalToRemote(
    ctx: ServeContext,
    name: string,
): Promise<{ created: number; updated: number; skipped: number }> {
    const sourceConfig = localConfig(ctx);
    if (!sourceConfig.geminiApiKey) {
        throw new Error('Configure GEMINI_API_KEY before importing local memories.');
    }
    const local = ctx.config.mode === 'local' && ctx.store
        ? ctx.store
        : createBackend(ctx, sourceConfig);
    const targetConfig = remoteConfig(ctx, name);
    const remote = ctx.config.mode === 'remote' && ctx.config.remoteName === name && ctx.store
        ? ctx.store
        : createBackend(ctx, targetConfig);
    const records = await local.exportAll();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const record of records) {
        try {
            const existed = await remote.get(record.id) !== null;
            const result = await remote.importRecords([record]);
            if (result.imported !== 1) {
                skipped += 1;
            } else if (existed) {
                updated += 1;
            } else {
                created += 1;
            }
        } catch {
            skipped += 1;
        }
    }
    return { created, updated, skipped };
}

/**
 * `gemdex serve` — the localhost HTTP/JSON sidecar that backs the desktop
 * manager app. It wraps the same gemdex-core MemoryBackend + LanceDB store the
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
            // expose sensitive memory data. /config stays a desktop-sidecar
            // concern; shared memory API handlers do not mount it.
            if (method === 'GET' && pathname === '/config') {
                sendJson(res, 200, {
                    configured: ctx.store !== null,
                    mode: ctx.config.mode,
                    needsKey: ctx.config.mode === 'local' && ctx.store === null,
                }, corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/config') {
                const body = await readBody(req);
                const apiKey = trimmedString(body?.apiKey);
                if (apiKey.length === 0) {
                    sendJson(res, 400, { error: "'apiKey' is required" }, corsHeaders);
                    return;
                }
                try {
                    configureApiKey(ctx, apiKey);
                    sendJson(res, 200, { configured: ctx.store !== null }, corsHeaders);
                } catch (error) {
                    sendJson(res, 500, { error: errorMessage(error) }, corsHeaders);
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

            if (method === 'GET' && pathname === '/settings') {
                sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                return;
            }

            if (method === 'POST' && pathname === '/settings/remotes') {
                const body = await readBody(req);
                const name = trimmedString(body?.name);
                const remoteUrl = trimmedString(body?.url);
                const token = trimmedString(body?.token);
                if (!name || !remoteUrl) {
                    sendJson(res, 400, { error: "'name' and 'url' are required" }, corsHeaders);
                    return;
                }
                const configStore = clientConfigStore(ctx);
                try {
                    const existing = configStore.get(name);
                    if (!existing && !token) {
                        throw new Error("'token' is required for a new remote");
                    }
                    if (existing && !token && !configStore.getEnv(existing.tokenEnvVar)?.trim()) {
                        throw new Error("'token' is required because this remote does not have one configured");
                    }
                    const tokenEnvVar = existing?.tokenEnvVar ?? tokenEnvVarForRemote(name);
                    configStore.add(name, remoteUrl, tokenEnvVar);
                    if (token) {
                        configStore.setEnv(tokenEnvVar, token);
                        process.env[tokenEnvVar] = token;
                    }
                    if (ctx.config.mode === 'remote' && ctx.config.remoteName === name) {
                        ctx.config = remoteConfig(ctx, name);
                        ctx.store = createBackend(ctx, ctx.config);
                    }
                    sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            const remoteSettingsMatch = pathname.match(/^\/settings\/remotes\/([^/]+)$/);
            if (method === 'DELETE' && remoteSettingsMatch) {
                const name = decodeURIComponent(remoteSettingsMatch[1]);
                const configStore = clientConfigStore(ctx);
                try {
                    const existing = configStore.get(name);
                    if (!configStore.remove(name)) {
                        sendJson(res, 404, { error: `Remote "${name}" is not configured.` }, corsHeaders);
                        return;
                    }
                    if (existing?.tokenEnvVar === tokenEnvVarForRemote(name)) {
                        delete process.env[existing.tokenEnvVar];
                    }
                    if (ctx.config.mode === 'remote' && ctx.config.remoteName === name) {
                        ctx.config = localConfig(ctx);
                        ctx.store = buildStore(ctx.config, ctx.createBackend);
                    }
                    sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/settings/mode') {
                const body = await readBody(req);
                const mode = trimmedString(body?.mode).toLowerCase();
                try {
                    if (mode === 'local') {
                        clientConfigStore(ctx).activateLocal();
                        ctx.config = localConfig(ctx);
                        ctx.store = buildStore(ctx.config, ctx.createBackend);
                    } else if (mode === 'remote') {
                        const name = trimmedString(body?.name);
                        if (!name) throw new Error("'name' is required for remote mode.");
                        const nextConfig = remoteConfig(ctx, name);
                        clientConfigStore(ctx).activateRemote(name);
                        ctx.config = nextConfig;
                        ctx.store = createBackend(ctx, ctx.config);
                    } else {
                        throw new Error("'mode' must be local or remote.");
                    }
                    sendJson(res, 200, settingsSummary(ctx), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/settings/test') {
                const body = await readBody(req);
                const name = typeof body?.name === 'string' ? body.name.trim() : ctx.config.remoteName ?? '';
                if (!name) {
                    sendJson(res, 400, { error: "'name' is required" }, corsHeaders);
                    return;
                }
                try {
                    sendJson(res, 200, await testRemoteConnection(ctx, name), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            if (method === 'POST' && pathname === '/settings/import-local') {
                const body = await readBody(req);
                const name = typeof body?.name === 'string' ? body.name.trim() : ctx.config.remoteName ?? '';
                if (!name) {
                    sendJson(res, 400, { error: "'name' is required" }, corsHeaders);
                    return;
                }
                try {
                    sendJson(res, 200, await migrateLocalToRemote(ctx, name), corsHeaders);
                } catch (error) {
                    sendJson(res, 400, { error: errorMessage(error) }, corsHeaders);
                }
                return;
            }

            // Every remaining route needs an embedding-backed store. Until a
            // key is configured, tell the app to prompt for one.
            if (ctx.store === null) {
                sendJson(res, 503, { error: 'GEMINI_API_KEY not configured', needsKey: true }, corsHeaders);
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

    const ctx: ServeContext = {
        config,
        store: buildStore(config),
        token,
        allowedOrigin,
        clientConfigStore: new ClientConfigStore(),
    };
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
