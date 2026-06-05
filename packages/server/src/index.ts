#!/usr/bin/env node
import { loadServerConfig } from './config.js';
import { startServer } from './server.js';

function printUsage(): void {
    process.stdout.write(`
gemdex-server — self-hostable Gemdex memory backend

Usage:
  gemdex-server [options]

Options:
  -H, --host <host>   Bind address (default: 127.0.0.1). Use 0.0.0.0 for
                      container or network-wide exposure.
  -p, --port <port>   Listening port (default: 8765).
  -c, --config <path> Path to a JSON config file. Env vars override file values.
  --allowed-origin <origin>
                      Browser origin allowed by CORS. Repeat or comma-separate.
  --unsafe-dev-no-auth
                      Disable bearer-token auth for unsafe local development only.
  -h, --help          Show this help message.

Environment variables:
  GEMDEX_SERVER_HOST    Bind address (default: 127.0.0.1).
  GEMDEX_SERVER_PORT    Listening port (default: 8765).
  GEMDEX_SERVER_CONFIG  Path to a JSON config file.
  GEMDEX_SERVER_TOKEN   Required bearer token for all data routes.
  GEMDEX_SERVER_ALLOWED_ORIGINS
                        Comma-separated browser origins allowed by CORS.
  GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH
                        Set true only for unsafe local development without auth.

Endpoints:
  GET  /v1/health    Readiness probe — no auth required.
  GET  /v1/version   Compatibility metadata — no auth required.
  POST /v1/memories  Create a memory (requires a configured backend).
  GET  /v1/memories  List memories (requires a configured backend).
  ...and the full /v1/* memory API.

Security: data routes require Authorization: Bearer <token> unless
GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH=true is explicitly set. Configure
GEMDEX_SERVER_ALLOWED_ORIGINS for browser/desktop clients; by default,
cross-origin browser data access is denied.
`);
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
}

let config;
try {
    config = loadServerConfig({ argv: args });
} catch (err: any) {
    process.stderr.write(`[gemdex-server] Configuration error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
}

startServer(config).then((server) => {
    const shutdown = (): void => {
        console.error('[gemdex-server] Shutting down...');
        server.close(() => process.exit(0));
        // Force-exit if close hangs on keep-alive sockets.
        setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}).catch((err) => {
    process.stderr.write(`[gemdex-server] Failed to start: ${err?.message ?? String(err)}\n`);
    process.exit(1);
});
