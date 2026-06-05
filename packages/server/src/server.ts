import * as http from 'http';
import {
    buildCorsHeaders,
    handleMemoryApiRequest,
    sendJson,
    ServerVersionInfo,
    SUPPORTED_API_VERSION,
    SUPPORTED_PROTOCOL_VERSION,
} from 'gemdex-core';
import type { MemoryBackend } from 'gemdex-core';
import type { ServerConfig } from './config.js';

// Tracks package.json version. Update on every package release.
const SERVER_VERSION = '0.1.0';

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
    config: ServerConfig;
    store?: MemoryBackend | null;
}

/**
 * Build the HTTP server. Health and version routes are always available.
 * Memory routes under /v1/* answer 503 until a store is injected.
 */
export function createServer({ store = null }: CreateServerOptions): http.Server {
    return http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const corsHeaders = buildCorsHeaders(undefined);

        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Allow': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Gemdex-Token',
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

            // All /v1/* memory routes require a configured backend.
            if (pathname.startsWith('/v1/')) {
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
export function startServer(config: ServerConfig, store?: MemoryBackend | null): Promise<http.Server> {
    return new Promise((resolve) => {
        const server = createServer({ config, store: store ?? null });
        server.listen(config.port, config.host, () => {
            const address = server.address();
            const boundPort = typeof address === 'object' && address ? address.port : config.port;
            console.error(`[gemdex-server] Listening on http://${config.host}:${boundPort}`);
            resolve(server);
        });
    });
}
