#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BRANDING_DIR="$REPO_ROOT/branding"
SOURCE_PNG="$BRANDING_DIR/xatlascle-iOS-Default-1024x1024@1x.png"

IOS_ASSETS_DIR="$REPO_ROOT/xatlas-ios/CodexMobile/Assets.xcassets"
IOS_APPLOGO_DIR="$IOS_ASSETS_DIR/AppLogo.imageset"
IOS_APPICON_DIR="$IOS_ASSETS_DIR/Remodex.appiconset"

MACOS_RESOURCES_DIR="$REPO_ROOT/xatlas-app/Resources"
MACOS_ICON_FILE="$MACOS_RESOURCES_DIR/AppIcon.icns"

if [[ ! -f "$SOURCE_PNG" ]]; then
  echo "missing branding PNG at $SOURCE_PNG" >&2
  exit 1
fi

mkdir -p "$IOS_APPLOGO_DIR" "$IOS_APPICON_DIR" "$MACOS_RESOURCES_DIR"

cp "$SOURCE_PNG" "$IOS_APPLOGO_DIR/AppLogo.png"

resize_png() {
  local size="$1"
  local output="$2"
  sips -s format png -z "$size" "$size" "$SOURCE_PNG" --out "$output" >/dev/null
}

resize_png 40 "$IOS_APPICON_DIR/iphone-notification-20@2x.png"
resize_png 60 "$IOS_APPICON_DIR/iphone-notification-20@3x.png"
resize_png 58 "$IOS_APPICON_DIR/iphone-settings-29@2x.png"
resize_png 87 "$IOS_APPICON_DIR/iphone-settings-29@3x.png"
resize_png 80 "$IOS_APPICON_DIR/iphone-spotlight-40@2x.png"
resize_png 120 "$IOS_APPICON_DIR/iphone-spotlight-40@3x.png"
resize_png 120 "$IOS_APPICON_DIR/iphone-app-60@2x.png"
resize_png 180 "$IOS_APPICON_DIR/iphone-app-60@3x.png"

resize_png 20 "$IOS_APPICON_DIR/ipad-notification-20@1x.png"
resize_png 40 "$IOS_APPICON_DIR/ipad-notification-20@2x.png"
resize_png 29 "$IOS_APPICON_DIR/ipad-settings-29@1x.png"
resize_png 58 "$IOS_APPICON_DIR/ipad-settings-29@2x.png"
resize_png 40 "$IOS_APPICON_DIR/ipad-spotlight-40@1x.png"
resize_png 80 "$IOS_APPICON_DIR/ipad-spotlight-40@2x.png"
resize_png 76 "$IOS_APPICON_DIR/ipad-app-76@1x.png"
resize_png 152 "$IOS_APPICON_DIR/ipad-app-76@2x.png"
resize_png 167 "$IOS_APPICON_DIR/ipad-pro-app-83_5@2x.png"
cp "$SOURCE_PNG" "$IOS_APPICON_DIR/ios-marketing-1024@1x.png"

TMP_DIR="$(mktemp -d)"
ICONSET_DIR="$TMP_DIR/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"

resize_png 16 "$ICONSET_DIR/icon_16x16.png"
resize_png 32 "$ICONSET_DIR/icon_16x16@2x.png"
resize_png 32 "$ICONSET_DIR/icon_32x32.png"
resize_png 64 "$ICONSET_DIR/icon_32x32@2x.png"
resize_png 128 "$ICONSET_DIR/icon_128x128.png"
resize_png 256 "$ICONSET_DIR/icon_128x128@2x.png"
resize_png 256 "$ICONSET_DIR/icon_256x256.png"
resize_png 512 "$ICONSET_DIR/icon_256x256@2x.png"
resize_png 512 "$ICONSET_DIR/icon_512x512.png"
cp "$SOURCE_PNG" "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$MACOS_ICON_FILE"
rm -rf "$TMP_DIR"

echo "synced branding assets from $SOURCE_PNG"
