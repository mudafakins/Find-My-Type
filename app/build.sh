#!/bin/zsh
# Build "Find My Type.app" (universal: Apple Silicon + Intel) into app/dist/.
#
#   ./build.sh          build the app
#   ./build.sh --zip    also create dist/Find-My-Type-Mac.zip (the file GitHub Releases serve)
#   ./build.sh --open   build and launch it
#
# Version comes from app/VERSION. Updates are checked against the GitHub repository in
# $UPDATE_REPO ("owner/repo"); if unset, it's read from this repo's "origin" remote.
set -euo pipefail

HERE="${0:A:h}"
DIST="$HERE/dist"
APP="$DIST/Find My Type.app"
BUILD="$DIST/.build"
MIN_MACOS="12.0"
VERSION="$(tr -d '[:space:]' < "$HERE/VERSION")"
BUILD_NUMBER="$(git -C "$HERE" rev-list --count HEAD 2>/dev/null || echo 1)"

# owner/repo from $UPDATE_REPO, or from the git remote (https or ssh form)
if [[ -z "${UPDATE_REPO:-}" ]]; then
  REMOTE="$(git -C "$HERE" remote get-url origin 2>/dev/null || true)"
  UPDATE_REPO="$(print -r -- "$REMOTE" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  [[ "$UPDATE_REPO" == */* && "$UPDATE_REPO" != *://* ]] || UPDATE_REPO=""
fi

echo "→ Building Find My Type $VERSION (build $BUILD_NUMBER)${UPDATE_REPO:+ — updates from github.com/$UPDATE_REPO}"
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
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$APP/Contents/Info.plist"
plutil -replace FMTUpdateRepo -string "$UPDATE_REPO" "$APP/Contents/Info.plist"
cp "$HERE/native/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$HERE/web/index.html" "$HERE/web/styles.css" "$HERE/web/app.js" "$HERE/web/fonts.js" "$APP/Contents/Resources/web/"

echo "→ Signing (ad-hoc, local only)"
codesign --force --deep --sign - "$APP"

rm -rf "$BUILD"
echo "✓ Built: $APP"

for flag in "$@"; do
  case "$flag" in
    --zip)
      (cd "$DIST" && rm -f "Find-My-Type-Mac.zip" && ditto -c -k --keepParent "Find My Type.app" "Find-My-Type-Mac.zip")
      echo "✓ Zipped: $DIST/Find-My-Type-Mac.zip" ;;
    --open)
      open "$APP" ;;
  esac
done
