#!/bin/sh
# Run the desktop dev app fully isolated from an installed ZCode.
# Some services resolve data paths from the home directory rather than
# ZCODE_DATA_BASE_DIR, so HOME is sandboxed as well. Electron's profile is
# already separate (Application Support/com.xatlas.desktop.development).
set -eu
SANDBOX="${ZCODE_SANDBOX_HOME:-$HOME/.zcode-xatlas-dev}"
mkdir -p "$SANDBOX"
# Demo mode (visual testing with seeded data): start signed out every time.
# A stale signed-out credentials file otherwise sends the app to the
# welcome screen instead of the workspace.
if [ "${ZCODE_SANDBOX_SIGNED_OUT:-0}" = "1" ]; then
  rm -f "$SANDBOX/.zcode/v2/credentials.json"
fi
# The release queue (`gh`) and the swarm (Claude Code, Codex, ... CLIs) run with
# the real home, where their logins and keychain live; nothing else in the
# sandbox sees it.
export XATLAS_GH_HOME="${XATLAS_GH_HOME:-$HOME}"
export ZCODE_DATA_BASE_DIR="$SANDBOX"
export HOME="$SANDBOX"
# Pin every nested `pnpm` call to the pnpm that ran this script (the repo's
# pinned version); a bare `pnpm` on PATH may be another major and refuse to run.
if [ -n "${npm_execpath:-}" ]; then
  SHIM_DIR="$SANDBOX/.bin"
  mkdir -p "$SHIM_DIR"
  case "$npm_execpath" in
    # A standalone pnpm is a native binary, not a script for node.
    *.js | *.cjs | *.mjs) printf '#!/bin/sh\nexec node "%s" "$@"\n' "$npm_execpath" > "$SHIM_DIR/pnpm" ;;
    *) printf '#!/bin/sh\nexec "%s" "$@"\n' "$npm_execpath" > "$SHIM_DIR/pnpm" ;;
  esac
  chmod +x "$SHIM_DIR/pnpm"
  export PATH="$SHIM_DIR:$PATH"
fi
exec pnpm dev:desktop "$@"
