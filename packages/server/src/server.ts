import * as http from 'http';
import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import {
    handleMemoryApiRequest,
    sendJson,
    ServerVersionInfo,
    SUPPORTED_API_VERSION,
    SUPPORTED_PROTOCOL_VERSION,
} from 'gemdex-core';
import type { MemoryBackend } from 'gemdex-core';
import type { ServerConfig } from './config.js';
import { createBlobStore } from './blob-store.js';
import { createPostgresPool, migrateDatabase, PostgresMemoryBackend } from './postgres.js';

// Read the version from package.json so it never drifts from the published
// version. createRequire works in ESM and resolves relative to this module
// (dist/server.js → ../package.json, and src/server.ts under tsx).
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json') as { version: string };

const VERSION_INFO: ServerVersionInfo = {
    name: 'gemdex-server',
    apiVersion: SUPPORTED_API_VERSION,
    serverVersion: SERVER_VERSION,
    minClientVersion: '0.3.0',
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    capabilities: {
        attachments: true,
        recallAttachments: true,
        importExport: true,
        auth: ['bearer'],
    },
};

export interface CreateServerOptions {
    store?: MemoryBackend | null;
    /** Bearer token required for all data routes. */
    token?: string;
    /** Explicit local/dev escape hatch for starting without auth. Never enable for exposed deployments. */
    unsafeDevNoAuth?: boolean;
    /** Browser origins allowed to read data-route responses. Empty means browser cross-origin access is denied. */
    allowedOrigins?: string[];
}

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';

function normalizeOrigins(origins: string[] | undefined): Set<string> {
    // Strip trailing slashes so a configured origin like
    // "https://app.example.com/" matches the browser-sent Origin header
    // ("https://app.example.com"), which never includes a trailing slash.
    return new Set((origins ?? []).map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean));
}

function buildServerCorsHeaders(req: http.IncomingMessage, allowedOrigins: Set<string>): Record<string, string> {
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Allow-Credentials': 'false',
    };
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function isCorsOriginAllowed(req: http.IncomingMessage, allowedOrigins: Set<string>): boolean {
    const origin = req.headers.origin;
    return typeof origin !== 'string' || allowedOrigins.has(origin);
}

function hasValidBearerToken(req: http.IncomingMessage, token: string | undefined): boolean {
    if (!token) return false;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const supplied = Buffer.from(match[1], 'utf8');
    const expected = Buffer.from(token, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Build the HTTP server. Health and version routes are always available.
 * Memory routes under /v1/* answer 503 until a store is injected.
 */
export function createServer({ store = null, token, unsafeDevNoAuth = false, allowedOrigins = [] }: CreateServerOptions): http.Server {
    const normalizedAllowedOrigins = normalizeOrigins(allowedOrigins);
    return http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const corsHeaders = buildServerCorsHeaders(req, normalizedAllowedOrigins);

        if (method === 'OPTIONS') {
            if (!isCorsOriginAllowed(req, normalizedAllowedOrigins)) {
                sendJson(res, 403, { error: 'Origin not allowed' }, corsHeaders);
                return;
            }
            res.writeHead(204, {
                'Allow': ALLOW_METHODS,
                ...corsHeaders,
            });
            res.end();
            return;
        }

        try {
            // GET /v1/health — unauthenticated readiness probe.
            if (method === 'GET' && pathname === '/v1/health') {
                sendJson(res, 200, { ok: true }, corsHeaders);
                return;
            }

            // GET /v1/version — unauthenticated compatibility metadata.
            if (method === 'GET' && pathname === '/v1/version') {
                sendJson(res, 200, VERSION_INFO, corsHeaders);
                return;
            }

            // All /v1/* memory routes require an allowed browser origin, auth,
            // and a configured backend. Health/version above are intentionally
            // unauthenticated and safe to expose.
            if (pathname.startsWith('/v1/')) {
                if (!isCorsOriginAllowed(req, normalizedAllowedOrigins)) {
                    sendJson(res, 403, { error: 'Origin not allowed' }, corsHeaders);
                    return;
                }
                if (!unsafeDevNoAuth && !hasValidBearerToken(req, token)) {
                    sendJson(res, 401, { error: 'Unauthorized' }, corsHeaders);
                    return;
                }
                if (store === null) {
                    sendJson(res, 503, { error: 'No memory backend configured' }, corsHeaders);
                    return;
                }
                // Strip the /v1 prefix and delegate to the shared memory API
                // handler. Mutate req.url in place (idiomatic mount-path
                // stripping) rather than wrapping req in a prototype proxy —
                // the handler streams the body off the real request object.
                req.url = req.url?.replace(/^\/v1/, '') ?? '/';

                const handled = await handleMemoryApiRequest(req, res, {
                    store,
                    corsHeaders,
                });
                if (!handled) {
                    sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
                }
                return;
            }

            sendJson(res, 404, { error: `No route for ${method} ${pathname}` }, corsHeaders);
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
            console.error('[server] request error:', error);
            sendJson(res, 500, { error: message }, corsHeaders);
        }
    });
}

/**
 * Start the server and log the bound address.
 */
export async function startServer(config: ServerConfig, store?: MemoryBackend | null): Promise<http.Server> {
    let resolvedStore = store ?? null;
    if (!resolvedStore && config.databaseUrl) {
        const pool = createPostgresPool(config.databaseUrl);
        try {
            await migrateDatabase(pool);
        } catch (error) {
            await pool.end().catch(() => undefined);
            throw error;
        }
        resolvedStore = new PostgresMemoryBackend({
            pool,
            blobStore: createBlobStore(config.blobStore),
            blobStorageProvider: config.blobStore.kind,
        });
    }

    return new Promise((resolve) => {
        const server = createServer({
            store: resolvedStore,
            token: config.token,
            unsafeDevNoAuth: config.unsafeDevNoAuth,
            allowedOrigins: config.allowedOrigins,
        });
        server.listen(config.port, config.host, () => {
            const address = server.address();
            const boundPort = typeof address === 'object' && address ? address.port : config.port;
            console.error(`[gemdex-server] Listening on http://${config.host}:${boundPort}`);
            resolve(server);
        });
    });
}
