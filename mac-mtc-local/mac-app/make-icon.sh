#!/usr/bin/env bash
# Generates build/icon.icns from a simple SVG using only macOS built-in tools.
# Run once before `npm run dist`. Safe to skip — electron-builder will use a
# default icon if build/icon.icns is absent.
set -e
cd "$(dirname "$0")"
mkdir -p build icon.iconset

cat > build/icon.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1c1f26"/>
      <stop offset="1" stop-color="#0d0f13"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="200" fill="url(#g)"/>
  <text x="512" y="430" font-family="Helvetica" font-weight="700" font-size="300"
        fill="#38d39f" text-anchor="middle">LTC</text>
  <text x="512" y="600" font-family="Helvetica" font-weight="700" font-size="120"
        fill="#8b93a1" text-anchor="middle">→</text>
  <text x="512" y="800" font-family="Helvetica" font-weight="700" font-size="300"
        fill="#e7eaef" text-anchor="middle">MTC</text>
</svg>
SVG

# Rasterise to PNG sizes. `qlmanage`/`sips` handle SVG on modern macOS; if SVG
# isn't supported, install librsvg (`brew install librsvg`) and swap in rsvg-convert.
for size in 16 32 64 128 256 512 1024; do
  sips -s format png -z $size $size build/icon.svg --out "icon.iconset/icon_${size}x${size}.png" >/dev/null 2>&1 || true
done
# Retina @2x variants
cp icon.iconset/icon_32x32.png    icon.iconset/icon_16x16@2x.png    2>/dev/null || true
cp icon.iconset/icon_64x64.png    icon.iconset/icon_32x32@2x.png    2>/dev/null || true
cp icon.iconset/icon_256x256.png  icon.iconset/icon_128x128@2x.png  2>/dev/null || true
cp icon.iconset/icon_512x512.png  icon.iconset/icon_256x256@2x.png  2>/dev/null || true
cp icon.iconset/icon_1024x1024.png icon.iconset/icon_512x512@2x.png 2>/dev/null || true

iconutil -c icns icon.iconset -o build/icon.icns && echo "✓ build/icon.icns created"
rm -rf icon.iconset
