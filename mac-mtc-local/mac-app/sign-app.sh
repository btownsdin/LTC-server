#!/usr/bin/env bash
# ============================================================================
# sign-app.sh — ad-hoc sign the built .app WITHOUT breaking mic access
# ============================================================================
# A plain `codesign --deep --sign -` strips the entitlements electron-builder
# applied, which stops a packaged app from getting microphone permission (it
# never prompts and never appears in System Settings → Microphone). This signs
# every nested binary and the app itself with the entitlements in
# build/entitlements.mac.plist, ad-hoc ("-" identity), so it runs on a Mac
# without an Apple Developer ID *and* can still request the mic.
#
# Usage:  bash sign-app.sh "dist/mac-universal/LTC to MTC.app"
#         (or mac-arm64 / mac-x64 — whatever `ls dist/` shows)
# ============================================================================
set -e
cd "$(dirname "$0")"

APP="${1:-}"
ENT="build/entitlements.mac.plist"

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "✗ Pass the path to the .app, e.g.:"
  echo '    bash sign-app.sh "dist/mac-universal/LTC to MTC.app"'
  echo "  Available builds:"; ls -1 dist 2>/dev/null | sed 's/^/    /' || echo "    (run npm run dist first)"
  exit 1
fi
if [ ! -f "$ENT" ]; then echo "✗ $ENT not found."; exit 1; fi

echo "• Clearing quarantine…"
xattr -cr "$APP" 2>/dev/null || true

# Sign nested code first (helpers, frameworks, dylibs), then the outer app.
echo "• Signing nested binaries…"
find "$APP/Contents/Frameworks" -type f \( -name "*.dylib" -o -name "*.node" \) 2>/dev/null | while read -r f; do
  codesign --force --sign - "$f" 2>/dev/null || true
done
find "$APP/Contents/Frameworks" -maxdepth 1 \( -name "*.app" -o -name "*.framework" \) 2>/dev/null | while read -r bundle; do
  codesign --force --options runtime --entitlements "$ENT" --sign - "$bundle" 2>/dev/null || \
  codesign --force --entitlements "$ENT" --sign - "$bundle" 2>/dev/null || true
done

echo "• Signing the app…"
codesign --force --options runtime --entitlements "$ENT" --sign - "$APP" 2>/dev/null || \
codesign --force --entitlements "$ENT" --sign - "$APP"

echo "• Verifying…"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -qi "audio-input" \
  && echo "  ✓ Signed with microphone entitlement." \
  || echo "  ⚠ Could not confirm the mic entitlement — it may still work with hardened runtime off."

echo "Done. Install with:  rm -rf \"/Applications/$(basename "$APP")\" && cp -R \"$APP\" /Applications/"
