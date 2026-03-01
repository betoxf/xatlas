# Xerebro VS Code MCP Extension

## Primary Capability: Multi-Project AI Orchestration

**The most powerful feature**: Control Claude Code (or other AI agents) running in **different projects** from your current terminal. This enables multi-agent orchestration across your workspace.

### How to Control Other Project Terminals

```
You are Claude running in Project A. You can control Claude running in Project B:

1. List card terminals: vscode_card_terminals_list
   → Returns clientIds for all open project terminals

2. Send command to Project B: vscode_card_terminal_send
   → clientId: "client-2-xxx", text: "your command here"

3. Read Project B's response: vscode_card_terminal_read
   → clientId: "client-2-xxx", lines: 50
```

### Real Example: Coordinate Multiple Claude Instances

```javascript
// Step 1: See what terminals are available
const terminals = await mcp.callTool("vscode_card_terminals_list", {});
// Returns: cerebroapp (client-1), Postura (client-2), etc.

// Step 2: Start Claude in another project
await mcp.callTool("vscode_card_terminal_send", {
  clientId: "client-2-xxx",
  text: "zai"  // or "claude"
});

// Step 3: Send a task to the other Claude
await mcp.callTool("vscode_card_terminal_send", {
  clientId: "client-2-xxx",
  text: "Please review the authentication flow in this project"
});

// Step 4: Read what the other Claude responded
const response = await mcp.callTool("vscode_card_terminal_read", {
  clientId: "client-2-xxx",
  lines: 100
});
// You can now see the other Claude's analysis!
```

---

## Card Terminal Tools (PRIMARY - Use These First)

| Tool | Description |
|------|-------------|
| `vscode_card_terminals_list` | List all card terminals with their clientIds |
| `vscode_card_terminal_open` | Open a terminal for a project by name or path |
| `vscode_card_terminal_send` | Send command/text to any terminal (Enter auto-added) |
| `vscode_card_terminal_read` | Read output from any terminal |

### `vscode_card_terminals_list`
```json
{
  "name": "vscode_card_terminals_list",
  "arguments": {
    "includeOutput": true,
    "outputLines": 30
  }
}
```
**Use this first** to discover available terminals and get their `clientId`.

### `vscode_card_terminal_open`
```json
{
  "name": "vscode_card_terminal_open",
  "arguments": {
    "projectName": "Postura"
  }
}
```
Opens a terminal for the project. Returns the `clientId` to use with send/read.

### `vscode_card_terminal_send`
```json
{
  "name": "vscode_card_terminal_send",
  "arguments": {
    "clientId": "client-2-1769939250969",
    "text": "npm run build"
  }
}
```
Send any command. Enter is automatically added for reliable submission.

### `vscode_card_terminal_read`
```json
{
  "name": "vscode_card_terminal_read",
  "arguments": {
    "clientId": "client-2-1769939250969",
    "lines": 100
  }
}
```
Read the terminal output. Increase `lines` if you need more context.

---

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
│  ├── Project cards with embedded terminals                      │
│  ├── AI agent status indicators                                 │
│  └── Terminal output rendering (xterm.js)                       │
└─────────────────────────────────────────────────────────────────┘
```

## Supported AI Agents

| Agent | Commands | Autonomous Flag | Color |
|-------|----------|-----------------|-------|
| **Claude Code** | `claude`, `cc` | `--dangerously-skip-permissions` | Orange |
| **Zed AI (Zai)** | `zai`, `z ai` | `--dangerously-skip-permissions` | Blue |
| **OpenCode** | `opencode`, `oc` | Built-in auto mode | Green |
| **Codex** | `codex` | `--full-auto` | Purple |
| **Aider** | `aider` | `--yes` | Yellow |

## System Prompt for AI Agents

When using this extension, include this in your system prompt:

```
You have access to VS Code through the Xerebro MCP extension. Your PRIMARY capability is:

**Multi-Project Control**: You can control terminals in OTHER projects from your current session.

### Workflow for Multi-Project Tasks:
1. `vscode_card_terminals_list` - See all available project terminals
2. `vscode_card_terminal_send` - Send commands to any terminal by clientId
3. `vscode_card_terminal_read` - Read output from any terminal

### Example: Run tests in another project
const terminals = await vscode_card_terminals_list();
// Find the target project's clientId
await vscode_card_terminal_send({ clientId: "client-2-xxx", text: "npm test" });
// Wait, then read results
const output = await vscode_card_terminal_read({ clientId: "client-2-xxx", lines: 100 });

### Other Capabilities:
- Create tmux-backed terminals (50,000 line scrollback)
- Execute commands and capture output with exit codes
- Monitor terminal state (idle, running, waiting for input)
- Track AI activity across all terminals
```

## All MCP Tools Reference

### Card Terminal Tools (PRIMARY)

| Tool | Description |
|------|-------------|
| `vscode_card_terminals_list` | List all card terminals |
| `vscode_card_terminal_open` | Open terminal for a project |
| `vscode_card_terminal_read` | Read terminal output |
| `vscode_card_terminal_send` | Send command to terminal |

### Dashboard Tools

| Tool | Description |
|------|-------------|
| `vscode_dashboard_list_projects` | List tracked projects |
| `vscode_dashboard_add_project` | Add project |
| `vscode_dashboard_remove_project` | Remove project |
| `vscode_dashboard_get_project` | Get project details |
| `vscode_dashboard_create_terminal` | Create terminal (VS Code tab) |
| `vscode_dashboard_get_state` | Get full dashboard state |

### Terminal Tools

| Tool | Description |
|------|-------------|
| `vscode_terminal_create` | Create terminal (tmux-backed) |
| `vscode_terminal_send` | Send command |
| `vscode_terminal_execute` | Execute & capture output |
| `vscode_terminal_run_quick` | Quick command execution |
| `vscode_terminal_read_buffer` | Read terminal buffer |
| `vscode_terminal_list` | List all terminals |
| `vscode_terminal_close` | Close terminal |

### AI Activity Tracking

| Tool | Description |
|------|-------------|
| `vscode_mcp_created_terminals` | List AI-created terminals |
| `vscode_terminal_command_history` | Get command history |
| `vscode_action_log_get` | Get MCP tool call history |
| `vscode_action_log_stats` | Get usage statistics |

### Terminal Monitoring

| Tool | Description |
|------|-------------|
| `vscode_terminal_monitor_status` | Get terminal states |
| `vscode_terminal_monitor_start` | Start monitoring |
| `vscode_terminal_monitor_stop` | Stop monitoring |

### File Operations

| Tool | Description |
|------|-------------|
| `vscode_open_file` | Open file in editor |
| `vscode_close_file` | Close file/tab |
| `vscode_save_file` | Save file(s) |
| `vscode_get_open_files` | List open files |
| `vscode_read_file` | Read file contents |
| `vscode_create_file` | Create new file |

### Editor Operations

| Tool | Description |
|------|-------------|
| `vscode_goto_line` | Navigate to line/column |
| `vscode_goto_symbol` | Navigate to symbol |
| `vscode_get_selection` | Get selected text |
| `vscode_insert_text` | Insert text |
| `vscode_replace_text` | Replace text |
| `vscode_get_active_editor` | Get editor state |
| `vscode_get_live_content` | Get content (including unsaved) |

### Code Intelligence

| Tool | Description |
|------|-------------|
| `vscode_get_diagnostics` | Get errors/warnings |
| `vscode_get_symbols` | Get document symbols |
| `vscode_find_references` | Find all references |
| `vscode_get_definition` | Go to definition |
| `vscode_search_symbols` | Search workspace symbols |

### Debug

| Tool | Description |
|------|-------------|
| `vscode_debug_start` | Start debug session |
| `vscode_debug_stop` | Stop debugging |
| `vscode_debug_pause` | Pause execution |
| `vscode_debug_continue` | Continue/step |
| `vscode_set_breakpoint` | Set breakpoint |
| `vscode_get_breakpoints` | List breakpoints |

## Usage Examples

### Example 1: Coordinate Build Across Projects

```javascript
// List all terminals
const terminals = await mcp.callTool("vscode_card_terminals_list", {});

// Find the backend project terminal
const backend = terminals.find(t => t.projectPath.includes("backend"));

// Run build in backend while working on frontend
await mcp.callTool("vscode_card_terminal_send", {
  clientId: backend.clientId,
  text: "npm run build"
});

// Continue your work... then check the build status
const buildOutput = await mcp.callTool("vscode_card_terminal_read", {
  clientId: backend.clientId,
  lines: 50
});
```

### Example 2: Multi-Agent Code Review

```javascript
// Start a specialized Claude in another project
await mcp.callTool("vscode_card_terminal_send", {
  clientId: "client-2-xxx",
  text: "claude"
});

// Wait for it to start...
await sleep(3000);

// Ask it to review code
await mcp.callTool("vscode_card_terminal_send", {
  clientId: "client-2-xxx",
  text: "Please review src/auth.ts for security issues"
});

// Read its analysis
const review = await mcp.callTool("vscode_card_terminal_read", {
  clientId: "client-2-xxx",
  lines: 200
});
```

### Example 3: Run Tests in Multiple Projects

```javascript
const projects = ["frontend", "backend", "shared"];

for (const project of projects) {
  const terminal = terminals.find(t => t.projectPath.includes(project));
  await mcp.callTool("vscode_card_terminal_send", {
    clientId: terminal.clientId,
    text: "npm test"
  });
}

// Check results
for (const project of projects) {
  const terminal = terminals.find(t => t.projectPath.includes(project));
  const results = await mcp.callTool("vscode_card_terminal_read", {
    clientId: terminal.clientId,
    lines: 100
  });
  console.log(`${project}: ${results.includes("PASS") ? "✓" : "✗"}`);
}
```

## Configuration

### MCP Server Config

Add to `~/.claude/claude_desktop_config.json`:

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

### Extension Settings

- `mcpServer.autoStart`: Start MCP server automatically (default: true)
- `mcpServer.port`: Server port (default: 9002)
- `mcpServer.host`: Server host (default: 127.0.0.1)

## Troubleshooting

### Card terminal not found
- Make sure the project card is visible in the dashboard
- Open the card terminal manually first, then use `vscode_card_terminals_list` to get its clientId

### Commands not appearing in terminal
- The card terminal must be open (expanded or minimized with preview)
- Use `vscode_card_terminal_open` to ensure the terminal exists

### tmux not available
Install tmux for enhanced terminal features:
```bash
brew install tmux  # macOS
apt install tmux   # Linux
```
