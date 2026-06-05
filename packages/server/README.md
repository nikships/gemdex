# gemdex-server

Self-hostable Gemdex Server — the official BYOI (Bring Your Own Infrastructure) remote backend HTTP service.

This package provides the `gemdex-server` CLI and the HTTP service that backs
remote Gemdex clients (MCP, desktop app, CLI). It exposes the Gemdex v1 HTTP API
under `/v1/*`.

> Storage backend, pgvector integration, and auth enforcement arrive in tickets
> GEM-10 through GEM-14. Until then, data routes return 503.

## Quick Start

```sh
# Install globally
npm install -g gemdex-server

# Start with defaults (binds 127.0.0.1:8765)
gemdex-server

# Bind to all interfaces for container or network exposure
gemdex-server --host 0.0.0.0 --port 8765
```

## Environment Variables

| Variable               | Default     | Description                                                    |
|------------------------|-------------|----------------------------------------------------------------|
| `GEMDEX_SERVER_HOST`   | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose on all interfaces.      |
| `GEMDEX_SERVER_PORT`   | `8765`      | Listening port. Must be an integer between 1 and 65535.        |
| `GEMDEX_SERVER_CONFIG` | (none)      | Path to a JSON config file. Env vars override file values.     |
| `GEMDEX_SERVER_TOKEN`  | (none)      | Bearer token for auth. Enforced in a later release (GEM-13).   |

### Host / Port Defaults

The server binds `127.0.0.1` (localhost only) by default — a safe default for
local testing and development. For container deployments or to make the server
reachable on your network, set `GEMDEX_SERVER_HOST=0.0.0.0` or pass
`--host 0.0.0.0`.

## CLI Options

```
gemdex-server [options]

  --host <host>     Bind address (default: 127.0.0.1).
  --port <port>     Listening port (default: 8765).
  --config <path>   Path to a JSON config file.
  -h, --help        Show help message.
```

## Config File

You can pass a JSON config file via `--config <path>` or `GEMDEX_SERVER_CONFIG`:

```json
{
  "host": "0.0.0.0",
  "port": 8765,
  "token": "your-bearer-token"
}
```

Explicit environment variables always override file values.

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

### Memory Routes (require configured backend)

All `/v1/*` memory routes return `503 { "error": "No memory backend configured" }`
until a storage backend is configured. Storage support arrives in GEM-10.

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

## Architecture

This package is part of the gemdex monorepo:

- `gemdex-core` — shared types, memory API handler, embeddings, and vector DB.
- `gemdex-mcp` — MCP stdio server for AI coding agents.
- `gemdex-server` — self-hostable HTTP backend (this package).

The `/v1/*` memory routes reuse the `handleMemoryApiRequest` handler from
`gemdex-core`, ensuring identical request/response semantics between local and
remote deployments.
