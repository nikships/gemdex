#!/usr/bin/env bash
#
# Stage a self-contained Node runtime + the gemdex sidecar into a directory so
# the packaged .app launches with ZERO user-installed dependencies. The Swift
# SidecarManager prefers this bundled runtime over any system node/npx.
#
# Layout produced under <dest>:
#   node/bin/node                  — official Node arm64 runtime
#   sidecar/dist/index.js          — gemdex-mcp entry (`serve`)
#   sidecar/node_modules/...       — gemdex-core + gemdex-mcp + prod deps
#
# Usage:
#   stage-sidecar.sh <dest-resources-dir>
#
# Environment:
#   NODE_VERSION   Node runtime to bundle (default: the running node's version).
#
set -euo pipefail

DEST="${1:?usage: stage-sidecar.sh <dest-resources-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

NODE_DIR="$DEST/node"
SIDECAR_DIR="$DEST/sidecar"

NODE_VERSION="${NODE_VERSION:-$(node -p 'process.version.slice(1)')}"
ARCH="arm64"

echo "==> Staging sidecar runtime into $DEST (Node v$NODE_VERSION, $ARCH)"
rm -rf "$NODE_DIR" "$SIDECAR_DIR"
mkdir -p "$NODE_DIR" "$SIDECAR_DIR"

# 1) Download the official Node runtime (macOS arm64) and keep just bin + lib.
NODE_PKG="node-v${NODE_VERSION}-darwin-${ARCH}"
NODE_TARBALL="${NODE_PKG}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Downloading $NODE_URL"
curl -fsSL "$NODE_URL" -o "$WORK/$NODE_TARBALL"
tar -xzf "$WORK/$NODE_TARBALL" -C "$WORK"
cp -R "$WORK/$NODE_PKG/bin" "$NODE_DIR/bin"
# lib holds nothing we need for `node` itself; npm is not bundled (the app never
# installs at runtime when the sidecar is bundled). Keep the tree minimal.
test -x "$NODE_DIR/bin/node" || { echo "::error::bundled node missing"; exit 1; }
"$NODE_DIR/bin/node" --version

# 2) Pack gemdex-core + gemdex-mcp from the workspace and install them (prod
#    deps only) into the sidecar dir, so LanceDB's native arm64 binding and the
#    Google GenAI client are all present offline.
PACKS="$WORK/packs"
mkdir -p "$PACKS"
echo "==> Packing gemdex-core + gemdex-mcp"
pnpm --dir "$REPO_ROOT" --filter gemdex-core pack --pack-destination "$PACKS"
pnpm --dir "$REPO_ROOT" --filter gemdex-mcp pack --pack-destination "$PACKS"
CORE_PACK="$(ls "$PACKS"/gemdex-core-*.tgz | head -1)"
MCP_PACK="$(ls "$PACKS"/gemdex-mcp-*.tgz | head -1)"
test -f "$CORE_PACK" && test -f "$MCP_PACK" || { echo "::error::pack tarballs missing"; exit 1; }

echo "==> Installing sidecar (prod deps only)"
# Use the bundled node's npm if present, else system npm. npm ships with the
# downloaded Node tarball under lib/node_modules — wire it up for this step.
if [ -d "$WORK/$NODE_PKG/lib/node_modules/npm" ]; then
  cp -R "$WORK/$NODE_PKG/lib" "$NODE_DIR/lib"
fi
NPM_BIN="$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
if [ -f "$NPM_BIN" ]; then
  "$NODE_DIR/bin/node" "$NPM_BIN" install --prefix "$SIDECAR_DIR" --omit=dev "$CORE_PACK" "$MCP_PACK"
else
  npm install --prefix "$SIDECAR_DIR" --omit=dev "$CORE_PACK" "$MCP_PACK"
fi

# 3) Expose the gemdex-mcp entry at sidecar/dist/index.js so the Swift manager's
#    fixed path resolves regardless of npm's nesting.
MCP_MODULE="$SIDECAR_DIR/node_modules/gemdex-mcp"
test -f "$MCP_MODULE/dist/index.js" || { echo "::error::gemdex-mcp dist missing after install"; exit 1; }
cp -R "$MCP_MODULE/dist" "$SIDECAR_DIR/dist"
cp "$MCP_MODULE/package.json" "$SIDECAR_DIR/package.json"

# 4) Trim the bundled npm again now that install is done — the app never needs
#    it at runtime. Keep node_modules (the deps) but drop the npm CLI to shrink.
rm -rf "$NODE_DIR/lib"

# 5) Prune obvious dev cruft to keep the DMG small.
find "$SIDECAR_DIR" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name doc -o -name example -o -name examples \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$SIDECAR_DIR" -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.tsbuildinfo' -o -name '*.md' -o -name '*.markdown' \) -delete 2>/dev/null || true

echo "==> Sidecar staged:"
echo "    node:    $("$NODE_DIR/bin/node" --version)"
echo "    entry:   $SIDECAR_DIR/dist/index.js"
du -sh "$DEST" 2>/dev/null || true
echo "==> Done."
