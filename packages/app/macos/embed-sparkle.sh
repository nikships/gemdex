#!/usr/bin/env bash
#
# Embed Sparkle into an assembled .app (see macos/build-app.sh), inject the
# updater Info.plist keys, and codesign the framework inside-out (XPC services
# + helpers first, then the framework, then — by the caller — the outer app).
#
# Run this after build-app.sh assembles the bundle and BEFORE the outer
# `codesign --deep` in release-macos.yml.
#
# Usage:
#   embed-sparkle.sh <path-to.app>
#
# Environment:
#   SIGN_IDENTITY   Developer ID Application identity (required; signs Sparkle).
#   SPARKLE_DIR     Path to vendored Sparkle (default: third_party/sparkle,
#                   relative to this script's package root).
#   SU_FEED_URL     Appcast feed URL (default: the gemdex desktop-latest asset).
#   SU_PUBLIC_ED_KEY            EdDSA public key (default: the committed key).
#   SU_CHECK_INTERVAL_SECONDS  Scheduled check interval (default: 86400 = daily).
#
set -euo pipefail

APP_PATH="${1:?usage: embed-sparkle.sh <path-to.app>}"
: "${SIGN_IDENTITY:?SIGN_IDENTITY is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPARKLE_DIR="${SPARKLE_DIR:-$PKG_ROOT/third_party/sparkle}"
SPARKLE_FRAMEWORK="$SPARKLE_DIR/Sparkle.framework"

SU_FEED_URL="${SU_FEED_URL:-https://github.com/anand-92/gemdex/releases/latest/download/appcast.xml}"
SU_PUBLIC_ED_KEY="${SU_PUBLIC_ED_KEY:-sB98dHKSN9fEe3vmVAufZoI4TbRWE6hHvAGSbzKweYM=}"
SU_CHECK_INTERVAL_SECONDS="${SU_CHECK_INTERVAL_SECONDS:-86400}"

if [ ! -d "$SPARKLE_FRAMEWORK" ]; then
  echo "::error::Sparkle.framework not found at $SPARKLE_FRAMEWORK" >&2
  echo "Fetch it first (see CI 'Fetch Sparkle' step or third_party/sparkle README)." >&2
  exit 1
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
FRAMEWORKS_DIR="$APP_PATH/Contents/Frameworks"
EMBEDDED_FRAMEWORK="$FRAMEWORKS_DIR/Sparkle.framework"

echo "==> Embedding Sparkle into $(basename "$APP_PATH")"
mkdir -p "$FRAMEWORKS_DIR"
rm -rf "$EMBEDDED_FRAMEWORK"
# -R preserves the symlink farm (Versions/Current, top-level aliases) Sparkle
# relies on; copying it flat breaks the framework signature.
cp -R "$SPARKLE_FRAMEWORK" "$FRAMEWORKS_DIR/"

echo "==> Injecting Sparkle keys into Info.plist"
plutil -replace SUFeedURL -string "$SU_FEED_URL" "$INFO_PLIST"
plutil -replace SUPublicEDKey -string "$SU_PUBLIC_ED_KEY" "$INFO_PLIST"
plutil -replace SUEnableAutomaticChecks -bool true "$INFO_PLIST"
plutil -replace SUScheduledCheckInterval -integer "$SU_CHECK_INTERVAL_SECONDS" "$INFO_PLIST"
plutil -lint "$INFO_PLIST"

# Inside-out signing: every nested executable must be signed before the thing
# that contains it, otherwise the outer `codesign --deep` seals stale/unsigned
# nested code and Gatekeeper rejects it. All Sparkle helpers get the hardened
# runtime so the notarized app stays valid.
VERSION_DIR="$EMBEDDED_FRAMEWORK/Versions/Current"
sign() {
  echo "    sign: ${1#"$APP_PATH/"}"
  codesign --force --sign "$SIGN_IDENTITY" --options runtime --timestamp "$1"
}

echo "==> Signing Sparkle (inside-out)"
sign "$VERSION_DIR/XPCServices/Downloader.xpc"
sign "$VERSION_DIR/XPCServices/Installer.xpc"
sign "$VERSION_DIR/Updater.app/Contents/MacOS/Updater"
sign "$VERSION_DIR/Updater.app"
sign "$VERSION_DIR/Autoupdate"
sign "$EMBEDDED_FRAMEWORK"

echo "==> Verifying embedded Sparkle signature"
codesign --verify --deep --strict --verbose=2 "$EMBEDDED_FRAMEWORK"

# NOTE: sign the outer .app with macos/sign-app.sh, which signs each nested
# Mach-O individually (NOT `--deep`). A blanket `--deep` re-sign would clobber
# the JIT entitlements on the bundled Node binary and crash the notarized app.
echo "==> Done embedding Sparkle. Next: macos/sign-app.sh signs the outer .app."
