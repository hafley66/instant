#!/usr/bin/env bash
# Vendor miniPaint (MIT, https://github.com/viliusle/miniPaint) into
# public/vendor/miniPaint for the Paint panel (src/paintPanel.tsx iframes it).
# Re-runnable: wipes and rebuilds the destination from a pinned tag.
set -euo pipefail

TAG="${1:-v4.14.3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/vendor/miniPaint"
TMP="$(mktemp -d /tmp/minipaint.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$TAG" https://github.com/viliusle/miniPaint.git "$TMP/src"
cd "$TMP/src"
npm ci --ignore-scripts
npm run build

rm -rf "$DEST"
mkdir -p "$DEST/images"
cp index.html "$DEST/"
cp -R dist "$DEST/dist"
# Only the runtime assets the bundle/index actually reference (skips the 3.5MB
# preview.gif and other repo-only art).
cp -R images/icons "$DEST/images/icons"
cp images/logo-colors.png images/logo.svg images/test-collection.json \
   images/favicon.png images/preview.jpg "$DEST/images/"

echo "vendored miniPaint $TAG -> public/vendor/miniPaint ($(du -sh "$DEST" | cut -f1))"
