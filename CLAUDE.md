# Xerebro VS Code MCP Extension

## Overview

This VS Code extension provides an MCP (Model Context Protocol) server that enables AI agents to fully control VS Code. It runs an HTTP server on `localhost:9002` that exposes VS Code functionality via MCP tools and REST endpoints.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      VS Code Extension                          │
├─────────────────────────────────────────────────────────────────┤
│  HTTP Server (localhost:9002)                                   │
│  ├── /mcp              - MCP JSON-RPC endpoint                  │
│  ├── /health           - Health check                           │
│  ├── /dashboard/*      - Dashboard REST APIs                    │
│  └── /action-log       - AI activity log                        │
├─────────────────────────────────────────────────────────────────┤
│  Services                                                       │
│  ├── TerminalWatcher   - Tracks terminals & command history     │
│  ├── TmuxManager       - Tmux-backed terminal control           │
│  ├── ActionLog         - Logs all MCP tool calls                │
│  ├── AgentDiscovery    - Discovers AI agents in terminals       │
│  └── NotificationService - Desktop notifications                │
├─────────────────────────────────────────────────────────────────┤
│  Dashboard (Webview)                                            │
│  ├── Project cards with terminal previews                       │
│  ├── AI agent status indicators                                 │
│  └── Terminal output rendering (xterm.js)                       │
└─────────────────────────────────────────────────────────────────┘
```

## Supported AI Agents (Terminal-Based)

These AI coding agents run in VS Code terminals but are rendered as webviews with enhanced UI:

| Agent | Commands | Skip Permission Flag | Color |
|-------|----------|---------------------|-------|
| **Claude Code** | `claude`, `cc` | `--dangerously-skip-permissions` | `#ff6b00` (Orange) |
| **Zed AI (Zai)** | `zai`, `z ai` | `--dangerously-skip-permissions` | `#0ea5e9` (Blue) |
| **OpenCode** | `opencode`, `oc` | N/A (auto-approve mode) | `#22c55e` (Green) |
| **Codex** | `codex` | `--full-auto` | `#a855f7` (Purple) |
| **Aider** | `aider` | `--yes` | `#eab308` (Yellow) |

### Starting Agents

```bash
# Claude Code - full autonomous mode
claude --dangerously-skip-permissions

# Zed AI - full autonomous mode
zai --dangerously-skip-permissions

# OpenCode - autonomous coding
opencode

# Codex (OpenAI) - full auto mode
codex --full-auto

# Aider - auto-confirm changes
aider --yes
```

## System Prompt for AI Agents

When using this extension, AI agents should include the following in their system prompt:

```
You have access to VS Code through the Xerebro MCP extension. This allows you to:

1. **Control Terminals**: Create, send commands, and read output from VS Code terminals
2. **Manage Projects**: Add projects to the dashboard and track their status
3. **Monitor AI Agents**: See what other AI agents are doing in the workspace
4. **Track Your Actions**: All your MCP tool calls are logged and visible in the dashboard

### Key Capabilities:
- Create tmux-backed terminals for reliable output capture (50,000 line scrollback)
- Execute commands and capture their output with exit codes
- Monitor terminal state (idle, running, waiting for input)
- View dashboard state and other agent activities

### Important Notes:
- Terminals you create are marked as "AI-created" and visible in the dashboard
- Your command history is tracked as a "conversation" that users can review
- Use tmux-backed terminals for long-running tasks (they persist even if VS Code restarts)
- The dashboard shows real-time terminal output with ANSI color rendering

### Available MCP Tools:
- Terminal: vscode_terminal_create, vscode_terminal_send, vscode_terminal_execute, vscode_terminal_read_buffer
- Dashboard: vscode_dashboard_list_projects, vscode_dashboard_create_terminal, vscode_dashboard_get_state
- Monitoring: vscode_terminal_monitor_status, vscode_action_log_get, vscode_mcp_created_terminals
- History: vscode_terminal_command_history
```

## MCP Tools Reference

### Terminal Tools

#### `vscode_terminal_create`
Create a new terminal with optional tmux backing for enhanced buffer capture.

```json
{
  "name": "vscode_terminal_create",
  "arguments": {
    "name": "Build Terminal",
    "cwd": "/path/to/project",
    "useTmux": true,
    "show": false
  }
}
```

#### `vscode_terminal_send`
Send text/command to a terminal.

```json
{
  "name": "vscode_terminal_send",
  "arguments": {
    "name": "Build Terminal",
    "text": "npm run build",
    "addNewLine": true
  }
}
```

#### `vscode_terminal_execute`
Execute a command and capture its output with exit code.

```json
{
  "name": "vscode_terminal_execute",
  "arguments": {
    "command": "npm test",
    "name": "Test Terminal",
    "maxWait": 60000,
    "tailLines": 100
  }
}
```

#### `vscode_terminal_run_quick`
Quick command execution optimized for fast commands.

```json
{
  "name": "vscode_terminal_run_quick",
  "arguments": {
    "command": "git status",
    "lines": 50,
    "timeout": 5000
  }
}
```

#### `vscode_terminal_read_buffer`
Read terminal output from buffer (uses tmux for 50K line scrollback).

```json
{
  "name": "vscode_terminal_read_buffer",
  "arguments": {
    "name": "Build Terminal",
    "lines": 100,
    "stripAnsiCodes": true,
    "search": "error"
  }
}
```

#### `vscode_terminal_list`
List all open terminals with their status.

```json
{
  "name": "vscode_terminal_list",
  "arguments": {}
}
```

### Dashboard Tools

#### `vscode_dashboard_create_terminal`
Create a tmux-backed terminal for a project (AI-created, visible in dashboard).

```json
{
  "name": "vscode_dashboard_create_terminal",
  "arguments": {
    "projectPath": "/Users/user/my-project",
    "name": "AI Worker",
    "show": false
  }
}
```

#### `vscode_dashboard_get_state`
Get complete dashboard state including all terminals and their output.

```json
{
  "name": "vscode_dashboard_get_state",
  "arguments": {
    "includeTerminalOutput": true,
    "outputLines": 30
  }
}
```

#### `vscode_dashboard_list_projects`
List all projects tracked in the dashboard.

```json
{
  "name": "vscode_dashboard_list_projects",
  "arguments": {
    "sortBy": "activity",
    "includeTerminals": true
  }
}
```

### AI Activity Tracking

#### `vscode_mcp_created_terminals`
List all terminals created by AI (MCP).

```json
{
  "name": "vscode_mcp_created_terminals",
  "arguments": {
    "includeHistory": true,
    "includeOutput": true,
    "outputLines": 20
  }
}
```

#### `vscode_terminal_command_history`
Get the command history ("conversation") for a terminal.

```json
{
  "name": "vscode_terminal_command_history",
  "arguments": {
    "processId": 12345,
    "limit": 50,
    "includeOutput": true,
    "filterSource": "mcp"
  }
}
```

#### `vscode_action_log_get`
Get history of all MCP tool calls.

```json
{
  "name": "vscode_action_log_get",
  "arguments": {
    "limit": 50,
    "status": "success",
    "toolName": "terminal"
  }
}
```

#### `vscode_action_log_stats`
Get statistics about MCP tool usage.

```json
{
  "name": "vscode_action_log_stats",
  "arguments": {}
}
```

### Terminal Monitoring

#### `vscode_terminal_monitor_status`
Get status of all monitored terminals.

```json
{
  "name": "vscode_terminal_monitor_status",
  "arguments": {
    "filterState": "waiting_input",
    "filterAgent": "claude"
  }
}
```

Terminal states:
- `idle` - Terminal is at prompt, ready for input
- `processing` - Command is running
- `waiting_input` - Waiting for user input (password, y/n, etc.)
- `completed` - Task completed
- `error` - Error occurred
- `context_warning` - AI context usage is high

## REST API Endpoints

### Health & Info
- `GET /health` - Server health check
- `GET /dashboard/info` - Workspace info with terminal summary

### Terminals
- `GET /dashboard/terminals` - All terminals with output
- `GET /dashboard/terminals/mcp` - Only AI-created terminals
- `GET /dashboard/terminal/{pid}/history` - Command history for a terminal
- `POST /dashboard/terminal/{pid}/send` - Send command to terminal

### Action Log
- `GET /action-log` - Full action history with stats
- `GET /action-log/stats` - Action statistics only

## Usage Examples

### Example 1: AI Creates a Build Terminal

```javascript
// 1. Create a tmux-backed terminal for building
const createResult = await mcp.callTool("vscode_dashboard_create_terminal", {
  projectPath: "/Users/user/my-app",
  name: "AI Build Worker",
  show: false  // Keep it in background
});

// 2. Run the build command
const buildResult = await mcp.callTool("vscode_terminal_execute", {
  command: "npm run build",
  name: "AI Build Worker",
  maxWait: 120000,  // 2 minutes
  tailLines: 200
});

// 3. Check the result
if (buildResult.exitCode === 0) {
  console.log("Build succeeded!");
} else {
  console.log("Build failed:", buildResult.output);
}
```

### Example 2: Monitor Other AI Agents

```javascript
// Get status of all AI terminals
const status = await mcp.callTool("vscode_terminal_monitor_status", {
  filterAgent: "claude"
});

// Check if any are waiting for input
const waiting = status.needsAttention.filter(t => t.state === "waiting_input");
if (waiting.length > 0) {
  console.log("AI needs attention:", waiting);
}
```

### Example 3: Review AI Command History

```javascript
// List AI-created terminals
const terminals = await mcp.callTool("vscode_mcp_created_terminals", {
  includeHistory: true
});

// Get full command history for a terminal
const history = await mcp.callTool("vscode_terminal_command_history", {
  processId: terminals.terminals[0].processId,
  includeOutput: true
});

// See what commands the AI ran
history.commands.forEach(cmd => {
  console.log(`[${cmd.source}] ${cmd.command} -> ${cmd.status}`);
});
```

### Example 4: Quick Status Checks

```javascript
// Run quick commands without creating new terminals
const gitStatus = await mcp.callTool("vscode_terminal_run_quick", {
  command: "git status --short",
  timeout: 5000
});

const npmOutdated = await mcp.callTool("vscode_terminal_run_quick", {
  command: "npm outdated",
  timeout: 10000
});
```

## Command History ("Conversation") Feature

When AI agents use MCP to control terminals, all commands are tracked:

```typescript
interface TerminalCommand {
  id: string;           // Unique command ID
  command: string;      // The command text
  timestamp: number;    // When it was sent
  source: 'mcp' | 'user' | 'unknown';  // Who sent it
  output?: string;      // Captured output
  exitCode?: number;    // Exit code
  duration?: number;    // Execution time in ms
  status: 'pending' | 'completed' | 'error';
}
```

This creates a "conversation" view where users can see:
- What commands the AI ran
- When they ran
- What the output was
- Whether they succeeded or failed

## Configuration

### MCP Server Config (claude_desktop_config.json)

```json
{
  "mcpServers": {
    "vscode": {
      "command": "curl",
      "args": ["-s", "-X", "POST", "-H", "Content-Type: application/json", "-d", "@-", "http://localhost:9002/mcp"],
      "env": {}
    }
  }
}
```

Or use the bundled MCP bridge:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "node",
      "args": ["/path/to/extension/dist/mcp-stdio-bridge.js"],
      "env": {}
    }
  }
}
```

### Extension Settings

- `mcpServer.autoStart`: Start MCP server automatically (default: true)
- `mcpServer.port`: Server port (default: 9002)
- `mcpServer.host`: Server host (default: 127.0.0.1)

## Dashboard Features

The dashboard provides a visual overview of:

1. **Project Cards**: Shows tracked projects with their status
2. **Terminal Previews**: Real-time terminal output with ANSI colors
3. **AI Agent Indicators**: Visual markers for detected AI agents
4. **Activity Status**: Running, idle, waiting for input states
5. **AI-Created Badges**: Shows which terminals were created by AI

### Terminal Rendering

Terminals are rendered using xterm.js in the webview, supporting:
- Full ANSI color codes
- Unicode characters
- Clickable links
- Copy/paste
- Scrollback buffer

## Troubleshooting

### Server Not Starting
1. Check if port 9002 is available
2. Look for errors in VS Code Output > "MCP Server"
3. Try restarting VS Code

### Tmux Not Available
Install tmux for enhanced terminal features:
```bash
# macOS
brew install tmux

# Linux
apt install tmux
```

### Terminal Output Not Captured
- Ensure tmux is installed for 50K line scrollback
- Without tmux, only ~50KB of output is captured in memory
- Use `vscode_terminal_execute` for reliable output capture

### AI Agent Not Detected
- Agent detection looks for keywords in terminal name and output
- Supported agents: Claude, Zai, OpenCode, Codex, Aider
- Unknown agents show as "generic"

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Lint
npm run lint
```

## File Structure

```
src/
├── extension.ts           # Extension entry point
├── server/
│   ├── index.ts          # HTTP server
│   └── mcpHandler.ts     # MCP request handler
├── services/
│   ├── terminalWatcher.ts    # Terminal tracking
│   ├── tmuxManager.ts        # Tmux integration
│   ├── actionLog.ts          # Action logging
│   ├── agentDiscovery.ts     # AI agent detection
│   └── notificationService.ts # Notifications
├── tools/
│   ├── terminalTools.ts      # Terminal MCP tools
│   ├── dashboardTools.ts     # Dashboard MCP tools
│   ├── editorTools.ts        # Editor MCP tools
│   └── fileTools.ts          # File MCP tools
├── dashboard/
│   ├── DashboardPanel.ts     # Dashboard webview
│   └── webview/              # Dashboard UI assets
└── types.ts                  # TypeScript types
```
