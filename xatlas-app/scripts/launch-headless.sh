#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$("$ROOT/scripts/package-app.sh" | tail -n 1)"
PORT="${XATLAS_MCP_PORT:-9013}"
LOG_PATH="${XATLAS_HEADLESS_LOG:-/tmp/xatlas-headless.log}"

pkill -f "$APP_DIR/Contents/MacOS/xatlas" >/dev/null 2>&1 || true

XATLAS_HEADLESS=1 XATLAS_MCP_PORT="$PORT" \
  nohup "$APP_DIR/Contents/MacOS/xatlas" >"$LOG_PATH" 2>&1 &

PID=$!
echo "$PID"
echo "$APP_DIR"
echo "$PORT"
echo "$LOG_PATH"
