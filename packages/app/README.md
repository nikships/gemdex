# Gemdex Memory — desktop app

A native, **manage-only** desktop app for the [Gemdex](https://github.com/anand-92/gemdex)
memory layer, built on [zero-native](https://www.npmjs.com/package/zero-native)
(a Zig desktop shell + web UI). It opens straight into your memory layer to
browse, create, edit, delete, export, and import memories.

The Storage settings panel can switch the sidecar between the embedded local
backend and a named BYOI Gemdex Server. Remote bearer tokens are accepted by
the UI only for the configuration request, persisted by the sidecar under
`~/.gemdex/.env`, and never returned to frontend JavaScript. The same panel can
test remote health/authentication and import local memories to the remote while
preserving ids.

There is **no free-text search box** — recall is an agent/MCP capability. This
app is a fast local manager. (It does offer recall-*by-example*: a "Find
similar" action on any attachment, which runs media recall against the sidecar.)

## Multimodal memories

Memories can carry inline media (image / audio / video / PDF). In the editor you
can drag-and-drop or pick files, give each a caption (which backs the BM25
keyword branch on recall), and remove them. The detail view renders images, an
audio player, a video player, and native inline PDF preview. Bytes are streamed
from the sidecar's `GET /memories/:id/attachments/:attachmentId` route; "Find
similar" posts the attachment to `POST /recall` for recall-by-media. Loading
local media into the WebView requires the relaxed `img-src` / `media-src` /
`frame-src` / `object-src` directives in `frontend/index.html`'s CSP (they allow
`http://127.0.0.1:*` and `blob:`); keep that policy as tight as these features
allow.

Remote mode still talks only to the localhost sidecar. The frontend must never
connect directly to a configured Gemdex Server, and the CSP must not be broadened
to arbitrary remote origins for `connect-src`, media, frames, or objects. The
sidecar owns outbound remote traffic because it can attach the stored bearer
token without exposing it to frontend JavaScript; the WebView receives only the
per-launch localhost base URL and request token. If a remote feature needs new
network access, add a localhost sidecar route instead of widening the CSP.

## Architecture

- **Zig shell** (`src/main.zig`): opens the window, applies the CSP /
  navigation policy, spawns the Node sidecar (`gemdex serve`) on launch,
  discovers the localhost port it bound (via the `PORT=<n>` handshake line),
  hands that base URL to the WebView through the `gemdex.getApiBase` bridge
  command, and kills the sidecar on exit. **No memory logic in Zig.**
- **Node sidecar** (`gemdex serve`, from the `gemdex-mcp` package): wraps
  `gemdex-core` + LanceDB and exposes a localhost HTTP/JSON manager API. Shares
  the same `~/.gemdex` store the MCP server uses, so memories saved by the agent
  show up here and vice-versa.
- **Web UI** (`frontend/`): plain Vite app that talks to the sidecar with
  `fetch`. Using localhost HTTP (not the Zig bridge) sidesteps the bridge's
  16 KiB cap, so a 300-line memory is never truncated.

The user never runs a sidecar command — the app spawns it automatically.

## Auto-updates (Sparkle)

The packaged macOS app ships with [Sparkle](https://sparkle-project.org) for
in-place auto-updates of the native shell + frontend. (The Node sidecar is
pulled fresh on each launch via `npx -y gemdex-mcp`, so Sparkle only updates
the `.app` itself.)

- **Init:** `src/sparkle_host.m` exposes `gemdex_sparkle_start()`, called from
  `main.zig`'s `start()` (on the main thread, Sparkle's required init point).
  It lazily creates and retains an `SPUStandardUpdaterController`; config comes
  entirely from Info.plist.
- **Framework:** vendored under `third_party/sparkle/` (gitignored; pinned to
  2.9.2, fetched in CI). `build.zig` compiles `sparkle_host.m`, links
  `Sparkle.framework`, and adds two rpaths: `@executable_path/../Frameworks`
  (packaged) and the source tree (so `zig build run` finds it).
- **Packaging:** `macos/embed-sparkle.sh` runs after `zig build package` and
  before the outer `codesign --deep`. It copies the framework into
  `Contents/Frameworks/`, injects `SUFeedURL` / `SUPublicEDKey` /
  `SUEnableAutomaticChecks` / `SUScheduledCheckInterval` into Info.plist, and
  codesigns Sparkle inside-out (XPC services + `Updater.app` + `Autoupdate`
  first, then the framework).
- **Feed:** the release workflow generates a `sign_update`-signed `appcast.xml`
  and publishes it alongside the DMG, so `SUFeedURL`
  (`…/releases/latest/download/appcast.xml`) always points at the newest build.
- **Keys:** the EdDSA public key lives in Info.plist (`embed-sparkle.sh`); the
  private key is the `SPARKLE_PRIVATE_KEY` GitHub Actions secret. Re-key with
  `third_party/sparkle/bin/generate_keys` and update both.

## Requirements

- **Zig 0.16** (the zero-native template targets 0.16 APIs).
- The **zero-native** framework. The build resolves it from
  `-Dzero-native-path=/path/to/zero-native`, then `packages/app/node_modules`,
  then the global npm root (`npm install -g zero-native`).
- A system Node (for `npx -y gemdex serve`), or set `GEMDEX_SERVE_CMD` to a
  local `gemdex-mcp` entry script for development.
- `GEMINI_API_KEY` in the environment (the sidecar embeds on create/edit).

## Commands

```sh
zig build run                 # build frontend + native shell, open the window
zig build dev                 # frontend dev server + native shell (HMR)
zig build test -Dplatform=null
zig build package             # self-contained app bundle
zero-native doctor --manifest app.zon --strict
```

## Dev against a local build

Point the shell at your local `gemdex-mcp` build so you don't need the published
package:

```sh
GEMDEX_SERVE_CMD=/abs/path/to/gemdex/packages/mcp/dist/index.js \
GEMINI_API_KEY=your-key \
zig build run
```

## Packaging note

Per the design, a release build should bundle the Node serve runtime (and the
per-platform LanceDB native binding) so the installed app launches with zero
user steps. The fallback used during development transparently invokes
`npx -y gemdex serve` when a system Node is present.
