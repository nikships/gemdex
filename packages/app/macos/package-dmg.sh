#!/usr/bin/env bash
#
# Package a (already signed + notarized + stapled) .app into a signed,
# notarized, and stapled .dmg.
#
# Usage:
#   package-dmg.sh <path-to.app> <output.dmg>
#
# Environment:
#   SIGN_IDENTITY   Developer ID Application identity (required)
#   APPLE_ID        Apple ID for notarization (required)
#   APPLE_PASSWORD  App-specific password for notarization (required)
#   APPLE_TEAM_ID   Apple Developer Team ID (required)
#   VOLUME_NAME     DMG volume name (default: "Gemdex Memory")
#
set -euo pipefail

APP_PATH="${1:?usage: package-dmg.sh <path-to.app> <output.dmg>}"
DMG_PATH="${2:?usage: package-dmg.sh <path-to.app> <output.dmg>}"
VOLUME_NAME="${VOLUME_NAME:-Gemdex Memory}"

: "${SIGN_IDENTITY:?SIGN_IDENTITY is required}"
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_PASSWORD:?APPLE_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

APP_NAME="$(basename "$APP_PATH")"

echo "==> Building DMG ($VOLUME_NAME) from $APP_NAME"
rm -f "$DMG_PATH"
create-dmg \
  --volname "$VOLUME_NAME" \
  --window-pos 200 120 \
  --window-size 600 400 \
  --icon-size 100 \
  --icon "$APP_NAME" 175 190 \
  --hide-extension "$APP_NAME" \
  --app-drop-link 425 190 \
  "$DMG_PATH" \
  "$APP_PATH"

echo "==> Signing DMG"
codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG_PATH"

echo "==> Notarizing DMG"
xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "==> Stapling DMG"
xcrun stapler staple "$DMG_PATH"

echo "==> Verifying DMG"
spctl --assess -vv --type install "$DMG_PATH" || true
xcrun stapler validate "$DMG_PATH"

echo "==> Done: $DMG_PATH"
