# Contributing to Gemdex

Thanks for considering a contribution. Gemdex is built and maintained by people who'd rather not stuff entire repos into LLM prompts, and we love any help making semantic code search better.

## Quick links

- 🐛 [Report a bug](https://github.com/anand-92/gemdex/issues/new?template=bug_report.yml)
- ✨ [Request a feature](https://github.com/anand-92/gemdex/issues/new?template=feature_request.yml)
- 💬 [Open a discussion](https://github.com/anand-92/gemdex/discussions)
- 🟢 [`good first issue` label](https://github.com/anand-92/gemdex/labels/good%20first%20issue)

## Before you start

For non-trivial changes, open a discussion or issue first so we can align on the approach. Small fixes (typos, obvious bugs, doc tweaks) can go straight to a PR.

## Dev setup

You need:

- Node.js ≥ 20
- pnpm ≥ 10 (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker (for running Milvus locally)
- A Google AI Studio API key (free tier is fine for development)

```bash
git clone https://github.com/anand-92/gemdex.git
cd gemdex
pnpm install
pnpm build
```

Spin up Milvus using the `docker-compose.yml` snippet in the [README](README.md#1-get-milvus-running).

Set the env vars used by tests / dev runs:

```bash
export GEMINI_API_KEY=your-key
export MILVUS_ADDRESS=localhost:19530
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

## Adding a language

Most "add support for X" requests come down to a missing tree-sitter grammar:

1. Add the `tree-sitter-<language>` dependency in `packages/core/package.json`.
2. Register the grammar in `packages/core/src/splitter/`.
3. Add the file extensions to the default ignore/allow lists in `packages/core/src/context.ts`.
4. Add a small unit test that splits a sample file from that language.
5. Mention the new language in the README "AST-aware chunking" line.

## Commit / PR style

- Conventional Commits encouraged: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- One logical change per PR. Smaller is faster to land.
- Update the README and `CHANGELOG.md` for any user-visible behaviour change.
- Make sure `pnpm lint && pnpm typecheck && pnpm build && pnpm -r test` is green locally.

## Releasing (maintainers)

See [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) for the full release flow.

## Questions?

Open a [discussion](https://github.com/anand-92/gemdex/discussions) — friendly, fast, and the right venue for "is this the right approach?" before you write a lot of code.
