# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

xatlas is a monorepo centered on the native xatlas workspace and **xatlas CLE** (Command Line Environment), the terminal/runtime layer that powers pairing, relay access, and agent orchestration.

- **`xatlas-app/`** — Native macOS app (Swift 6.2, macOS 26). Terminal multiplexer with built-in MCP server for AI agent control.
- **`xatlas-bridge/`** — xatlas CLE bridge/runtime package for pairing, relay access, and desktop service flows.
- **`xatlas-ios/`** — iPhone companion app for remote access and mobile control.
- **`vscode-extension/`** — Legacy VS Code surface still carrying older package IDs while the visible branding migrates to xatlas.

The main xatlas surfaces expose HTTP-based MCP servers (JSON-RPC) and use tmux for terminal session management. The `ghostty/` and `tmux/` directories are vendored upstream sources for reference only — they are not built as part of xatlas.

## Build Commands

### Swift App (`xatlas-app/`)
```bash
cd xatlas-app && swift build                    # Debug build
cd xatlas-app && swift build -c release         # Release build
xatlas-app/scripts/package-app.sh               # Build + assemble .dist/xatlas.app bundle
xatlas-app/scripts/launch-app.sh [normal|background|minimized]  # Build + launch
xatlas-app/scripts/headless-smoke-test.sh       # Smoke test (headless mode)
```

### VS Code Extension (`vscode-extension/`)
```bash
cd vscode-extension && npm install              # Install dependencies
cd vscode-extension && npm run build            # esbuild → dist/extension.js + dist/webview/terminal.js
cd vscode-extension && npm run watch            # Incremental rebuild
cd vscode-extension && npm run lint             # ESLint
```

No unit test suites exist in either component. Testing is via shell smoke tests in `xatlas-app/scripts/`.

## Architecture

### MCP Server Pattern (both components)

Both the Swift app and VS Code extension run local HTTP MCP servers:

- **Swift app**: `MCPServer` uses `NWListener` (Network.framework, no external HTTP deps). Default port 9012 (env `XATLAS_MCP_PORT`), tries ports 9012–9017. State persisted to `~/Library/Application Support/xatlas/mcp-server.json`.
- **VS Code extension**: Node `http` module. Default port 9002, tries 9002–9015.
- **stdio bridge**: `xatlas-app/scripts/mcp-stdio-bridge.js` adapts stdio MCP transport (used by Claude Code) to the Swift app's HTTP server. Reads active port from the persisted state file.

Endpoints: `GET /health`, `GET /mcp` (SSE), `POST /mcp` (JSON-RPC), `DELETE /mcp`.

### Swift App Architecture (`xatlas-app/xatlas/`)

**Singletons use `nonisolated(unsafe) static let shared`** — required for Swift 6 strict concurrency when using NWListener/DispatchQueue callbacks. Classes that need to satisfy Sendable for callback contexts use `@unchecked Sendable`.

Key layers:
- **App/**: `XatlasApp` (@main) + `AppDelegate` (window creation, MCP lifecycle)
- **Models/**: `AppState` (@Observable singleton, project/tab/selection state), `Project`, `Session`, `AppPreferences`
- **Services/**: `TerminalService` (session lifecycle), `TmuxService` (tmux subprocess, socket `xatlas`, session prefix `xatlas_`), `GitService`, `FileService`, `ProjectManager` (JSON persistence), `AISyncService`, `AgentCatalogService`, `MCPAuthoringService`
- **MCP/**: `MCPServer` → `MCPHandler` → `ToolRegistry` → tool groups (`TerminalTools`, `OperatorTools`, `FileTools`)
- **Views/**: SwiftUI views — `MainView` → `SidebarView` + `ContentAreaView` (tabs). Terminal rendering via `NativeTmuxTerminalView` (NSViewRepresentable wrapping SwiftTerm)
- **Theme/**: `GlassEffects` (macOS .glassEffect), `Typography`

Launch modes controlled by `XATLAS_LAUNCH_MODE` env var: `normal`, `background` (.accessory activation), `minimized`, `headless`.

### VS Code Extension Architecture (`vscode-extension/src/`)

- **`extension.ts`**: Activation, registers commands/providers, starts server
- **`server/index.ts`**: HTTP server with REST endpoints + JSON-RPC dispatch
- **`tools/`**: MCP tool implementations — `dashboardTools.ts` (card terminals, primary), `terminalTools.ts` (tmux-backed), `codeTools.ts`, `editorTools.ts`, `fileTools.ts`, `debugTools.ts`, `workspaceTools.ts`
- **`services/`**: `tmuxManager.ts` (session prefix `xvsc_`), `tmuxStreamBridge.ts`, `terminalWatcher.ts`, `agentDiscovery.ts` (detects Claude/Zai/Codex/Aider), `openRouterService.ts` (AI terminal naming)
- **`dashboard/`**: `DashboardPanel.ts` (webview), `DashboardViewProvider.ts` (sidebar). Uses xterm.js for in-webview terminal rendering.

Build: esbuild produces two bundles — `extension.js` (CJS, node) and `webview/terminal.js` (IIFE, browser).

### tmux Integration

Both components use tmux for terminal session management but with different prefixes/sockets:
- Swift app: socket `-L xatlas`, session prefix `xatlas_`
- VS Code extension: default socket, session prefix `xvsc_` + 6-char workspace fingerprint

## Key Dependencies

| Component | Dependency | Purpose |
|-----------|-----------|---------|
| Swift app | SwiftTerm | Terminal emulation (NSView) |
| Swift app | Network.framework | NWListener HTTP server |
| VS Code ext | @xterm/xterm ^6.0 | Terminal rendering in webview |
| VS Code ext | node-pty ^1.1 | PTY management |
| VS Code ext | zod ^3.22 | Runtime schema validation |

## Conventions

- Swift strict concurrency (Swift 6): all cross-isolation boundaries must be Sendable. Use `@unchecked Sendable` on classes only when needed for framework callbacks (NWListener, DispatchQueue).
- MCP tool names: Swift app uses `xatlas_` prefix, VS Code extension uses `vscode_` prefix.
- The `.mcp.json` at repo root configures Claude Code's MCP connections (filesystem server + xatlas native app).
- `vscode-extension/CLAUDE.md` is an AI agent prompt/tool reference, not a developer guide.
