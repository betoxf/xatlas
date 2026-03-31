#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCPORTER_VERSION="${MCPORTER_VERSION:-0.8.0}"
CLI_NAME="${XATLAS_MCPORTER_CLI_NAME:-xatlasctl}"
OUTPUT_DIR="${1:-$REPO_ROOT/output/mcporter}"
BRIDGE_SCRIPT="$REPO_ROOT/xatlas-app/scripts/mcp-stdio-bridge.js"
TS_OUTPUT="$OUTPUT_DIR/$CLI_NAME.ts"
BUNDLE_OUTPUT="$OUTPUT_DIR/$CLI_NAME.cjs"

mkdir -p "$OUTPUT_DIR"

exec npx -y "mcporter@${MCPORTER_VERSION}" generate-cli \
  --command "node $BRIDGE_SCRIPT" \
  --name "$CLI_NAME" \
  --description "CLI wrapper for the local xatlas.app MCP server" \
  --runtime node \
  --bundler rolldown \
  --output "$TS_OUTPUT" \
  --bundle "$BUNDLE_OUTPUT"
