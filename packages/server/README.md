# gemdex-server

Self-hostable Gemdex Server — the official BYOI (Bring Your Own Infrastructure) remote backend HTTP service.

This package provides the `gemdex-server` CLI and the HTTP service that backs
remote Gemdex clients (MCP, desktop app, CLI). It exposes the Gemdex v1 HTTP API
under `/v1/*`.

> pgvector/BM25 ranking arrives in a later ticket. GEM-10 adds
> durable Postgres storage, schema migrations, and CRUD/import/export persistence.
> Recall currently uses a minimal text match until the dedicated recall backend lands.

## Quick Start

```sh
# Install globally
npm install -g gemdex-server

# Start with defaults (binds 127.0.0.1:8765)
GEMDEX_SERVER_TOKEN=change-me-to-a-long-random-secret gemdex-server

# Run durable Postgres migrations explicitly
GEMDEX_SERVER_DATABASE_URL=postgres://user:pass@localhost:5432/gemdex \
  gemdex-server migrate

# Start with durable Postgres storage (startup applies pending migrations first)
GEMDEX_SERVER_DATABASE_URL=postgres://user:pass@localhost:5432/gemdex \
  gemdex-server

# Bind to all interfaces for container or network exposure
GEMDEX_SERVER_TOKEN=change-me-to-a-long-random-secret \
  GEMDEX_SERVER_ALLOWED_ORIGINS=https://app.example.com \
  gemdex-server --host 0.0.0.0 --port 8765
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMDEX_SERVER_HOST`   | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose on all interfaces.      |
| `GEMDEX_SERVER_PORT`   | `8765`      | Listening port. Must be an integer between 1 and 65535.        |
| `GEMDEX_SERVER_CONFIG` | (none)      | Path to a JSON config file. Env vars override file values.     |
| `GEMDEX_SERVER_TOKEN`  | (required)  | Bearer token required for all data routes.                     |
| `GEMDEX_SERVER_ALLOWED_ORIGINS` | (none) | Comma-separated browser origins allowed by CORS. No wildcard default. |
| `GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH` | `false` | Set `true` only for unsafe local development without auth. |
| `GEMDEX_SERVER_DATABASE_URL` / `DATABASE_URL` | (none) | Postgres connection string. When set, startup applies migrations and serves durable memory routes. |
| `BLOB_STORE`           | `file`      | Attachment blob store driver: `file` or `s3`.                  |
| `BLOB_DIR`             | `~/.gemdex/blobs` | Directory for `BLOB_STORE=file`.                         |
| `S3_BUCKET`            | (none)      | Bucket for `BLOB_STORE=s3`. Required for S3 mode.              |
| `S3_ENDPOINT`          | (none)      | S3-compatible endpoint for R2, MinIO, etc. Omit for AWS S3.    |
| `S3_REGION`            | `auto`      | Region for `BLOB_STORE=s3`.                                    |
| `S3_PREFIX`            | (none)      | Optional key prefix for Gemdex blobs.                          |
| `S3_ACCESS_KEY_ID`     | (AWS env)   | S3 access key; falls back to `AWS_ACCESS_KEY_ID`.              |
| `S3_SECRET_ACCESS_KEY` | (AWS env)   | S3 secret key; falls back to `AWS_SECRET_ACCESS_KEY`.          |
| `S3_FORCE_PATH_STYLE`  | (none)      | Set `true` for path-style S3 services such as many MinIO setups. |

### Host / Port Defaults

The server binds `127.0.0.1` (localhost only) by default — a safe default for
local testing and development. For container deployments or to make the server
reachable on your network, set `GEMDEX_SERVER_HOST=0.0.0.0` or pass
`--host 0.0.0.0`.

## CLI Options

```
gemdex-server [options]

  -H, --host <host>     Bind address (default: 127.0.0.1).
  -p, --port <port>     Listening port (default: 8765).
  -c, --config <path>   Path to a JSON config file.
  --allowed-origin <origin>
                        Browser origin allowed by CORS. Repeat or comma-separate.
  --unsafe-dev-no-auth  Disable auth for unsafe local development only.
  --database-url <url>  Postgres connection string for durable storage.
  -h, --help            Show help message.
```

## Config File

You can pass a JSON config file via `--config <path>` or `GEMDEX_SERVER_CONFIG`:

```json
{
  "host": "0.0.0.0",
  "port": 8765,
  "token": "your-bearer-token",
  "allowedOrigins": ["https://app.example.com"],
  "databaseUrl": "postgres://user:pass@localhost:5432/gemdex",
  "blobStore": {
    "kind": "file",
    "directory": "/var/lib/gemdex/blobs"
  }
}
```

Explicit environment variables always override file values.

## Security Defaults

Data routes require:

```http
Authorization: Bearer <token>
```

`GEMDEX_SERVER_TOKEN` (or `token` in the config file) is required unless
`GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH=true` or `unsafeDevNoAuth: true` is set
explicitly. The unsafe mode is for isolated local development only; never use it
for containers, shared hosts, tunnels, or public network exposure.

CORS is deny-by-default for browser origins. Requests without an `Origin` header
(curl, server-side clients, and many reverse proxies) bypass the origin allowlist
but still require bearer-token authentication. Browser requests only receive
`Access-Control-Allow-Origin` when their origin appears in
`GEMDEX_SERVER_ALLOWED_ORIGINS` or `allowedOrigins`. Preflight from any other
origin returns 403. Include exact origins such as:

```sh
GEMDEX_SERVER_ALLOWED_ORIGINS=https://desktop.example.com,http://localhost:5173
```

Reverse proxies may add TLS and additional authentication before forwarding to
Gemdex. Future OIDC or identity-aware proxy deployments can be layered at the
proxy/client boundary without changing the v1 MCP tool surface.

## Blob Storage

Blob storage can also be configured in the file:

```json
{
  "blobStore": {
    "kind": "s3",
    "bucket": "gemdex-blobs",
    "endpoint": "https://example.r2.cloudflarestorage.com",
    "region": "auto",
    "prefix": "production/blobs"
  }
}
```

Use `BLOB_STORE=file` with `BLOB_DIR=/path/to/blobs` for local single-node deployments. Use `BLOB_STORE=s3` with `S3_BUCKET` plus endpoint/credential variables for AWS S3, Cloudflare R2, MinIO, or other S3-compatible stores. Attachment size validation remains the same as inline base64 uploads: each attachment is capped at 20 MiB before bytes are written to any blob driver.

## Endpoints

### Unauthenticated

These routes require no auth token:

| Method | Path          | Description                                                  |
|--------|---------------|--------------------------------------------------------------|
| `GET`  | `/v1/health`  | Readiness probe. Returns `{ "ok": true }` when the server is ready. |
| `GET`  | `/v1/version` | Compatibility metadata for remote clients.                   |

`GET /v1/health` response:
```json
{ "ok": true }
```

`GET /v1/version` response:
```json
{
  "name": "gemdex-server",
  "apiVersion": "v1",
  "serverVersion": "0.1.0",
  "minClientVersion": "0.3.0",
  "protocolVersion": 1,
  "capabilities": {
    "attachments": true,
    "recallAttachments": true,
    "importExport": true,
    "auth": ["bearer"]
  }
}
```

### Memory Routes (require bearer token and configured backend)

All `/v1/*` memory routes other than health/version require
`Authorization: Bearer <token>`. Authenticated requests return
`503 { "error": "No memory backend configured" }` unless a storage backend is
configured. Set `GEMDEX_SERVER_DATABASE_URL`,
`DATABASE_URL`, `--database-url`, or `databaseUrl` in the config file to enable
the durable Postgres backend.

| Method   | Path                                   | Description                   |
|----------|----------------------------------------|-------------------------------|
| `POST`   | `/v1/memories`                         | Create a memory               |
| `GET`    | `/v1/memories`                         | List memory summaries         |
| `GET`    | `/v1/memories/:id`                     | Get one memory                |
| `PUT`    | `/v1/memories/:id`                     | Update a memory               |
| `DELETE` | `/v1/memories/:id`                     | Delete a memory               |
| `POST`   | `/v1/recall`                           | Recall by text or media       |
| `GET`    | `/v1/memories/:id/attachments/:attId`  | Fetch raw attachment bytes    |
| `PATCH`  | `/v1/memories/:id/attachments`         | Update attachment captions    |
| `GET`    | `/v1/export`                           | Export all memories           |
| `POST`   | `/v1/import`                           | Import memories               |


## Postgres Schema and Migrations

Gemdex Server stores one global memory pool per deployment for v1. The schema has
no user, tenant, scope, repository, tag, recency, or importance columns:
embeddings and later hybrid retrieval decide relevance. Timestamps are persisted
as metadata for display, export/import, and auditing; recall must not use them as
ranking signals.

The initial migration creates:

- `gemdex_schema_migrations` — migration bookkeeping with checksums.
- `gemdex_memory_documents` — parent memory documents returned to clients.
- `gemdex_memory_chunks` — retrieval units for parent-document chunking. Chunk
  rows reference their parent document, and API responses resolve back to the
  full parent memory rather than exposing fragments.
- `gemdex_memory_attachments` — stable per-memory attachment metadata (`id`,
  modality, MIME type, byte length, optional caption, and blob reference).
- `gemdex_attachment_blobs` — blob-reference records. With `BLOB_STORE=file` or
  `BLOB_STORE=s3`, bytes live in the configured blob driver and Postgres stores
  the provider, opaque key, checksum, and byte length. The backend still reads
  legacy inline `data` rows for compatibility.

### Running Migrations

Run migrations before first start or before upgrades:

```sh
GEMDEX_SERVER_DATABASE_URL=postgres://user:pass@localhost:5432/gemdex \
  gemdex-server migrate
```

Server startup also runs pending migrations automatically when a database URL is
configured. Migration failures are fail-closed: the CLI exits non-zero and the
HTTP server does not start, so a partially upgraded schema is not served.
Migration checksums are verified on every run; if an already-applied migration's
SQL changes, Gemdex refuses to continue.

### Backup Guidance Before Upgrades

Before upgrading Gemdex Server or applying new migrations, take a database backup
with your normal Postgres tooling. For example:

```sh
pg_dump --format=custom --file=gemdex-before-upgrade.dump "$GEMDEX_SERVER_DATABASE_URL"
```

Verify that the dump was created and that you know how to restore it in your
environment before running `gemdex-server migrate` or starting the upgraded
server.

## Architecture

This package is part of the gemdex monorepo:

- `gemdex-core` — shared types, memory API handler, embeddings, and vector DB.
- `gemdex-mcp` — MCP stdio server for AI coding agents.
- `gemdex-server` — self-hostable HTTP backend (this package).

The `/v1/*` memory routes reuse the `handleMemoryApiRequest` handler from
`gemdex-core`, ensuring identical request/response semantics between local and
remote deployments.
