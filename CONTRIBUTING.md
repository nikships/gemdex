# Contributing to Gemdex

Thanks for considering a contribution. Gemdex is built and maintained by people who'd rather not re-teach their agent the same thing every session, and we love any help making the memory layer better.

## Quick links

- 🐛 [Report a bug](https://github.com/anand-92/gemdex/issues/new?template=bug_report.yml)
- ✨ [Request a feature](https://github.com/anand-92/gemdex/issues/new?template=feature_request.yml)
- 💬 [Open a discussion](https://github.com/anand-92/gemdex/discussions)
- 🟢 [`good first issue` label](https://github.com/anand-92/gemdex/labels/good%20first%20issue)

## Before you start

For non-trivial changes, open a discussion or issue first so we can align on the approach. Small fixes (typos, obvious bugs, doc tweaks) can go straight to a PR.

## Dev setup

You need:

- Node.js ≥ 24
- pnpm ≥ 10 (`corepack enable && corepack prepare pnpm@latest --activate`)
- A Google AI Studio API key (free tier is fine for development)

```bash
git clone https://github.com/anand-92/gemdex.git
cd gemdex
pnpm install
pnpm build
```

The memory store is embedded (LanceDB), so there's no daemon to start — it
persists at `~/.gemdex/lance` by default.

Set the env vars used by tests / dev runs:

```bash
export GEMINI_API_KEY=your-key
# Optional: override the default LanceDB location
# export LANCEDB_PATH=/tmp/gemdex-dev
```

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

- `packages/core` (`gemdex-core`) — the engine: `GeminiEmbedding`,
  `LanceDBVectorDatabase` (hybrid dense + BM25 + RRF), and `memory/` (the
  `MemoryStore` + parent-document chunker). Reuse these layers; don't reach
  around `MemoryStore` for store access.
- `packages/mcp` (`gemdex-mcp`) — the MCP stdio server (the three tools) plus
  `serve.ts`, the localhost HTTP sidecar that backs the desktop app.
- `packages/app` — the native SwiftUI macOS desktop manager (Apple Silicon).
  No memory logic lives in the app.

When adding behaviour, add a unit test next to the code it covers.

## Commit / PR style

- Conventional Commits encouraged: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- One logical change per PR. Smaller is faster to land.
- Update the README and `CHANGELOG.md` for any user-visible behaviour change.
- Make sure `pnpm lint && pnpm typecheck && pnpm build && pnpm -r test` is green locally.

## Releasing (maintainers)

See [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) for the full release flow.

## Questions?

Open a [discussion](https://github.com/anand-92/gemdex/discussions) — friendly, fast, and the right venue for "is this the right approach?" before you write a lot of code.
