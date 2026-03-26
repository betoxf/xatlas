# xatlas VS Code MCP Server - AI Agent Guide

This guide describes what an AI assistant can do when connected to this MCP server, including the new AI activity tracking features.

## Connection

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

Or direct HTTP:
```json
{
  "mcpServers": {
    "vscode": {
      "url": "http://localhost:9002/mcp"
    }
  }
}
```

## Supported AI Coding Agents

The dashboard can detect and display these AI coding agents when running in terminals:

| Agent | Commands | Autonomous Mode Flag | UI Color |
|-------|----------|---------------------|----------|
| **Claude Code** | `claude`, `cc` | `--dangerously-skip-permissions` | `#ff6b00` (Orange) |
| **Zed AI** | `zai`, `z ai` | `--dangerously-skip-permissions` | `#0ea5e9` (Blue) |
| **OpenCode** | `opencode`, `oc` | Built-in (no flag needed) | `#22c55e` (Green) |
| **Codex** | `codex` | `--full-auto` | `#a855f7` (Purple) |
| **Aider** | `aider` | `--yes` | `#eab308` (Yellow) |

These agents run in terminal but are rendered as enhanced webviews in the dashboard.

### Starting Agents

```bash
# Claude Code - full autonomous mode
claude --dangerously-skip-permissions

# Zed AI - full autonomous mode
zai --dangerously-skip-permissions

# OpenCode - autonomous by default
opencode

# Codex - full auto mode
codex --full-auto

# Aider - auto-confirm changes
aider --yes
```

---

## What You Can Do

### 1. AI Activity Tracking (NEW)

See what AI has done - the "conversation" view:

| Tool | What it does |
|------|-------------|
| `vscode_mcp_created_terminals` | List all terminals created by AI |
| `vscode_terminal_command_history` | Get command history for a terminal |
| `vscode_action_log_get` | Get history of all MCP tool calls |
| `vscode_action_log_stats` | Get usage statistics |
| `vscode_action_log_clear` | Clear action history |

**What gets tracked:**
- Which terminals AI created (`createdByMcp: true`)
- Every command AI sent to terminals
- Command outputs and exit codes
- Execution duration and status

**Example: See what AI did**
```
1. vscode_mcp_created_terminals → List AI-created terminals
2. vscode_terminal_command_history(processId) → See commands run in that terminal
3. vscode_action_log_get → See all MCP tool calls
```

### 2. Terminal Operations

| Tool | What it does |
|------|-------------|
| `vscode_terminal_create` | Create terminal (tmux-backed for 50K scrollback) |
| `vscode_terminal_send` | Send command to terminal |
| `vscode_terminal_execute` | Run command and capture output with exit code |
| `vscode_terminal_run_quick` | Quick command with last 100 lines |
| `vscode_terminal_read_buffer` | Read terminal buffer (works for interactive apps) |
| `vscode_terminal_read_output` | Read output file with pagination |
| `vscode_terminal_list` | List all terminals |
| `vscode_terminal_close` | Close a terminal |
| `vscode_terminal_show` | Switch to a specific terminal |
| `vscode_terminal_rename` | AI-rename terminal based on context |

**Example use cases:**
- Run build/test commands
- Execute git operations
- Manage multiple terminal sessions
- Monitor long-running processes

### 3. Terminal Monitoring

| Tool | What it does |
|------|-------------|
| `vscode_terminal_monitor_status` | Get state of all terminals |
| `vscode_terminal_monitor_start` | Start monitoring for state changes |
| `vscode_terminal_monitor_stop` | Stop monitoring |
| `vscode_notification_config` | Configure notifications |
| `vscode_notification_test` | Test notification system |

**Terminal States:**
- `idle` - Ready for input
- `processing` - Command running
- `waiting_input` - Needs input (password, y/n, etc.)
- `completed` - Task finished
- `error` - Error occurred
- `context_warning` - AI context usage high

### 4. Dashboard Operations

| Tool | What it does |
|------|-------------|
| `vscode_dashboard_list_projects` | List all tracked projects |
| `vscode_dashboard_add_project` | Add project to dashboard |
| `vscode_dashboard_remove_project` | Remove project |
| `vscode_dashboard_get_project` | Get project details with terminals |
| `vscode_dashboard_create_terminal` | Create tmux terminal for project |
| `vscode_dashboard_reorder_projects` | Reorder projects |
| `vscode_dashboard_set_project_color` | Set project accent color |
| `vscode_dashboard_get_state` | Get full dashboard state |
| `vscode_get_webviews` | List active webviews |

### 5. File Operations

| Tool | What it does |
|------|-------------|
| `vscode_open_file` | Open any file in editor |
| `vscode_close_file` | Close file tabs |
| `vscode_save_file` | Save current file or all |
| `vscode_get_open_files` | See what files user has open |
| `vscode_read_file` | Read file contents |
| `vscode_create_file` | Create new files |

### 6. Editor Navigation & Editing

| Tool | What it does |
|------|-------------|
| `vscode_goto_line` | Jump to specific line/column |
| `vscode_goto_symbol` | Navigate to function/class |
| `vscode_get_selection` | Get text user has selected |
| `vscode_insert_text` | Insert text at cursor |
| `vscode_replace_text` | Replace text in range |
| `vscode_get_active_editor` | Get current editor state |
| `vscode_get_live_content` | Get content including unsaved changes |
| `vscode_watch_changes` | See what user is typing in real-time |

### 7. Code Intelligence

| Tool | What it does |
|------|-------------|
| `vscode_get_diagnostics` | Get errors, warnings, hints |
| `vscode_get_symbols` | List functions/classes in file |
| `vscode_find_references` | Find all uses of symbol |
| `vscode_get_definition` | Go to where symbol is defined |
| `vscode_search_symbols` | Search symbols across workspace |

### 8. Debugging

| Tool | What it does |
|------|-------------|
| `vscode_debug_start` | Start debug session |
| `vscode_debug_stop` | Stop debugging |
| `vscode_debug_pause` | Pause execution |
| `vscode_debug_continue` | Continue/step through code |
| `vscode_set_breakpoint` | Set/toggle breakpoints |
| `vscode_get_breakpoints` | List all breakpoints |

---

## Common Workflows

### 1. Create AI Worker Terminal

```
1. vscode_dashboard_create_terminal(projectPath, name: "AI Worker")
   → Terminal is marked as AI-created
2. vscode_terminal_execute(command: "npm run build")
   → Command is logged in history
3. vscode_terminal_command_history(processId)
   → User can see what you did
```

### 2. Monitor Multiple AI Agents

```
1. vscode_terminal_monitor_start
   → Start monitoring all terminals
2. vscode_terminal_monitor_status
   → Check which need attention
3. vscode_mcp_created_terminals
   → See all AI-created terminals
```

### 3. Code Review Workflow

```
1. vscode_get_open_files → See what user is working on
2. vscode_get_live_content → Read current (unsaved) code
3. vscode_get_diagnostics → Check for errors
4. vscode_find_references → Understand impact of changes
```

### 4. Build & Test

```
1. vscode_terminal_execute(command: "npm test")
   → Runs tests, captures output
2. Check exit code for pass/fail
3. vscode_get_diagnostics → Check for new errors
4. vscode_terminal_command_history
   → Review what was run
```

### 5. Launch Another AI Agent

```
1. vscode_dashboard_create_terminal(projectPath, name: "Claude")
2. vscode_terminal_send(text: "claude --dangerously-skip-permissions")
3. vscode_terminal_read_buffer → Monitor Claude's output
```

---

## MCP Automation Runbook

### A) Create AI Terminal

```json
{
  "method": "tools/call",
  "params": {
    "name": "vscode_dashboard_create_terminal",
    "arguments": {
      "projectPath": "/path/to/project",
      "name": "AI Worker",
      "show": false
    }
  }
}
```

### B) Execute Command with Output

```json
{
  "method": "tools/call",
  "params": {
    "name": "vscode_terminal_execute",
    "arguments": {
      "command": "npm run build",
      "name": "AI Worker",
      "maxWait": 120000,
      "tailLines": 100
    }
  }
}
```

### C) Check AI Activity

```json
{
  "method": "tools/call",
  "params": {
    "name": "vscode_mcp_created_terminals",
    "arguments": {
      "includeHistory": true
    }
  }
}
```

### D) Get Terminal Command History

```json
{
  "method": "tools/call",
  "params": {
    "name": "vscode_terminal_command_history",
    "arguments": {
      "processId": 12345,
      "limit": 50,
      "includeOutput": true
    }
  }
}
```

### E) Monitor Terminal States

```json
{
  "method": "tools/call",
  "params": {
    "name": "vscode_terminal_monitor_status",
    "arguments": {
      "filterState": "waiting_input"
    }
  }
}
```

---

## Command History Data Structure

When AI sends commands, they're tracked with:

```typescript
interface TerminalCommand {
  id: string;                    // Unique command ID
  command: string;               // The command text
  timestamp: number;             // When it was sent
  source: 'mcp' | 'user' | 'unknown';  // Who sent it
  output?: string;               // Captured output
  exitCode?: number;             // Exit code
  duration?: number;             // Execution time (ms)
  status: 'pending' | 'completed' | 'error';
}
```

This creates a "conversation" view where users can see exactly what AI did.

---

## Tips for AI Assistants

1. **Terminals you create are visible**: Users can see AI-created terminals in the dashboard with a badge.

2. **Commands are logged**: Every command you send is recorded in the terminal's history.

3. **Use tmux terminals**: `vscode_dashboard_create_terminal` creates tmux-backed terminals with 50K line scrollback.

4. **Check before acting**: Use `vscode_get_open_files` and `vscode_get_active_editor` to understand context.

5. **Use live content**: `vscode_get_live_content` shows unsaved changes - more accurate than disk.

6. **For long commands**: Use `vscode_terminal_execute`. For quick ones: `vscode_terminal_run_quick`.

7. **Check diagnostics**: Run `vscode_get_diagnostics` after code changes to catch issues.

8. **Navigate, don't just tell**: Use `vscode_goto_line` to take users there directly.

9. **Launch other agents**: You can create terminals and start Claude, Codex, etc.

---

## REST API Endpoints

For direct HTTP access:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server health check |
| `GET /dashboard/terminals/mcp` | List AI-created terminals |
| `GET /dashboard/terminal/{pid}/history` | Get command history |
| `GET /action-log` | Get all MCP tool calls |
| `GET /action-log/stats` | Get usage statistics |

---

## Security Notes

- Server only accepts connections from localhost (127.0.0.1)
- Be careful with terminal commands - they execute on user's machine
- File operations have full access to workspace
- All AI actions are logged for user visibility
