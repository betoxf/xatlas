# xatlas

xatlas is the current evolution of the old operator-manager idea: a native workspace for running and supervising AI agents across your projects.

The Mac-side command runtime is **xatlas CLE**: the xatlas Command Line Environment. It is the terminal-facing bridge/runtime layer that pairs with the desktop app, relay, and iPhone client.

## Components

- `xatlas-app/`: native macOS workspace and MCP server
- `xatlas-bridge/`: xatlas CLE bridge/runtime package
- `relay/`: self-hostable relay for pairing and trusted reconnect
- `xatlas-ios/`: iPhone companion app
- `vscode-extension/`: legacy VS Code surface still being migrated under the xatlas brand

## Quick Start

```bash
cd xatlas-app
swift build
./scripts/launch-app.sh
```

For the bridge/runtime package:

```bash
cd xatlas-bridge
npm install
npm start
```
