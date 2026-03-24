#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="xatlas.app"
BUILD_DIR="$ROOT/.build/arm64-apple-macosx/release"
APP_DIR="$ROOT/.dist/$APP_NAME"
MACOS_DIR="$APP_DIR/Contents/MacOS"
RESOURCES_DIR="$APP_DIR/Contents/Resources"
ICON_FILE="$ROOT/Resources/AppIcon.icns"
BRIDGE_DIR="$ROOT/../xatlas-bridge"
RELAY_DIR="$ROOT/../relay"
PLIST="$APP_DIR/Contents/Info.plist"
EXECUTABLE="$BUILD_DIR/xatlas"

cd "$ROOT"
"$ROOT/scripts/sync-brand-assets.sh" >&2
swift build -c release >&2

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cat >"$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>xatlas</string>
    <key>CFBundleIdentifier</key>
    <string>com.xatlas.app</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleName</key>
    <string>xatlas</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>26.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

cp "$EXECUTABLE" "$MACOS_DIR/xatlas"
chmod +x "$MACOS_DIR/xatlas"

if [ -f "$ICON_FILE" ]; then
    cp "$ICON_FILE" "$RESOURCES_DIR/AppIcon.icns"
fi

if [ -d "$BRIDGE_DIR" ]; then
    cp -R "$BRIDGE_DIR" "$RESOURCES_DIR/xatlas-bridge"
fi

if [ -d "$RELAY_DIR" ]; then
    cp -R "$RELAY_DIR" "$RESOURCES_DIR/relay"
fi

echo "$APP_DIR"
