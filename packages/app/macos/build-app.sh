#!/usr/bin/env bash
#
# Build the native Swift app and assemble a complete macOS .app bundle:
# compiled binary, Info.plist, icon, brand assets, startup intro video, and
# (optionally) the bundled Node sidecar runtime + Sparkle framework.
#
# Reproducible locally (CommandLineTools + SwiftPM) and in CI (full Xcode).
#
# Usage:
#   build-app.sh [--with-sidecar] [--out <dir>]
#
# Environment:
#   GEMDEX_SPARKLE=1   Link Sparkle (release/signed builds). Requires the
#                      framework under third_party/sparkle (CI fetches it).
#   APP_VERSION        CFBundleShortVersionString (default: read from VERSION).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_ROOT"

OUT_DIR="$PKG_ROOT/build"
WITH_SIDECAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-sidecar) WITH_SIDECAR=1; shift ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

APP_NAME="Gemdex Memory"
BUNDLE_ID="com.gemdex.memory"
APP_VERSION="${APP_VERSION:-$(cat "$PKG_ROOT/VERSION" 2>/dev/null || echo 0.4.0)}"
APP="$OUT_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"
EXEC_NAME="GemdexMemory"

echo "==> Building Gemdex Memory $APP_VERSION (sparkle=${GEMDEX_SPARKLE:-0}, sidecar=$WITH_SIDECAR)"

# 1) Compile the Swift binary (release, arm64).
swift build -c release --arch arm64
BIN_PATH="$(swift build -c release --arch arm64 --show-bin-path)/$EXEC_NAME"
test -x "$BIN_PATH" || { echo "::error::swift build produced no $EXEC_NAME binary"; exit 1; }

# 2) Lay out the bundle skeleton.
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RES_DIR"
cp "$BIN_PATH" "$MACOS_DIR/$EXEC_NAME"

# 3) Info.plist.
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key><string>$EXEC_NAME</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
    <key>CFBundleVersion</key><string>$APP_VERSION</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>A global, persistent memory layer for AI coding agents.</string>
</dict>
</plist>
PLIST

# 4) Icon.
if [ -f "$PKG_ROOT/assets/icon.icns" ]; then
  cp "$PKG_ROOT/assets/icon.icns" "$RES_DIR/icon.icns"
fi

# 5) Brand assets + startup intro video (read by the SwiftUI views at runtime).
mkdir -p "$RES_DIR/brand"
BRAND_SRC="$PKG_ROOT/assets/brand"
for png in logo-mark wordmark empty-chest logo-mark-256; do
  [ -f "$BRAND_SRC/$png.png" ] && cp "$BRAND_SRC/$png.png" "$RES_DIR/brand/$png.png" || true
  [ -f "$BRAND_SRC/$png.png" ] && cp "$BRAND_SRC/$png.png" "$RES_DIR/$png.png" || true
done
if [ -f "$PKG_ROOT/assets/startup-intro.mp4" ]; then
  cp "$PKG_ROOT/assets/startup-intro.mp4" "$RES_DIR/startup-intro.mp4"
fi

# 6) Optional bundled sidecar (Node runtime + gemdex serve).
if [ "$WITH_SIDECAR" = "1" ]; then
  bash "$SCRIPT_DIR/stage-sidecar.sh" "$RES_DIR"
fi

echo "==> Assembled: $APP"
echo "    binary:  $MACOS_DIR/$EXEC_NAME"
echo "    version: $APP_VERSION"
ls -la "$RES_DIR" | sed 's/^/    /'
