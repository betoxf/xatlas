#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$("$ROOT/scripts/install-app.sh" | tail -n 1)"

mode="${1:-normal}"

# Always kill previous xatlas instances before launching
pkill -f "$APP_DIR/Contents/MacOS/xatlas" >/dev/null 2>&1 || true
osascript -e 'quit app "xatlas"' >/dev/null 2>&1 || true
sleep 0.5

case "$mode" in
  normal)
    open -na "$APP_DIR"
    echo "$APP_DIR"
    ;;
  --background|background)
    LOG_PATH="${XATLAS_APP_LOG:-/tmp/xatlas-app-background.log}"
    XATLAS_LAUNCH_MODE=background \
      nohup "$APP_DIR/Contents/MacOS/xatlas" >"$LOG_PATH" 2>&1 &
    PID=$!
    echo "$PID"
    echo "$APP_DIR"
    echo "$LOG_PATH"
    ;;
  --minimized|minimized)
    LOG_PATH="${XATLAS_APP_LOG:-/tmp/xatlas-app-minimized.log}"
    XATLAS_LAUNCH_MODE=minimized \
      nohup "$APP_DIR/Contents/MacOS/xatlas" >"$LOG_PATH" 2>&1 &
    PID=$!
    echo "$PID"
    echo "$APP_DIR"
    echo "$LOG_PATH"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
