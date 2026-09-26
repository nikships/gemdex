# Contributing to Gemdex

Thanks for considering a contribution. Gemdex is built and maintained by people who'd rather not re-teach their agent the same thing every session, and we love any help making the memory layer better.

## Quick links

- 🐛 [Report a bug](https://github.com/nikships/gemdex/issues/new?template=bug_report.yml)
- ✨ [Request a feature](https://github.com/nikships/gemdex/issues/new?template=feature_request.yml)
- 💬 [Open a discussion](https://github.com/nikships/gemdex/discussions)
- 🟢 [`good first issue` label](https://github.com/nikships/gemdex/labels/good%20first%20issue)

## Before you start

For non-trivial changes, open a discussion or issue first so we can align on the approach. Small fixes (typos, obvious bugs, doc tweaks) can go straight to a PR.

## Dev setup

You need:

- Node.js ≥ 24
- pnpm ≥ 10 (`corepack enable && corepack prepare pnpm@latest --activate`)
- Native arm64 macOS 14+ for real local MLX inference. Unit tests use fixtures.
- Claude Code installed and logged in for real local ingestion/hygiene.
- A server-owned Google AI Studio key only for real BYOI embedding/upload tests.

```bash
git clone https://github.com/nikships/gemdex.git
cd gemdex
pnpm install
pnpm build
```

The memory store is embedded (LanceDB), so there's no daemon to start — it
persists at `~/.gemdex/lance` by default.

Use disposable storage fixtures in tests, not your personal memory pool.
`LANCEDB_PATH` overrides the local vector directory, not every blob/ledger path.
Local model installation is explicit (`npx gemdex-mcp install`); inference
does not download a runtime or model. Mock Claude Code in unit tests.

## Common commands

| Command | What it does |
|---------|--------------|
| `pnpm build` | Build every package |
| `pnpm dev` | Watch-build every package |
| `pnpm dev:mcp` | Run the MCP server in watch mode |
| `pnpm lint` | Run ESLint across packages |
| `pnpm lint:fix` | Autofix what ESLint can |
| `pnpm typecheck` | TypeScript `--noEmit` across packages |
| `pnpm -r test` | Run all package test suites |
| `pnpm clean` | Wipe `dist/` |

## Code style

- TypeScript strict mode. Treat warnings like errors.
- **Never** add `eslint-disable` to suppress a lint error — fix the underlying issue instead.
- Prefer nullish coalescing (`??`) over logical OR (`||`) for default-value patterns.
- Required configuration must fail fast at startup with a clear error — never silently fall back to a broken default.
- Keep public API surfaces (`gemdex-core` exports, MCP tool schemas) small and documented.

## Where things live

The monorepo is small — find the right layer before you change anything:

- `packages/core` (`gemdex-core`): local `MemoryStore`, `MlxEmbedding`,
  LanceDB hybrid retrieval, shared HTTP router, and inference. Server-side
  `GeminiEmbedding` and `SessionDigester` also live here.
- `packages/mcp` (`gemdex-mcp`): seven local stdio tools, local CLI, and
  `serve.ts`, the desktop's localhost sidecar.
- `packages/server`: BYOI `/v1`, Postgres/pgvector and server-owned embedding.
- `packages/mcp-http` and `packages/web`: Python HTTP clients for BYOI, serving
  agents and browsers respectively. Neither is an npx remote backend.
- `packages/app`: native SwiftUI local manager. No memory logic lives here.

When adding behaviour, add a unit test next to the code it covers.

## Commit / PR style

- Conventional Commits encouraged: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- One logical change per PR. Smaller is faster to land.
- Update the README and `CHANGELOG.md` for any user-visible behaviour change.
- Make sure `pnpm lint && pnpm typecheck && pnpm build && pnpm -r test` is green locally.

## Releasing (maintainers)

Release automation is in [`.github/workflows/release.yml`](.github/workflows/release.yml).

## BYOI integration

From the repository root, `pnpm test:byoi` runs
`packages/server/integration/byoi.mjs` after packages are built. Set
`BYOI_TEST_DATABASE_URL` to a dedicated disposable Postgres database with
pgvector. The harness uses deterministic embeddings and exercises server
`/v1` HTTP directly. CI calls it in **BYOI integration (Postgres + server)**.
Do not point it at a valuable database.

## Questions?

Open a [discussion](https://github.com/nikships/gemdex/discussions) — friendly, fast, and the right venue for "is this the right approach?" before you write a lot of code.
