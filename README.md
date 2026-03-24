# xatlas CLE

xatlas CLE is the public CLI/runtime layer for xatlas. It starts the local service, prints the pairing QR, reconnects to the relay, and forwards activity into the native xatlas macOS app.

## Install

```bash
brew tap betoxf/tap
brew install betoxf/tap/xatlas
```

After install:

```bash
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

- `xatlas-bridge/` is the current public CLI/runtime package
- `relay/` is optional and only matters if you want to self-host pairing/reconnect
- `xatlas-ios/` is still in progress and is not part of the main install story yet
- `tmux/` and `ghostty/` are vendored sources, not something you need to install separately for the Homebrew flow

## Source Checkout

```bash
cd xatlas-bridge
npm install
node ./bin/xatlas-bridge.js up
```

Useful environment variables:

- `XATLAS_RELAY`: override the relay URL used by the runtime
- `XATLAS_PUSH_SERVICE_URL`: point completion pushes at a custom service
- `XATLAS_REFRESH_ENABLED`: enable desktop refresh hooks for the macOS app
- `XATLAS_MCP_PORT`: force the xatlas macOS app MCP port when needed
