# BYOI Remote Mode Architecture and API Contract

Status: implemented v1 contract

Gemdex is local-first: the MCP server and desktop sidecar can use Gemini
embeddings and an embedded LanceDB store on the user's machine. BYOI remote mode
adds a user-owned Gemdex Server so multiple clients can connect to one durable
memory backend without giving every client machine a Gemini API key. For
deployment and operations, see [`BYOI_OPERATIONS.md`](BYOI_OPERATIONS.md).

This document defines the implemented remote architecture and v1 HTTP API. It
preserves the existing memory model: one global memory pool, explicit
save/recall/update, parent-document chunking, and relevance-only ranking.

## Goals

- Define local mode versus remote mode behavior.
- Specify the v1 HTTP API used by remote MCP clients, CLI clients, and the
  desktop app.
- Keep the MCP public tool surface exactly `save_memory`, `recall`, and
  `update_memory`.
- Define attachment handling for local clients and the remote server.
- Define v1 auth as bearer-token-first, with reverse-proxy and OIDC-compatible
  extension points.
- Define client/server version and compatibility checks.

## Modes

### Local Mode

Local mode remains the default.

- The MCP stdio server builds a local `MemoryStore`.
- Embedding execution happens on the client machine with `GEMINI_API_KEY`.
- The embedded LanceDB store persists under `~/.gemdex/lance` by default.
- Blob attachments persist under `~/.gemdex/blobs` by default.
- The desktop app starts a localhost sidecar bound to `127.0.0.1` only.
- The memory pool is global on that machine: no scopes, tags, projects, or
  per-repo buckets.

### Remote Mode

Remote mode points clients at a user-owned Gemdex Server.

- The Gemdex Server owns embedding execution, database access, and blob storage.
- Client machines do not need `GEMINI_API_KEY` for remote mode.
- Clients send memory text and inline attachment payloads to the server.
- The server stores one global memory pool per deployment.
- The MCP server still exposes only `save_memory`, `recall`, and
  `update_memory`; remote-only management actions stay outside MCP.
- The desktop app and CLI may expose browse, create, edit, delete,
  import/export, and connection-management workflows against the same server.

Remote mode is not a hosted Gemdex SaaS. The user supplies and operates the
server, token, Gemini key, Postgres/pgvector database, and blob storage.

## Components

- **MCP stdio server**: Agent-facing process. It validates tool input, resolves
  local attachment paths into inline base64 payloads, and calls either the local
  backend or remote HTTP backend. It must not add remote-only tools.
- **Desktop app sidecar**: Local management API used by the native app. In
  remote mode it can act as a client to the Gemdex Server while keeping
  long-lived secrets out of frontend JavaScript state.
- **Gemdex Server**: User-owned HTTP service exposing `/v1/*`. It embeds,
  chunks, ranks, stores, lists, deletes, imports, exports, and serves
  attachment bytes.
- **Storage**: Remote deployments use durable server-side storage. The intended
  server path is Postgres with pgvector and full-text search for memories and
  chunks, plus file or S3-compatible blob storage for raw attachments.

## v1 API

All endpoints live under `/v1`. JSON endpoints accept and return
`application/json`. Binary attachment reads return the stored attachment content
type.

Errors should be clear JSON objects:

```json
{
  "error": "Human-readable message",
  "code": "optional_machine_code"
}
```

Data routes require `Authorization: Bearer <token>` in v1. `GET /v1/health` and
`GET /v1/version` are safe to expose without a token because they must not leak
memory content, secrets, or database records.

### Health And Version

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Readiness probe. Returns whether the server can answer basic requests. |
| `GET` | `/v1/version` | Compatibility metadata for remote clients. |

`GET /v1/health` response:

```json
{
  "ok": true
}
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

Remote clients must call `/v1/version` before data routes. If the server is not
compatible, the client must fail before sending memory data and show a message
that includes the client version, server version, and required client/server
range.

### Memory Records

Canonical memory response shape:

```json
{
  "id": "mem_...",
  "title": "Deployment playbook",
  "content": "Full parent memory content",
  "attachments": [
    {
      "id": "att_...",
      "kind": "image",
      "mimeType": "image/png",
      "caption": "Optional caption",
      "byteLength": 12345
    }
  ],
  "createdAt": 1812144000000,
  "updatedAt": 1812144000000
}
```

`createdAt` and `updatedAt` are epoch milliseconds, matching the local
`Memory` and `MemorySummary` types. Attachment metadata uses `byteLength` for
decoded bytes and `kind` for the media category (`image`, `audio`, `video`, or
`pdf`).

Attachment input uses inline base64 only:

```json
{
  "mimeType": "image/png",
  "data": "base64-encoded-bytes",
  "caption": "Optional caption"
}
```

HTTP clients must not send local filesystem paths to the Gemdex Server. Path
resolution lives in local client layers, especially MCP stdio handlers, before
upload.

### Memory CRUD

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/memories` | Create a memory from text and/or inline attachments. |
| `GET` | `/v1/memories` | List memory summaries, suitable for the desktop app. |
| `GET` | `/v1/memories/:id` | Read one full parent memory. |
| `PUT` | `/v1/memories/:id` | Replace supplied mutable fields and re-embed affected content. |
| `PATCH` | `/v1/memories/:id` | Partially update supplied fields and re-embed affected content. |
| `DELETE` | `/v1/memories/:id` | Delete a memory. Available to human management clients, never MCP. |

`POST /v1/memories` request:

```json
{
  "title": "Optional title",
  "content": "Memory text",
  "attachments": [
    {
      "mimeType": "image/png",
      "data": "base64-encoded-bytes",
      "caption": "Optional caption"
    }
  ]
}
```

Either `content` or at least one attachment is required.

`POST /v1/memories` response:

```json
{
  "memory": {}
}
```

The `memory` value is the canonical memory record. `GET`, `PUT`, and `PATCH`
return the same wrapper.

`GET /v1/memories` response:

```json
{
  "memories": [
    {
      "id": "mem_...",
      "title": "Deployment playbook",
      "preview": "Truncated text suitable for browse views",
      "attachments": [
        {
          "id": "att_...",
          "kind": "image",
          "mimeType": "image/png",
          "caption": "Optional caption",
          "byteLength": 12345
        }
      ],
      "createdAt": 1812144000000,
      "updatedAt": 1812144000000
    }
  ]
}
```

The list response is wrapped in an object and uses `MemorySummary`-compatible
items: full content is replaced by `preview`, while attachment metadata and
timestamps remain available for browse views. No `total` or pagination field is
part of the v1 contract unless a later compatible extension adds pagination.

`GET /v1/memories/:id` response:

```json
{
  "memory": {
    "id": "mem_...",
    "title": "Deployment playbook",
    "content": "Full parent memory content",
    "attachments": [
      {
        "id": "att_...",
        "kind": "image",
        "mimeType": "image/png",
        "caption": "Optional caption",
        "byteLength": 12345
      }
    ],
    "createdAt": 1812144000000,
    "updatedAt": 1812144000000
  }
}
```

`PUT /v1/memories/:id` and `PATCH /v1/memories/:id` return the same
`{ "memory": {} }` wrapper with the updated canonical memory record.

`DELETE /v1/memories/:id` response:

```json
{
  "ok": true
}
```

### Recall

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/recall` | Recall full parent memories by text, media, or both. |

`POST /v1/recall` request:

```json
{
  "query": "how do we notarize macOS builds",
  "limit": 10,
  "attachments": [
    {
      "mimeType": "image/png",
      "data": "base64-encoded-bytes",
      "caption": "Optional query caption"
    }
  ]
}
```

Either `query` or at least one attachment is required. The server embeds the text
and each query attachment, runs the configured recall branches, and returns full
parent memories.

`POST /v1/recall` response:

```json
{
  "results": [
    {
      "memory": {},
      "score": 0.42
    }
  ]
}
```

Scores are for relative display/debugging only. Clients must not treat score
values as stable across server versions or backends.

### Attachment Reads And Captions

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/memories/:id/attachments/:attachmentId` | Stream raw attachment bytes. |
| `PATCH` | `/v1/memories/:id/attachments` | Update attachment captions without replacing bytes. |

`PATCH /v1/memories/:id/attachments` request:

```json
{
  "captions": [
    {
      "id": "att_...",
      "caption": "Updated caption"
    },
    {
      "id": "att_without_caption"
    }
  ]
}
```

Each item maps to `AttachmentCaptionUpdate`: `id` is required and `caption` is
optional. Omitting `caption`, or sending an empty/whitespace caption, clears the
attachment caption so keyword fallback can use the memory title. The response is
`{ "memory": {} }` with the canonical memory record.

Caption-only edits are metadata updates. They may affect keyword recall text,
but they do not replace the raw blob.

### Import And Export

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/export` | Export all memories as portable records. |
| `POST` | `/v1/import` | Import portable records, upserting by id. |

The HTTP API exchanges JSON objects, not JSONL streams.

`GET /v1/export` response:

```json
{
  "records": [
    {
      "id": "mem_...",
      "title": "Deployment playbook",
      "content": "Full parent memory content",
      "createdAt": 1812144000000,
      "updatedAt": 1812144000000,
      "attachments": [
        {
          "id": "att_...",
          "mimeType": "image/png",
          "data": "base64-encoded-bytes",
          "caption": "Optional caption"
        }
      ]
    }
  ]
}
```

`POST /v1/import` request:

```json
{
  "records": [
    {
      "id": "mem_...",
      "title": "Deployment playbook",
      "content": "Full parent memory content",
      "createdAt": 1812144000000,
      "updatedAt": 1812144000000,
      "attachments": [
        {
          "id": "att_...",
          "mimeType": "image/png",
          "data": "base64-encoded-bytes",
          "caption": "Optional caption"
        }
      ]
    }
  ]
}
```

`POST /v1/import` response:

```json
{
  "imported": 1
}
```

Each `records` item maps to `MemoryExportRecord`; attachment bytes are inline
base64 so the export is portable without direct access to the server's blob
store.

Export/import must preserve parent memories and attachments. Imported records
are reindexed as needed by the destination server, but recall ranking remains
relevance-only.

## Ranking Contract

Remote recall must preserve Gemdex's current ranking semantics.

- **Parent-document chunking**: long memories are split into retrieval chunks for
  precise matching.
- **Parent resolution**: chunk hits resolve back to the complete parent memory.
  Callers never receive fragments.
- **Parent dedupe**: if multiple chunks or attachment branches hit the same
  parent, recall returns that parent once.
- **RRF fusion**: dense, BM25/full-text, and per-attachment query branches are
  fused with Reciprocal Rank Fusion or an equivalent scale-free rank fusion.
- **Relevance-only ranking**: timestamps are metadata only. Recency, importance,
  write order, and manual boosts are not ranking signals.
- **One global pool**: all memories in a deployment participate in recall
  together. There are no scopes, tags, projects, tenants, or per-repo buckets in
  v1.

## Attachment Contract

- The Gemdex Server accepts inline base64 attachment payloads only.
- Local MCP handlers may accept `path` inputs from agents, but they must read the
  file, infer or validate `mimeType`, enforce limits, and upload inline data.
- The HTTP server must not resolve arbitrary client filesystem paths.
- Supported attachment categories stay aligned with local mode: image, audio,
  video, and PDF.
- The per-attachment inline payload ceiling remains 20 MB unless a later API
  version explicitly changes it.
- Raw attachment bytes live in server-side blob storage and round-trip through
  export/import.

## Auth And Deployment

v1 official auth is a single-user bearer token:

```http
Authorization: Bearer <token>
```

The token is required on all data routes. Health and version routes remain
explicitly safe and unauthenticated. Servers should support CORS allowlists for
browser or desktop clients and should be deployed behind TLS when exposed beyond
localhost or a private network.

Future-compatible extension points:

- Reverse proxies may enforce additional auth before forwarding to Gemdex.
- OIDC or identity-aware proxy auth can be added later without changing the MCP
  tool surface.
- Multi-user account systems and RBAC are not part of v1.

## Versioning And Compatibility

- The URL path carries the major API version: `/v1`.
- Backward-compatible fields and capabilities may be added to v1 responses.
- Breaking protocol changes require a new major path such as `/v2`.
- Remote clients must check `/v1/version` before sending memory content.
- Compatibility errors must tell the user what is installed and what is
  required, for example: "Gemdex client 0.3.7 requires Gemdex Server API v1 with
  protocolVersion 1; server returned API v1 protocolVersion 2."

## Non-Goals

- Hosted Gemdex SaaS.
- Syncing local LanceDB or database files between machines.
- Scopes, tags, tenants, projects, workspaces, or per-repo memory buckets.
- End-to-end encryption claims. BYOI users own their deployment security, but
  Gemdex v1 does not claim E2EE.
- Background capture, automatic recall, or implicit session logging.
- A delete tool in MCP.
