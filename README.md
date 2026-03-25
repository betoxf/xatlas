# xatlas CLE

This repo is the renamed continuation of the old `xerebro-operator-manager` project.

xatlas CLE (Command Line Environment) is a fusion between an IDE and a CLI.

It grew out of the earlier extension and became the next natural step: a native interface for the way I actually build. You can keep as many projects and folders open as you need from one place, move between them quickly, create another workspace or terminal when needed, and share skills, MCPs, and automations across the whole environment without needing a five-monitor setup.

The `xatlas` CLI is the install and runtime entrypoint for that environment. It starts the local service, prints the pairing QR when needed, reconnects to the relay, and keeps the native xatlas macOS app in sync with your sessions.

## Install

Primary CLI install:

```bash
npm install -g xatlas-bridge
xatlas up
```

Homebrew install:

```bash
brew tap betoxf/tap
brew install betoxf/tap/xatlas
xatlas up
```

The package keeps `xatlas-cle` and `xatlas-bridge` as compatibility aliases, but `xatlas` is the primary command name now.

## Commands

- `xatlas up`: start the normal runtime flow and print pairing information when needed
- `xatlas run`: run the foreground runtime directly
- `xatlas start`: install or start the macOS background service
- `xatlas stop`: stop the macOS background service
- `xatlas status`: show the macOS background service state
- `xatlas reset-pairing`: clear local pairing state and require a fresh QR bootstrap
- `xatlas resume`: reopen the last active thread
- `xatlas watch [threadId]`: tail the persisted rollout for a thread

## Repo Notes

- `xatlas-app/` is the native macOS CLE shell for managing projects, terminals, MCPs, skills, and automations
- `xatlas-bridge/` is the CLI/runtime package users install as `xatlas`
- `relay/` is optional and only matters if you want to self-host pairing/reconnect
- `xatlas-ios/` is the mobile companion app for the same runtime
- `tmux/` and `ghostty/` are vendored sources, not something you need to install separately for the Homebrew flow

## Source Checkout

```bash
./xatlas-app/scripts/install-app.sh
open -na /Applications/xatlas.app
xatlas up
```

Useful environment variables:

- `XATLAS_RELAY`: override the relay URL used by the runtime
- `XATLAS_PUSH_SERVICE_URL`: point completion pushes at a custom service
- `XATLAS_REFRESH_ENABLED`: enable desktop refresh hooks for the macOS app
- `XATLAS_MCP_PORT`: force the xatlas macOS app MCP port when needed
