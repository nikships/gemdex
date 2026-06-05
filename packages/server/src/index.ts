#!/usr/bin/env node
import { createBlobStore } from './blob-store.js';
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
  -h, --help          Show this help message.

Environment variables:
  GEMDEX_SERVER_HOST    Bind address (default: 127.0.0.1).
  GEMDEX_SERVER_PORT    Listening port (default: 8765).
  GEMDEX_SERVER_CONFIG  Path to a JSON config file.
  GEMDEX_SERVER_TOKEN   Bearer token for auth (enforced in a later release).
  BLOB_STORE            Attachment store: file or s3 (default: file).
  BLOB_DIR              Directory for BLOB_STORE=file.
  S3_BUCKET             Bucket for BLOB_STORE=s3.
  S3_ENDPOINT           S3-compatible endpoint (R2, MinIO, etc.).
  S3_REGION             S3 region (default: auto for S3-compatible stores).
  S3_ACCESS_KEY_ID      Access key (falls back to AWS_ACCESS_KEY_ID).
  S3_SECRET_ACCESS_KEY  Secret key (falls back to AWS_SECRET_ACCESS_KEY).
  S3_FORCE_PATH_STYLE   Use path-style addressing for MinIO/local S3.

Endpoints:
  GET  /v1/health    Readiness probe — no auth required.
  GET  /v1/version   Compatibility metadata — no auth required.
  POST /v1/memories  Create a memory (requires a configured backend).
  GET  /v1/memories  List memories (requires a configured backend).
  ...and the full /v1/* memory API.

Note: storage backend and auth are configured in later releases (GEM-10–14).
Until then, data routes return 503.
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
    // Validate blob store configuration at startup even before GEM-9 wires the
    // full memory backend into the self-hostable server. This catches missing
    // S3/bucket/credential shape errors early while preserving the current
    // no-backend 503 behavior for memory routes.
    createBlobStore(config.blobStore);
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
