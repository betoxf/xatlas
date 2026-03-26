#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT_DIR/.build/release/xatlas"
PORT="${XATLAS_MCP_PORT:-9012}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
MCP_URL="http://127.0.0.1:${PORT}/mcp"
LOG_FILE="/tmp/xatlas-headless-smoke.log"
TOKEN="headless-smoke-ok"
APP_PID=""

cleanup() {
  if [[ -n "$APP_PID" ]]; then
    kill "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd jq
require_cmd swift

mcp_call() {
  local payload="$1"
  local session_id="${2:-}"
  local protocol_version="${3:-}"
  local -a headers=(
    -H 'Content-Type: application/json'
  )
  if [[ -n "$session_id" ]]; then
    headers+=(-H "MCP-Session-Id: $session_id")
  fi
  if [[ -n "$protocol_version" ]]; then
    headers+=(-H "MCP-Protocol-Version: $protocol_version")
  fi

  curl -fsS -X POST "$MCP_URL" \
    "${headers[@]}" \
    -D - \
    -o /tmp/xatlas-headless-smoke-response.json \
    -w '\nHTTP_STATUS:%{http_code}' \
    -d "$payload"
}

extract_response_header() {
  local response="$1"
  local header_name="$2"
  printf '%s\n' "$response" | awk -F': ' -v key="$header_name" '
    BEGIN { IGNORECASE = 1 }
    $1 == key { gsub(/\r/, "", $2); print $2; exit }
  '
}

response_body() {
  local response="$1"
  if [[ "$response" != *"HTTP_STATUS:"* ]]; then
    return 1
  fi
  cat /tmp/xatlas-headless-smoke-response.json
}

tool_text() {
  local payload="$1"
  local session_id="$2"
  local protocol_version="$3"
  response_body "$(mcp_call "$payload" "$session_id" "$protocol_version")" | jq -r '.result.content[0].text'
}

initialize_mcp() {
  local response
  response="$(mcp_call '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}')"
  local session_id
  session_id="$(extract_response_header "$response" 'MCP-Session-Id')"
  local protocol_version
  protocol_version="$(extract_response_header "$response" 'MCP-Protocol-Version')"
  if [[ -z "$session_id" || -z "$protocol_version" ]]; then
    echo "failed to initialize MCP session" >&2
    exit 1
  fi

  response_body "$response" >/dev/null
  response_body "$(mcp_call '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' "$session_id" "$protocol_version")" >/dev/null

  printf '%s\n%s\n' "$session_id" "$protocol_version"
}

wait_for_health() {
  local attempts=50
  for ((i=0; i<attempts; i++)); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "xatlas MCP health check failed on port $PORT" >&2
  return 1
}

ensure_app_running() {
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    return 0
  fi

  if [[ ! -x "$BINARY" ]]; then
    (cd "$ROOT_DIR" && swift build -c release >/dev/null)
  fi

  XATLAS_MCP_PORT="$PORT" XATLAS_HEADLESS=1 "$BINARY" >"$LOG_FILE" 2>&1 &
  APP_PID="$!"
  wait_for_health
}

ensure_app_running

mapfile -t mcp_session < <(initialize_mcp)
SESSION_ID="${mcp_session[0]}"
PROTOCOL_VERSION="${mcp_session[1]}"

project_id="$(tool_text '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xatlas_project_list","arguments":{}}}' "$SESSION_ID" "$PROTOCOL_VERSION" | jq -r '.[] | select(.name=="xatlas") | .id' | head -n1)"
if [[ -z "$project_id" ]]; then
  echo "could not resolve xatlas project from xatlas_project_list" >&2
  exit 1
fi

tool_text "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"xatlas_project_select\",\"arguments\":{\"projectId\":\"$project_id\"}}}" "$SESSION_ID" "$PROTOCOL_VERSION"

create_response="$(tool_text "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"xatlas_terminal_create\",\"arguments\":{\"name\":\"headless-smoke\",\"cwd\":\"/Users/iPrado/xatlas\",\"projectId\":\"$project_id\",\"select\":true}}}" "$SESSION_ID" "$PROTOCOL_VERSION")"
session_id="$(printf '%s' "$create_response" | jq -r '.sessionId')"
if [[ -z "$session_id" || "$session_id" == "null" ]]; then
  echo "failed to create terminal session" >&2
  exit 1
fi

workspace_json="$(tool_text '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"xatlas_workspace_state","arguments":{}}}' "$SESSION_ID" "$PROTOCOL_VERSION")"
selected_session_id="$(printf '%s' "$workspace_json" | jq -r '.selectedSessionId')"
if [[ "$selected_session_id" != "$session_id" ]]; then
  echo "app selection did not move to new session: expected $session_id got $selected_session_id" >&2
  exit 1
fi

tool_text "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"xatlas_terminal_send\",\"arguments\":{\"sessionId\":\"$session_id\",\"command\":\"pwd && echo $TOKEN\"}}}" "$SESSION_ID" "$PROTOCOL_VERSION"

snapshot=""
for _ in {1..20}; do
  snapshot="$(tool_text "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"xatlas_terminal_snapshot\",\"arguments\":{\"sessionId\":\"$session_id\",\"lines\":80}}}" "$SESSION_ID" "$PROTOCOL_VERSION" | jq -r '.snapshot // empty')"
  if [[ "$snapshot" == *"$TOKEN"* ]]; then
    break
  fi
  sleep 0.25
done

if [[ "$snapshot" != *"$TOKEN"* ]]; then
  echo "expected token '$TOKEN' not found in snapshot" >&2
  exit 1
fi

printf 'headless smoke test passed\n'
printf 'session: %s\n' "$session_id"
printf '%s\n' "$snapshot"
