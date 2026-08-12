#!/usr/bin/env bash
# ============================================================================
# fix-electron.sh — let unsigned Electron run in dev on a locked-down Mac
# ============================================================================
# On recent macOS (esp. managed/corporate Macs), the stock Electron binary that
# `npm install` downloads is unsigned + quarantined, so Gatekeeper flags it as
# "malware" and moves it to Trash. This clears the quarantine flag and applies
# an ad-hoc code signature (the "-" identity), which gives the binary a valid
# signature so Gatekeeper stops killing it. Run once after every install/update
# of Electron. Safe to re-run.
# ============================================================================
set -e
cd "$(dirname "$0")"

APP="node_modules/electron/dist/Electron.app"

if [ ! -d "$APP" ]; then
  echo "✗ $APP not found."
  echo "  Electron isn't installed (or macOS already trashed it)."
  echo "  Run:  rm -rf node_modules/electron && npm install electron@31 --save-dev"
  echo "  then run this script again BEFORE 'npm start'."
  exit 1
fi

echo "• Clearing quarantine flags…"
xattr -cr "$APP" 2>/dev/null || true

echo "• Applying ad-hoc code signature (this can take a few seconds)…"
codesign --force --deep --sign - "$APP" 2>/dev/null || {
  echo "  codesign failed — you may need Xcode command-line tools:"
  echo "    xcode-select --install"
  exit 1
}

echo "• Verifying signature…"
codesign --verify --deep --strict "$APP" 2>/dev/null && echo "  ✓ Electron is signed (ad-hoc) and ready." \
  || echo "  ⚠ Verify reported issues, but launch may still work."

echo "Done. Now run:  npm start"
