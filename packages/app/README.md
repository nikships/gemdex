# Gemdex Memory — desktop app

> **Maintenance-only.** This app is no longer the primary way to manage a Gemdex
> memory layer. It manages a **local** `~/.gemdex` pool on a single Mac; the
> [web manager](../web/README.md) is the surface for a self-hosted deployment —
> any browser, behind your Google login, against the shared pool. The app still
> works and still ships; expect bug fixes, not new features.

A native, **manage-only** desktop app for the [Gemdex](https://github.com/nikships/gemdex)
memory layer, built in **SwiftUI** for macOS (Apple Silicon). It opens straight
into your local memory layer to browse, create, edit, delete, search, export,
and import memories.

## Local-only

The app manages the local `~/.gemdex` store on this Mac. There is no remote or
server mode and no API key.

- **Embeddings** run on this Mac with BGE-M3 on MLX (text only). On first run
  the setup screen offers an explicit, confirmed install of the MLX runtime and
  model (about 600 MB, Apple Silicon required). The memory manager unlocks once
  the model is installed.
- **Storage & Models** settings show the local model status and the install
  control. When memories saved with the previous Gemini embedding model remain,
  a notice offers a confirmed **Migrate N memories** action that re-embeds them
  locally.
- **Chat-history ingestion and memory hygiene** run on your local
  [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI
  (`claude -p` with the Haiku model). Both stay disabled until Claude Code is
  installed and signed in; the panels explain what is missing and offer
  **Check again**. Set `GEMDEX_CLAUDE_PATH` if `claude` is not on your PATH.
  Scan results show an estimate at API list price; a Claude subscription login
  is not billed per token.

Pressing Return in the sidebar search box runs semantic free-text recall
against the local store; typing alone filters loaded titles.

History ingestion is **always new-sessions-only**. Scans report previously
ingested sessions that later changed, but the UI exposes no override and the
core engine never includes those sessions in a run.

## Attachments

Memories are text. Ingested digests keep the full session transcript as a
read-only file attachment (`text/plain` or `application/x-ndjson`). The editor
lists attachments with their kind and size and can open or save each one;
bytes are streamed from `GET /memories/:id/attachments/:attachmentId`. The app
does not add, caption, or preview media, and older memories with image, audio,
video, or PDF attachments show those as plain downloadable files.

## Architecture

- **SwiftUI app** (`Sources/GemdexMemory/`): a native AppKit/SwiftUI window. It
  brings up the Node sidecar (`gemdex serve`), parses the
  `PORT=<n> TOKEN=<hex>` handshake line it prints to stdout, talks to it over
  localhost HTTP/JSON (`Services/APIClient.swift`), and tears it down on exit
  (`Services/SidecarManager.swift`). It owns the full sidecar lifecycle
  (probe / start / bundled-launch) but holds **no memory logic** — that lives in
  `gemdex-core`/`gemdex-mcp`.
- **Node sidecar** (`gemdex serve`, from the `gemdex-mcp` package): wraps
  `gemdex-core` + LanceDB and exposes a localhost HTTP/JSON manager API. Shares
  the same `~/.gemdex` store the MCP server uses, so memories saved by the agent
  show up here and vice-versa. Every request carries the per-launch
  `X-Gemdex-Token`; the server binds `127.0.0.1` only.

### Sidecar launch (no silent installs)

`SidecarManager.start()` picks a launch mode and the UI drives onboarding from
the published `phase`:

- **dev** — `GEMDEX_SERVE_CMD` set → run that Node entry directly.
- **bundled** — a release `.app` ships its own Node runtime + sidecar under
  `Contents/Resources/{node,sidecar}` (see *Zero-dependency packaging*). Launch
  prefers this and needs **no** user-installed Node.
- **probe** — otherwise, if `node` + `npx` resolve on the login-shell PATH, try
  `npx --offline gemdex-mcp serve` (cache-only, zero network). Handshake OK ⇒
  `ready`; cache miss ⇒ `needsBootstrap`.
- **needsNode** — no bundled runtime and no `node`/`npx` on PATH; the recovery
  screen shows an actionable error.

A user-approved bootstrap (`bootstrap(install:true)`) runs `npx -y gemdex-mcp
serve` (the one permitted network install) on a background thread and drops a
non-secret marker at `~/.gemdex/desktop.json`. Bundled release builds never need
this path.

## Zero-dependency packaging

A release `.app` is fully self-contained — a user on any Apple-Silicon Mac can
download the DMG and run the app with **zero** manual dependency installation:

- `macos/build-app.sh --with-sidecar` compiles the Swift binary, assembles the
  `.app`, and calls `macos/stage-sidecar.sh`, which downloads the official Node
  arm64 runtime and installs the packed `gemdex-core` + `gemdex-mcp` (prod deps
  only, including LanceDB's native arm64 binding) under
  `Contents/Resources/{node,sidecar}`.
- `macos/sign-app.sh` deep-signs every nested Mach-O: the bundled `*.node` /
  `*.dylib` (hardened runtime), the Node binary (hardened runtime **plus** the
  `allow-jit` / `allow-unsigned-executable-memory` entitlements V8 needs), then
  the outer app.

## Auto-updates (Sparkle)

The packaged macOS app ships with [Sparkle](https://sparkle-project.org) for
in-place auto-updates of the `.app`. Sparkle only updates the app bundle; the
bundled sidecar is updated by shipping a new DMG.

- **Init:** `Services/UpdaterController.swift` wraps Sparkle's
  `SPUStandardUpdaterController`, compiled only when `GEMDEX_SPARKLE=1`
  (`#if SPARKLE_ENABLED`). Local/dev/screenshot builds omit Sparkle entirely so
  no framework is required.
- **Framework:** vendored under `third_party/sparkle/` (gitignored; pinned to
  2.9.2, fetched in CI). `Package.swift` links `Sparkle.framework` and adds the
  `@executable_path/../Frameworks` rpath when `GEMDEX_SPARKLE=1`.
- **Packaging:** `macos/embed-sparkle.sh` runs after `build-app.sh` and before
  the outer sign. It copies the framework into `Contents/Frameworks/`, injects
  `SUFeedURL` / `SUPublicEDKey` / `SUEnableAutomaticChecks` /
  `SUScheduledCheckInterval` into Info.plist, and codesigns Sparkle inside-out
  (XPC services + `Updater.app` + `Autoupdate` first, then the framework).
- **Feed:** the release workflow generates a `sign_update`-signed `appcast.xml`
  and publishes it alongside the DMG, so `SUFeedURL`
  (`…/releases/latest/download/appcast.xml`) always points at the newest build.
- **Keys:** the EdDSA public key lives in Info.plist (`embed-sparkle.sh`); the
  private key is the `SPARKLE_PRIVATE_KEY` GitHub Actions secret. Re-key with
  `third_party/sparkle/bin/generate_keys` and update both.

## Requirements (development)

- A **Swift 5.9+** toolchain (Xcode or CommandLineTools). The build uses
  SwiftPM (`swift build`) and a shell script to assemble the bundle, so a full
  Xcode/`xcodebuild` install is not required.
- A system Node (for `npx -y gemdex serve`), or set `GEMDEX_SERVE_CMD` to a
  local `gemdex-mcp` entry script for development.
- An Apple Silicon Mac for the local MLX embedding model.
- Optionally, the Claude Code CLI (signed in) for chat-history ingestion and
  memory hygiene.

## Commands

```sh
# Build the .app bundle (no Sparkle, no bundled sidecar — fast dev loop):
bash macos/build-app.sh

# Build a self-contained release bundle (bundled Node + sidecar):
bash macos/build-app.sh --with-sidecar

# Build with Sparkle linked (requires third_party/sparkle):
GEMDEX_SPARKLE=1 bash macos/build-app.sh --with-sidecar

# Compile only (no bundle):
swift build -c release --arch arm64
```

## Dev against a local build

Point the app at your local `gemdex-mcp` build so you don't need the published
package or a bundled sidecar:

```sh
GEMDEX_SERVE_CMD=/abs/path/to/gemdex/packages/mcp/dist/index.js \
"build/Gemdex Memory.app/Contents/MacOS/GemdexMemory"
```

## Release

The unified `.github/workflows/release.yml` runs on every push to `main` (and
via manual dispatch). It first patch-bumps the repo-wide version (the root
`VERSION` file, stamped into every package by `scripts/sync-version.mjs`), then
its `macos` job builds the bundled `.app`, embeds + signs Sparkle, deep-signs
the bundle, notarizes + staples, builds + notarizes the DMG, generates a signed
`appcast.xml`, and publishes both to a versioned `v<version>` GitHub release
marked as `latest`. `make_latest: true` keeps the `…/releases/latest/download/`
URLs baked into the app's `SUFeedURL` pointed at the newest build, and because
the version increments every release, Sparkle reliably detects the update. The
same workflow publishes `gemdex-core`/`gemdex-mcp`/`gemdex-server` to npm and
GitHub Packages at that identical version.
