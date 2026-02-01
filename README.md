# Xerebro VS Code MCP Server

A VS Code extension that exposes VS Code's capabilities via the Model Context Protocol (MCP), enabling AI assistants like Claude Code to fully control VS Code.

## Features

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

### Starting Agents in Autonomous Mode

```bash
# Claude Code - full autonomous mode (no permission prompts)
claude --dangerously-skip-permissions

# Zed AI - full autonomous mode
zai --dangerously-skip-permissions

# OpenCode - autonomous coding (auto-approve built-in)
opencode

# Codex (OpenAI) - full auto mode
codex --full-auto

# Aider - auto-confirm all changes
aider --yes
```

## Installation

### From Source

```bash
# Clone the repository
cd packages/vscode-extension

# Install dependencies
npm install

# Build
npm run build

# Install in VS Code (press F5 to test, or package for production)
```

### From VSIX

```bash
code --install-extension xerebro-0.1.6.vsix
```

## Usage

### Start the Server

1. Open VS Code
2. The server auto-starts (configurable)
3. Look for `MCP :9002` in the status bar
4. Click to toggle on/off

### Open the Dashboard

- Command Palette: `Xerebro: Open Dashboard`
- Or click the Xerebro icon in the Activity Bar

### Connect from Claude Code

Add to your MCP configuration (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vscode": {
      "command": "node",
      "args": ["/path/to/extension/dist/mcp-stdio-bridge.js"]
    }
  }
}
```

## Available Tools (50+)

### Terminal Tools (10)

| Tool | Description |
|------|-------------|
| `vscode_terminal_create` | Create terminal (tmux-backed for 50K scrollback) |
| `vscode_terminal_send` | Send command to terminal |
| `vscode_terminal_execute` | Execute & capture output with exit code |
| `vscode_terminal_run_quick` | Quick command execution |
| `vscode_terminal_read_buffer` | Read terminal output buffer |
| `vscode_terminal_read_output` | Read output file with pagination |
| `vscode_terminal_list` | List all terminals |
| `vscode_terminal_close` | Close terminal |
| `vscode_terminal_show` | Show/activate terminal |
| `vscode_terminal_rename` | AI-based terminal naming |

### Dashboard Tools (9)

| Tool | Description |
|------|-------------|
| `vscode_dashboard_list_projects` | List all tracked projects |
| `vscode_dashboard_add_project` | Add project to dashboard |
| `vscode_dashboard_remove_project` | Remove project |
| `vscode_dashboard_get_project` | Get project details |
| `vscode_dashboard_create_terminal` | Create terminal for project (VS Code tab or floating window) |
| `vscode_dashboard_reorder_projects` | Reorder projects |
| `vscode_dashboard_set_project_color` | Set project color |
| `vscode_dashboard_get_state` | Get full dashboard state |
| `vscode_get_webviews` | List active webviews |

### Dashboard Floating Window Tools (3)

Control terminals in dashboard floating windows (opened by clicking project cards):

| Tool | Description |
|------|-------------|
| `vscode_card_terminals_list` | List all open floating window terminals |
| `vscode_card_terminal_read` | Read output from a floating window terminal |
| `vscode_card_terminal_send` | Send commands to a floating window terminal |

#### Using Floating Windows via MCP

**1. Open a floating window for a project:**
```bash
# Use embedded: true to open a floating window instead of VS Code terminal tab
curl -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "vscode_dashboard_create_terminal",
    "arguments": {
      "projectPath": "/path/to/project",
      "name": "My Terminal",
      "embedded": true
    }
  }
}'
```

**2. List open floating windows:**
```bash
curl -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "vscode_card_terminals_list",
    "arguments": {"includeOutput": true}
  }
}'
```

**3. Send a command to a floating window:**
```bash
curl -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "vscode_card_terminal_send",
    "arguments": {
      "clientId": "client-1-xxxxx",
      "text": "npm run build"
    }
  }
}'
```

**4. Read terminal output:**
```bash
curl -X POST http://localhost:9002/mcp -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "vscode_card_terminal_read",
    "arguments": {
      "clientId": "client-1-xxxxx",
      "lines": 50
    }
  }
}'
```

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

## AI Activity Tracking ("Conversation" View)

When AI uses MCP to control terminals, all actions are tracked:

### What Gets Tracked

- **Terminal Creation**: Which terminals AI created (`createdByMcp: true`)
- **Commands Sent**: Every command with timestamp and source
- **Command Output**: Captured output with exit codes
- **Execution Status**: pending, completed, error

### View AI Activity

```bash
# List AI-created terminals
curl -s http://localhost:9002/dashboard/terminals/mcp | jq

# Get command history for a terminal
curl -s http://localhost:9002/dashboard/terminal/12345/history | jq

# Get all MCP tool calls
curl -s http://localhost:9002/action-log | jq
```

### Via MCP Tools

```json
// List AI-created terminals
{"method": "tools/call", "params": {"name": "vscode_mcp_created_terminals"}}

// Get command history
{"method": "tools/call", "params": {"name": "vscode_terminal_command_history", "arguments": {"processId": 12345}}}

// Get action log
{"method": "tools/call", "params": {"name": "vscode_action_log_get", "arguments": {"limit": 50}}}
```

## API Endpoints

### Core
- `GET /health` - Server health check
- `POST /mcp` or `POST /` - MCP JSON-RPC endpoint

### Dashboard
- `GET /dashboard/info` - Workspace info with terminal summary
- `GET /dashboard/terminals` - All terminals with output
- `GET /dashboard/terminals/mcp` - Only AI-created terminals
- `GET /dashboard/terminal/{pid}/history` - Command history
- `POST /dashboard/terminal/{pid}/send` - Send command

### Activity
- `GET /action-log` - Full action history
- `GET /action-log/stats` - Statistics only

## MCP Automation Examples

### 1) Create AI Terminal and Run Build

```bash
# Create terminal
curl -s -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"vscode_dashboard_create_terminal",
    "arguments":{"projectPath":"/path/to/project","name":"AI Builder"}}}'

# Run build
curl -s -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
    "name":"vscode_terminal_execute",
    "arguments":{"name":"AI Builder","command":"npm run build","maxWait":120000}}}'
```

### 2) Launch Claude Code in Terminal

```bash
# Create terminal and start Claude
curl -s -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"vscode_terminal_send",
    "arguments":{"name":"Claude","text":"claude --dangerously-skip-permissions","addNewLine":true}}}'
```

### 3) Check What AI Has Done

```bash
# Get all AI-created terminals
curl -s -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"vscode_mcp_created_terminals",
    "arguments":{"includeHistory":true}}}'

# Get command history for specific terminal
curl -s -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
    "name":"vscode_terminal_command_history",
    "arguments":{"processId":12345,"includeOutput":true}}}'
```

### 4) Monitor Terminal States

```bash
# Get status of all terminals
curl -s -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"vscode_terminal_monitor_status",
    "arguments":{}}}'
```

## Tmux Integration

Dashboard terminals are tmux-backed for enhanced features:

```bash
# List all dashboard sessions
tmux list-sessions | grep xvsc

# Read terminal content
tmux capture-pane -t SESSION_NAME -p | tail -20

# Send command
tmux send-keys -t SESSION_NAME 'your command' Enter

# Send special keys
tmux send-keys -t SESSION_NAME C-c    # Ctrl+C
tmux send-keys -t SESSION_NAME Escape # Escape
```

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
- `Xerebro: Open Dashboard` - Open the dashboard
- `Xerebro: Run Diagnostics` - Run diagnostic checks

## Security

- Server binds to localhost only (127.0.0.1)
- No authentication (relies on localhost security)
- Be cautious with terminal commands

## Development

```bash
# Watch mode
npm run watch

# Debug in VS Code
Press F5

# Build for production
npm run build
```

## Comprehensive Documentation

See [CLAUDE.md](CLAUDE.md) for:
- Full system prompt for AI agents
- Complete MCP tool reference
- Detailed usage examples
- Architecture overview

See [AI_GUIDE.md](AI_GUIDE.md) for:
- AI assistant capabilities
- Common workflows
- Tips for effective assistance

## License

MIT
