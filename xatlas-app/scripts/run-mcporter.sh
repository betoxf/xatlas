#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_PATH="${MCPORTER_CONFIG:-$REPO_ROOT/config/mcporter.json}"
MCPORTER_VERSION="${MCPORTER_VERSION:-0.8.0}"

if [ $# -eq 0 ]; then
  set -- list xatlas
fi

exec npx -y "mcporter@${MCPORTER_VERSION}" --config "$CONFIG_PATH" "$@"
