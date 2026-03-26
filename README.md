# xatlas VS Code MCP Server

A VS Code extension that enables AI assistants to **control multiple projects simultaneously** through embedded card terminals.

## Primary Use Case: Multi-Project AI Orchestration

Control Claude Code (or other AI agents) running in **different projects** from a single terminal. This is the killer feature - orchestrate multiple AI sessions across your workspace.

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Dashboard with Project Cards                                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ cerebroapp   │  │   Postura    │  │ bullfighter  │          │
│  │ [Claude]     │  │   [zai]      │  │   [idle]     │          │
│  │ ▶ Running    │  │   ▶ Running  │  │              │          │
│  │ Terminal 1 ◀─┼──┼── Control ───┼──┼── from here  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### Quick Start: Control Another Project's Terminal

**Step 1: List your projects**
```bash
curl -s -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"vscode_dashboard_list_projects","arguments":{}}
}'
```

**Step 2: List active card terminals**
```bash
curl -s -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"vscode_card_terminals_list","arguments":{}}
}'
```
Returns terminals with their `clientId` - this is how you target them.

**Step 3: Send a command to another project's terminal**
```bash
curl -s -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"vscode_card_terminal_send","arguments":{
    "clientId":"client-2-1769939250969",
    "text":"echo Hello from another project!"
  }}
}'
```

**Step 4: Read the response**
```bash
curl -s -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"vscode_card_terminal_read","arguments":{
    "clientId":"client-2-1769939250969",
    "lines":50
  }}
}'
```

### Real Example: Control Another Claude Instance

From your current Claude Code terminal, you can control Claude running in another project:

```bash
# 1. Start Claude in another project's terminal
vscode_card_terminal_send(clientId="client-2-xxx", text="zai")

# 2. Wait for it to start, then send a message
vscode_card_terminal_send(clientId="client-2-xxx", text="hi")

# 3. Read the response
vscode_card_terminal_read(clientId="client-2-xxx", lines=30)

# Result: You can see the other Claude's response!
# "Hi! How can I help you with Postura today?"
```

This enables **multi-agent orchestration** - one AI coordinating work across multiple projects!

---

## Card Terminal Tools (Primary)

These are the main tools for multi-project control:

| Tool | Description |
|------|-------------|
| `vscode_card_terminals_list` | List all open card terminals with their clientIds |
| `vscode_card_terminal_open` | Open a card terminal for a project (by name or path) |
| `vscode_card_terminal_send` | Send command/text to any card terminal |
| `vscode_card_terminal_read` | Read output from any card terminal |

### Tool Details

#### `vscode_card_terminals_list`
List all active card terminals. Each terminal has a unique `clientId`.

```json
{
  "name": "vscode_card_terminals_list",
  "arguments": {
    "includeOutput": true,
    "outputLines": 30
  }
}
```

**Response:**
```json
{
  "count": 2,
  "terminals": [
    {
      "clientId": "client-1-1769939219124",
      "sessionName": "xvsc_2292df_1769939219125",
      "projectPath": "/Users/user/cerebroapp-monorepo",
      "terminalId": 1769939219125,
      "output": "..."
    },
    {
      "clientId": "client-2-1769939250969",
      "sessionName": "xvsc_2292df_1769939250970",
      "projectPath": "/Users/user/Postura",
      "terminalId": 1769939250970,
      "output": "..."
    }
  ]
}
```

#### `vscode_card_terminal_open`
Open a card terminal for a project. Use this to ensure a terminal exists before sending commands.

```json
{
  "name": "vscode_card_terminal_open",
  "arguments": {
    "projectName": "Postura"
  }
}
```
Or by path:
```json
{
  "name": "vscode_card_terminal_open",
  "arguments": {
    "projectPath": "/Users/user/my-project"
  }
}
```

#### `vscode_card_terminal_send`
Send text/command to a card terminal. Enter is automatically added.

```json
{
  "name": "vscode_card_terminal_send",
  "arguments": {
    "clientId": "client-2-1769939250969",
    "text": "npm run build"
  }
}
```

#### `vscode_card_terminal_read`
Read output from a card terminal.

```json
{
  "name": "vscode_card_terminal_read",
  "arguments": {
    "clientId": "client-2-1769939250969",
    "lines": 100
  }
}
```

---

## Features

- **Multi-Project Control** - Send commands to any project's terminal
- **50+ MCP Tools** across 9 categories
- **HTTP Server** on localhost:9002
- **AI Agent Dashboard** with real-time terminal rendering
- **Command History Tracking** - See what AI did ("conversation" view)
- **AI-Created Terminal Detection** - Know which terminals AI created
- **Tmux-backed Terminals** - 50,000 line scrollback
- **Status Bar Toggle** for easy control
- **Auto-start** on VS Code launch

## Supported AI Coding Agents

These AI coding agents run in VS Code terminals with webview-rendered UI:

| Agent | Start Command | Autonomous Mode | Color |
|-------|--------------|-----------------|-------|
| **Claude Code** | `claude` | `--dangerously-skip-permissions` | Orange |
| **Zed AI (Zai)** | `zai` | `--dangerously-skip-permissions` | Blue |
| **OpenCode** | `opencode` | Built-in auto mode | Green |
| **Codex** | `codex` | `--full-auto` | Purple |
| **Aider** | `aider` | `--yes` | Yellow |

## Installation

### From VSIX

```bash
code --install-extension xerebro-0.1.6.vsix  # legacy package id until republishing
```

### From Source

```bash
cd packages/vscode-extension
npm install
npm run build
```

## Usage

### Start the Server

1. Open VS Code
2. The server auto-starts (configurable)
3. Look for `MCP :9002` in the status bar
4. Click to toggle on/off

### Open the Dashboard

- Command Palette: `xatlas: Open Dashboard`
- Or click the xatlas icon in the Activity Bar

## All Available Tools (50+)

### Dashboard Tools (10)

| Tool | Description |
|------|-------------|
| `vscode_dashboard_list_projects` | List all tracked projects |
| `vscode_dashboard_add_project` | Add project to dashboard |
| `vscode_dashboard_remove_project` | Remove project |
| `vscode_dashboard_get_project` | Get project details |
| `vscode_dashboard_create_terminal` | Create terminal for project |
| `vscode_dashboard_reorder_projects` | Reorder projects |
| `vscode_dashboard_set_project_color` | Set project color |
| `vscode_dashboard_get_state` | Get full dashboard state |
| `vscode_get_webviews` | List active webviews |
| `vscode_open_xerebro_dashboard` | Open the dashboard |

### Card Terminal Tools (4) - PRIMARY

| Tool | Description |
|------|-------------|
| `vscode_card_terminals_list` | List all card terminals |
| `vscode_card_terminal_open` | Open terminal for a project |
| `vscode_card_terminal_read` | Read terminal output |
| `vscode_card_terminal_send` | Send command to terminal |

### Terminal Tools (10)

| Tool | Description |
|------|-------------|
| `vscode_terminal_create` | Create terminal (tmux-backed) |
| `vscode_terminal_send` | Send command to terminal |
| `vscode_terminal_execute` | Execute & capture output |
| `vscode_terminal_run_quick` | Quick command execution |
| `vscode_terminal_read_buffer` | Read terminal buffer |
| `vscode_terminal_read_output` | Read output with pagination |
| `vscode_terminal_list` | List all terminals |
| `vscode_terminal_close` | Close terminal |
| `vscode_terminal_show` | Show/activate terminal |
| `vscode_terminal_rename` | AI-based terminal naming |

### AI Activity Tracking (5)

| Tool | Description |
|------|-------------|
| `vscode_mcp_created_terminals` | List AI-created terminals |
| `vscode_terminal_command_history` | Get terminal command history |
| `vscode_action_log_get` | Get MCP tool call history |
| `vscode_action_log_stats` | Get tool usage statistics |
| `vscode_action_log_clear` | Clear action history |

### Terminal Monitoring (4)

| Tool | Description |
|------|-------------|
| `vscode_terminal_monitor_status` | Get terminal states |
| `vscode_terminal_monitor_start` | Start state monitoring |
| `vscode_terminal_monitor_stop` | Stop monitoring |
| `vscode_notification_config` | Configure notifications |

### File Operations (6)

| Tool | Description |
|------|-------------|
| `vscode_open_file` | Open file in editor |
| `vscode_close_file` | Close file/tab |
| `vscode_save_file` | Save file(s) |
| `vscode_get_open_files` | List open files |
| `vscode_read_file` | Read file contents |
| `vscode_create_file` | Create new file |

### Editor Operations (8)

| Tool | Description |
|------|-------------|
| `vscode_goto_line` | Navigate to line/column |
| `vscode_goto_symbol` | Navigate to symbol |
| `vscode_get_selection` | Get selected text |
| `vscode_insert_text` | Insert text at position |
| `vscode_replace_text` | Replace text in range |
| `vscode_get_active_editor` | Get editor state |
| `vscode_get_live_content` | Get content (including unsaved) |
| `vscode_watch_changes` | Watch real-time edits |

### Code Intelligence (5)

| Tool | Description |
|------|-------------|
| `vscode_get_diagnostics` | Get errors/warnings |
| `vscode_get_symbols` | Get document symbols |
| `vscode_find_references` | Find all references |
| `vscode_get_definition` | Go to definition |
| `vscode_search_symbols` | Search workspace symbols |

### Debug (6)

| Tool | Description |
|------|-------------|
| `vscode_debug_start` | Start debug session |
| `vscode_debug_stop` | Stop debugging |
| `vscode_debug_pause` | Pause execution |
| `vscode_debug_continue` | Continue/step |
| `vscode_set_breakpoint` | Set breakpoint |
| `vscode_get_breakpoints` | List breakpoints |

## API Endpoints

### Core
- `GET /health` - Server health check
- `POST /mcp` or `POST /` - MCP JSON-RPC endpoint

### Dashboard
- `GET /dashboard/info` - Workspace info
- `GET /dashboard/terminals` - All terminals
- `GET /dashboard/terminals/mcp` - AI-created terminals
- `GET /dashboard/terminal/{pid}/history` - Command history
- `POST /dashboard/terminal/{pid}/send` - Send command

### Activity
- `GET /action-log` - Full action history
- `GET /action-log/stats` - Statistics only

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `vscode-mcp-server.port` | `9002` | Server port |
| `vscode-mcp-server.host` | `127.0.0.1` | Server host |
| `vscode-mcp-server.autoStart` | `true` | Auto-start on launch |

## Commands

- `MCP Server: Start` - Start the server
- `MCP Server: Stop` - Stop the server
- `MCP Server: Toggle` - Toggle on/off
- `xatlas: Open Dashboard` - Open the dashboard
- `xatlas: Run Diagnostics` - Run diagnostic checks

## Security

- Server binds to localhost only (127.0.0.1)
- No authentication (relies on localhost security)
- Be cautious with terminal commands

## Documentation

- [CLAUDE.md](CLAUDE.md) - Full system prompt and MCP reference
- [AI_GUIDE.md](AI_GUIDE.md) - AI assistant capabilities guide

## License

MIT
