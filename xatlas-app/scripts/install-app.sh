#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_APP="$("$ROOT/scripts/package-app.sh" | tail -n 1)"
TARGET_APP="${XATLAS_APP_INSTALL_PATH:-/Applications/xatlas.app}"

pkill -f "$TARGET_APP/Contents/MacOS/xatlas" >/dev/null 2>&1 || true
osascript -e 'quit app "xatlas"' >/dev/null 2>&1 || true
sleep 0.5

mkdir -p "$(dirname "$TARGET_APP")"
rsync -a --delete "$SOURCE_APP/" "$TARGET_APP/"

echo "$TARGET_APP"
