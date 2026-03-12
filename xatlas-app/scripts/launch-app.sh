#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$("$ROOT/scripts/package-app.sh" | tail -n 1)"

OPEN_ARGS=(-na)
if [[ "${1:-}" == "--background" ]]; then
  OPEN_ARGS=(-g -na)
fi

open "${OPEN_ARGS[@]}" "$APP_DIR"
echo "$APP_DIR"
