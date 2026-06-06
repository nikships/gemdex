#!/usr/bin/env bash
#
# Deep-sign an assembled Gemdex Memory.app for Developer ID distribution.
#
# Signs inside-out so every nested Mach-O is sealed before the thing that
# contains it (Gatekeeper/notarization reject stale or unsigned nested code):
#
#   1. Bundled sidecar native libraries (*.node, *.dylib) — hardened runtime.
#   2. The bundled Node runtime binary — hardened runtime PLUS the JIT
#      entitlements V8 needs (allow-jit, allow-unsigned-executable-memory),
#      otherwise the notarized, hardened process aborts the moment it starts.
#   3. The outer .app — hardened runtime + entitlements. No `--deep`: every
#      nested executable is already signed individually above and by
#      embed-sparkle.sh, so a blanket re-sign would only risk clobbering the
#      sidecar's JIT entitlements with the app's.
#
# Sparkle must already be embedded + signed (macos/embed-sparkle.sh) before
# this runs.
#
# Usage:
#   sign-app.sh <path-to.app>
#
# Environment:
#   SIGN_IDENTITY   Developer ID Application identity (required).
#   ENTITLEMENTS    Path to entitlements plist (default: macos/entitlements.plist).
#
set -euo pipefail

APP_PATH="${1:?usage: sign-app.sh <path-to.app>}"
: "${SIGN_IDENTITY:?SIGN_IDENTITY is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="${ENTITLEMENTS:-$SCRIPT_DIR/entitlements.plist}"
test -f "$ENTITLEMENTS" || { echo "::error::entitlements not found at $ENTITLEMENTS"; exit 1; }

RES_DIR="$APP_PATH/Contents/Resources"
EXEC_NAME="GemdexMemory"

sign_hardened() {
  echo "    sign (hardened): ${1#"$APP_PATH/"}"
  codesign --force --sign "$SIGN_IDENTITY" --options runtime --timestamp "$1"
}

sign_jit() {
  echo "    sign (hardened+jit): ${1#"$APP_PATH/"}"
  codesign --force --sign "$SIGN_IDENTITY" --options runtime \
    --entitlements "$ENTITLEMENTS" --timestamp "$1"
}

if [ -d "$RES_DIR/sidecar" ]; then
  echo "==> Signing bundled sidecar native libraries"
  # Sign deepest paths first so frameworks/bundles seal already-signed members.
  while IFS= read -r -d '' macho; do
    sign_hardened "$macho"
  done < <(find "$RES_DIR/sidecar" \( -name '*.node' -o -name '*.dylib' \) -print0 | sort -rz)
fi

if [ -x "$RES_DIR/node/bin/node" ]; then
  echo "==> Signing bundled Node runtime (with JIT entitlements)"
  sign_jit "$RES_DIR/node/bin/node"
fi

echo "==> Signing outer app (hardened runtime + entitlements)"
codesign --force --sign "$SIGN_IDENTITY" --options runtime \
  --entitlements "$ENTITLEMENTS" --timestamp \
  "$APP_PATH"

echo "==> Verifying outer signature"
codesign --verify --strict --verbose=2 "$APP_PATH"
codesign --display --entitlements - "$APP_PATH/Contents/MacOS/$EXEC_NAME" 2>/dev/null || true

echo "==> Done signing $(basename "$APP_PATH")."
