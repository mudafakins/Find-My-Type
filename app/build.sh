#!/bin/zsh
# Build "Find My Type.app" (universal: Apple Silicon + Intel) into app/dist/.
#
#   ./build.sh          build the app
#   ./build.sh --zip    also create dist/Find My Type Mac.zip
#   ./build.sh --open   build and launch it
set -euo pipefail

HERE="${0:A:h}"
DIST="$HERE/dist"
APP="$DIST/Find My Type.app"
BUILD="$DIST/.build"
MIN_MACOS="12.0"

echo "→ Cleaning"
rm -rf "$APP" "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web" "$BUILD"

echo "→ Compiling Swift (arm64 + x86_64)"
for arch in arm64 x86_64; do
  swiftc -O \
    -target "$arch-apple-macos$MIN_MACOS" \
    -module-cache-path "$BUILD/module-cache" \
    -o "$BUILD/FindMyType-$arch" \
    "$HERE/native/FindMyType.swift"
done
lipo -create "$BUILD/FindMyType-arm64" "$BUILD/FindMyType-x86_64" -output "$APP/Contents/MacOS/FindMyType"

echo "→ Copying resources"
cp "$HERE/native/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/native/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$HERE/web/index.html" "$HERE/web/styles.css" "$HERE/web/app.js" "$HERE/web/fonts.js" "$APP/Contents/Resources/web/"

echo "→ Signing (ad-hoc, local only)"
codesign --force --deep --sign - "$APP"

rm -rf "$BUILD"
echo "✓ Built: $APP"

for flag in "$@"; do
  case "$flag" in
    --zip)
      (cd "$DIST" && rm -f "Find My Type Mac.zip" && ditto -c -k --keepParent "Find My Type.app" "Find My Type Mac.zip")
      echo "✓ Zipped: $DIST/Find My Type Mac.zip" ;;
    --open)
      open "$APP" ;;
  esac
done
