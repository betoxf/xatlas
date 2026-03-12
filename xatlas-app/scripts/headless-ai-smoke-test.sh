#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${XATLAS_MCP_PORT:-9013}"

launch_output="$("$ROOT/scripts/launch-headless.sh")"
PID="$(printf '%s\n' "$launch_output" | sed -n '1p')"
APP_DIR="$(printf '%s\n' "$launch_output" | sed -n '2p')"
LOG_PATH="$(printf '%s\n' "$launch_output" | sed -n '4p')"

cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

python3 - "$PORT" <<'PY'
import json, sys, time, urllib.request

port = int(sys.argv[1])
base = f"http://127.0.0.1:{port}/mcp"

def rpc(payload, sid=None):
    headers = {"Content-Type": "application/json"}
    if sid:
        headers["MCP-Session-Id"] = sid
    req = urllib.request.Request(base, data=json.dumps(payload).encode(), headers=headers)
    with urllib.request.urlopen(req) as r:
        return dict(r.headers), r.read().decode()

headers, _ = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
sid = headers["MCP-Session-Id"]
rpc({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, sid)
_, body = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "xatlas_project_list", "arguments": {}}}, sid)
projects = {p["name"]: p for p in json.loads(json.loads(body)["result"]["content"][0]["text"])}
project = projects["xatlas"]

cases = [
    ("codex", "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'Reply with exactly CODEX_HEADLESS_OK'", "CODEX_HEADLESS_OK"),
    ("claude", "claude -p --dangerously-skip-permissions 'Reply with exactly CLAUDE_HEADLESS_OK'", "CLAUDE_HEADLESS_OK"),
    ("zai", "zai -p --dangerously-skip-permissions 'Reply with exactly ZAI_HEADLESS_OK'", "ZAI_HEADLESS_OK"),
]

results = []
for idx, (name, command, needle) in enumerate(cases, start=10):
    _, body = rpc({"jsonrpc": "2.0", "id": idx, "method": "tools/call", "params": {
        "name": "xatlas_terminal_create",
        "arguments": {"projectId": project["id"], "name": f"headless-{name}", "select": False}
    }}, sid)
    session = json.loads(json.loads(body)["result"]["content"][0]["text"])
    rpc({"jsonrpc": "2.0", "id": idx + 100, "method": "tools/call", "params": {
        "name": "xatlas_terminal_send",
        "arguments": {"sessionId": session["sessionId"], "command": command}
    }}, sid)

    snapshot = ""
    for attempt in range(18):
        time.sleep(2)
        _, snap = rpc({"jsonrpc": "2.0", "id": idx + 200 + attempt, "method": "tools/call", "params": {
            "name": "xatlas_terminal_snapshot",
            "arguments": {"sessionId": session["sessionId"], "lines": 140}
        }}, sid)
        snapshot = json.loads(json.loads(snap)["result"]["content"][0]["text"])["snapshot"]
        if needle in snapshot:
            results.append({"provider": name, "ok": True, "sessionId": session["sessionId"]})
            break
    else:
        results.append({"provider": name, "ok": False, "sessionId": session["sessionId"], "snapshot": snapshot[-1200:]})

_, feed = rpc({"jsonrpc": "2.0", "id": 999, "method": "tools/call", "params": {
    "name": "xatlas_operator_feed",
    "arguments": {"limit": 12}
}}, sid)

print(json.dumps({
    "results": results,
    "operatorFeed": json.loads(json.loads(feed)["result"]["content"][0]["text"])
}, indent=2))

if not all(item["ok"] for item in results):
    sys.exit(1)
PY

echo "headless ai smoke test passed"
echo "app: $APP_DIR"
echo "port: $PORT"
echo "log: $LOG_PATH"
