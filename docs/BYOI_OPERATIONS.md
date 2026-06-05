# Self-Hosting Gemdex (BYOI)

Gemdex BYOI mode runs one user-owned Gemdex Server for MCP, CLI, and desktop
clients. Gemdex does not provide a hosted control plane, account system, or
custody service. You operate the server, bearer token, Gemini key, Postgres
database, and attachment storage.

This guide uses the repository's Docker Compose deployment. See
[`BYOI_REMOTE_MODE.md`](BYOI_REMOTE_MODE.md) for the v1 protocol contract and
[`packages/server/README.md`](../packages/server/README.md) for every server
setting and endpoint.

## What You Need

- A Linux host with Git, Docker Engine, and Docker Compose v2.
- A DNS name if clients connect over a network.
- A Google AI Studio API key for `gemini-embedding-2`.
- TLS termination, normally Caddy, nginx, Traefik, or a private-network ingress.
- Node.js 20 or newer on each machine that runs `gemdex-mcp`.

The Compose port binds to `127.0.0.1` by default. That is intentional: put a
TLS reverse proxy on the same host, or keep the service reachable only through
a trusted private network.

## End-to-End Quickstart

### 1. Start the Server

```sh
git clone https://github.com/anand-92/gemdex.git
cd gemdex/packages/server
cp .env.example .env

# Generate URL-safe secrets. Put the first value in GEMDEX_SERVER_TOKEN and the
# second in POSTGRES_PASSWORD, then add your real GEMINI_API_KEY.
openssl rand -hex 32
openssl rand -hex 32
vi .env

docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8765/v1/health
curl --fail http://127.0.0.1:8765/v1/version
```

Expected health output is `{"ok":true}`. The first start creates Postgres,
enables pgvector, applies all schema migrations, and creates the file-backed
attachment volume.

For same-machine testing, use `http://127.0.0.1:8765` as the remote URL. Before
connecting another machine, configure TLS and use an `https://` URL.

### 2. Put TLS in Front

For example, a Caddy site on the same host can proxy the loopback-only port:

```caddyfile
memory.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

Keep port 8765 closed in the host firewall. Expose only the TLS listener. The
bearer token is still required behind the proxy; TLS protects that token and
memory content in transit. If a proxy terminates authentication itself, it must
still forward the configured Gemdex bearer token unless the deployment has
been deliberately redesigned and isolated.

### 3. Configure the MCP Client

On the client machine, store the remote and token:

```sh
read -rsp "Gemdex bearer token: " GEMDEX_TOKEN; echo
printf %s "$GEMDEX_TOKEN" |
  npx -y gemdex-mcp@latest remote add production \
    https://memory.example.com --token-stdin

npx -y gemdex-mcp@latest mode remote production
npx -y gemdex-mcp@latest status
unset GEMDEX_TOKEN
```

`status` should report both `Reachable: yes` and `Authenticated: yes`. Named
remote metadata is stored in `~/.gemdex/config.json`; its token is stored
separately in `~/.gemdex/.env` with user-only permissions. Remote clients do
not need `GEMINI_API_KEY`: embedding runs on your server.

Add the MCP process to the client. For Claude Code:

```sh
claude mcp add gemdex -- npx -y gemdex-mcp@latest
```

For another MCP client, configure `npx` with
`["-y", "gemdex-mcp@latest"]`. The process reads the selected remote from the
same `~/.gemdex` configuration.

Start a new agent session and exercise both directions:

```text
Save "The BYOI smoke-test phrase is cobalt sunrise" to memory.
```

Then:

```text
Recall the BYOI smoke-test phrase from memory.
```

That verifies MCP stdio, bearer authentication, server-owned Gemini embedding,
Postgres/pgvector storage, and remote recall.

## Security and Custody

BYOI v1 is a single-user, single-token deployment:

- All data routes require `Authorization: Bearer <token>`.
- `/v1/health` and `/v1/version` are intentionally unauthenticated and contain
  no memory records.
- There are no Gemdex accounts, sessions, tenants, ACLs, or hosted dashboards.
- CORS is deny-by-default. Set exact browser origins only when needed.
- Never enable `GEMDEX_SERVER_UNSAFE_DEV_NO_AUTH` on a shared host, container
  network, tunnel, LAN, or public interface.

Memories, attachment bytes, metadata, and the bearer token are plaintext in
your infrastructure unless you add your own controls. Gemdex does not encrypt
them at rest. Use encrypted disks, encrypted database/storage services, secret
managers, restrictive filesystem permissions, private networking, and provider
access controls according to your threat model.

Memory text and supported media are sent to the Gemini embedding API when an
operation needs an embedding. The Gemdex maintainers do not receive or host
your records. Your infrastructure providers and Google process the data
according to the services and accounts you selected.

Rotate a compromised bearer token by changing `GEMDEX_SERVER_TOKEN`, restarting
the server, updating every client, and removing the old value from local secret
files and deployment logs.

## Storage

### Postgres and pgvector

Postgres stores parent memories, retrieval chunks, vectors, full-text data,
attachment metadata, and migration bookkeeping. The Compose deployment uses
the `gemdex_gemdex-postgres` volume and does not publish the database port.

One deployment is one global memory pool. There are no per-repository scopes,
tags, or tenant columns, and timestamps never influence recall ranking.

### File Attachment Storage

The default `BLOB_STORE=file` stores raw attachment bytes in
`gemdex_gemdex-blobs`, mounted at `/var/lib/gemdex/blobs`. Keep the database and
blob volume together: database rows refer to opaque blob keys.

### S3-Compatible Storage

For AWS S3, Cloudflare R2, MinIO, or another compatible service:

1. In `docker-compose.yml`, remove `BLOB_STORE: file` and `BLOB_DIR`.
2. Uncomment the `BLOB_STORE: s3` variables.
3. Remove the `gemdex-blobs` service volume mount if file storage is no longer
   used.
4. Add the required bucket, endpoint, region, and credentials to `.env` or your
   deployment secret store.

Use a dedicated bucket or `S3_PREFIX`, server-side encryption where available,
versioning, lifecycle policy, and credentials limited to that bucket/prefix.
The database still holds attachment metadata, so back up both systems.

## Backup and Restore

### Portable Logical Backup

The v1 export contains every memory and base64-encoded attachment:

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer $GEMDEX_SERVER_TOKEN" \
  https://memory.example.com/v1/export > gemdex-export.json
```

Restore or merge it into a compatible server:

```sh
curl --fail --silent --show-error \
  -H "Authorization: Bearer $GEMDEX_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @gemdex-export.json \
  https://memory.example.com/v1/import
```

Import upserts by memory ID and may require the server Gemini key to recreate
embeddings. Protect the export like the live database: it contains plaintext
memory and attachment content.

### Infrastructure Backup

For a consistent Postgres/file-blob pair, briefly stop writes:

```sh
docker compose stop gemdex-server
docker compose exec -T postgres \
  pg_dump -U gemdex -d gemdex -Fc > gemdex-postgres.dump
docker run --rm \
  -v gemdex_gemdex-blobs:/data:ro \
  -v "$PWD":/backup \
  alpine tar -czf /backup/gemdex-blobs.tar.gz -C /data .
docker compose start gemdex-server
```

When using S3, replace the volume archive with a bucket snapshot or provider
backup taken in the same maintenance window.

Restore into an empty, compatible Postgres and blob volume while the Gemdex
Server is stopped:

```sh
docker compose up -d postgres
docker compose exec -T postgres \
  pg_restore --clean --if-exists --no-owner -U gemdex -d gemdex \
  < gemdex-postgres.dump
docker run --rm \
  -v gemdex_gemdex-blobs:/data \
  -v "$PWD":/backup:ro \
  alpine tar -xzf /backup/gemdex-blobs.tar.gz -C /data
docker compose up -d gemdex-server
```

Do not restore over an active server. Test backups on a separate host, retain
the Gemdex version used to create them, and verify recall plus attachment reads
after recovery.

## Upgrade and Migration

1. Read release notes and take both logical and infrastructure backups.
2. Stop the Gemdex Server so no writes occur during the upgrade.
3. Pull the desired Git revision or image.
4. Build the new image and run migrations explicitly.
5. Start the service and verify health, version, auth, recall, and attachments.

```sh
docker compose stop gemdex-server
git pull --ff-only
docker compose build --pull gemdex-server
docker compose run --rm gemdex-server node dist/index.js migrate
docker compose up -d gemdex-server
docker compose ps
curl --fail http://127.0.0.1:8765/v1/health
```

Startup also applies pending migrations and exits instead of serving a partial
schema if one fails. Never edit an already-applied migration: checksums are
verified. A database downgrade is not implied by installing older code; restore
the matching pre-upgrade backup when rollback is required.

## Troubleshooting

### Health Works but Authentication Fails

- Run `npx -y gemdex-mcp@latest status`.
- A `401` means the client token is absent or differs from
  `GEMDEX_SERVER_TOKEN`.
- Update the named remote, restart the MCP client, and check that the reverse
  proxy forwards the `Authorization` header.
- A `403` in a browser can instead mean its exact origin is missing from
  `GEMDEX_SERVER_ALLOWED_ORIGINS`.

### Gemini Operations Fail

Health can remain green without a working Gemini key. Save, update, import, or
recall then fails when embedding is attempted.

```sh
docker compose logs gemdex-server
docker compose exec gemdex-server sh -c \
  'test -n "$GEMINI_API_KEY" && echo configured || echo missing'
```

Set a valid server-side `GEMINI_API_KEY`, confirm the selected model supports
the payload, and restart the service. Do not add the key to remote clients.

### Database or Migration Failure

- Inspect `docker compose logs postgres gemdex-server`.
- Confirm Postgres is healthy, the database URL/password is correct, disk space
  is available, and the pgvector image is in use.
- Run the explicit migration command from the upgrade section.
- A checksum mismatch means deployed migration SQL no longer matches the
  recorded migration. Deploy an unmodified official revision; do not delete
  migration bookkeeping to force startup.
- Restore the pre-upgrade backup if a migration cannot be corrected safely.

### Client/Server Version Mismatch

Inspect the server contract:

```sh
curl --fail https://memory.example.com/v1/version
```

Compare `apiVersion`, `protocolVersion`, and `minClientVersion` with the client
release in use. Upgrade `gemdex-mcp` with `@latest`, or deploy a server revision
compatible with that client. After server upgrades, rerun `status` before
reconnecting agent sessions.

### Network or Proxy Failure

- Test `/v1/health` locally on the server, then through the public URL.
- A local success plus public `502`/`504` points to proxy routing or TLS.
- Confirm the proxy targets `127.0.0.1:8765`, forwards request bodies and
  `Authorization`, and permits attachment-sized requests.
- Do not solve proxy trouble by publishing an unauthenticated server port.
