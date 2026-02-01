# VS Code MCP Server - Implementation Plan

## Executive Summary

Build a VS Code extension that exposes VS Code's capabilities via the Model Context Protocol (MCP), enabling Claude Code to fully control VS Code.

## Research Findings

### Existing Solutions Analyzed

1. **[juehang/vscode-mcp-server](https://github.com/juehang/vscode-mcp-server)**
   - HTTP server on port 3000 (streamable HTTP)
   - Tools: file ops, edit ops, symbol search, diagnostics, shell
   - TypeScript, MIT license
   - Strengths: Simple, VS Code native APIs
   - Gaps: No debug support, no task runner, limited terminal

2. **[BifrostMCP](https://github.com/biegehydra/BifrostMCP)**
   - HTTP+SSE on port 8008
   - Tools: LSP-focused (find_usages, go_to_definition, rename, etc.)
   - Strengths: Deep semantic analysis
   - Gaps: No file editing, no terminal, no debug

3. **Official VS Code MCP Support**
   - VS Code 1.102+ has native MCP support
   - Supports stdio, HTTP, SSE transports
   - Provides API for extension-contributed MCP servers

### Key Insights

- Embedding HTTP server directly in extension is the proven pattern
- HTTP streamable transport is recommended over SSE (modern approach)
- VS Code Extension API provides all needed capabilities
- MCP TypeScript SDK v1.x is stable for production

---

## Architecture Design

### Single-Component Architecture

```
┌─────────────────────────────────────────────────────┐
│                    VS Code                          │
│  ┌───────────────────────────────────────────────┐  │
│  │           VS Code MCP Extension               │  │
│  │  ┌─────────────┐    ┌──────────────────────┐  │  │
│  │  │ HTTP Server │◄───│  MCP Protocol Layer  │  │  │
│  │  │ (Port 9002) │    │  - Tool handlers     │  │  │
│  │  └─────────────┘    │  - Resource handlers │  │  │
│  │         ▲           └──────────────────────┘  │  │
│  │         │                      │              │  │
│  │         │           ┌──────────▼──────────┐   │  │
│  │         │           │  VS Code API Layer  │   │  │
│  │         │           │  - Window API       │   │  │
│  │         │           │  - Workspace API    │   │  │
│  │         │           │  - Debug API        │   │  │
│  │         │           │  - Terminal API     │   │  │
│  │         │           │  - Tasks API        │   │  │
│  │         │           └─────────────────────┘   │  │
│  └─────────┼─────────────────────────────────────┘  │
└────────────┼────────────────────────────────────────┘
             │
             │ HTTP (localhost:9002/mcp)
             ▼
┌─────────────────────────────┐
│       Claude Code           │
│  (MCP Client via HTTP)      │
└─────────────────────────────┘
```

### Why Single Component?

1. **Simpler deployment** - One extension to install
2. **Direct API access** - No IPC overhead
3. **Proven pattern** - Used by successful existing solutions
4. **Easier maintenance** - Single codebase

---

## MCP Tools Specification

### 1. File Operations

| Tool | Description | Parameters |
|------|-------------|------------|
| `vscode_open_file` | Open file in editor | `path`, `viewColumn?`, `preview?` |
| `vscode_close_file` | Close file/tab | `path` or `all` |
| `vscode_save_file` | Save current or specified file | `path?` |
| `vscode_get_open_files` | List all open files | none |
| `vscode_read_file` | Read file contents | `path`, `encoding?` |
| `vscode_create_file` | Create new file | `path`, `content`, `overwrite?` |

### 2. Editor Operations

| Tool | Description | Parameters |
|------|-------------|------------|
| `vscode_goto_line` | Navigate to line | `path`, `line`, `column?` |
| `vscode_goto_symbol` | Navigate to symbol | `symbol`, `path?` |
| `vscode_get_selection` | Get selected text | none |
| `vscode_insert_text` | Insert at cursor/position | `text`, `position?` |
| `vscode_replace_text` | Replace text range | `path`, `startLine`, `endLine`, `newText` |
| `vscode_get_active_editor` | Get active editor info | none |

### 3. Code Intelligence

| Tool | Description | Parameters |
|------|-------------|------------|
| `vscode_get_diagnostics` | Get errors/warnings | `path?`, `severity?` |
| `vscode_get_symbols` | Get document symbols | `path` |
| `vscode_find_references` | Find all references | `path`, `line`, `column` |
| `vscode_get_definition` | Go to definition | `path`, `line`, `column` |
| `vscode_search_symbols` | Search workspace symbols | `query`, `maxResults?` |

### 4. Terminal

| Tool | Description | Parameters |
|------|-------------|------------|
| `vscode_terminal_create` | Create new terminal | `name?`, `cwd?` |
| `vscode_terminal_send` | Send command | `terminalId?`, `command`, `addNewLine?` |
| `vscode_terminal_list` | List terminals | none |
| `vscode_terminal_close` | Close terminal | `terminalId` |

### 5. Workspace & Tasks

| Tool | Description | Parameters |
|------|-------------|------------|
| `vscode_run_command` | Run any VS Code command | `command`, `args?` |
| `vscode_run_task` | Run configured task | `taskName` |
| `vscode_get_tasks` | List available tasks | none |
| `vscode_get_workspace_info` | Get workspace folders/info | none |

### 6. Debug

| Tool | Description | Parameters |
|------|-------------|------------|
| `vscode_debug_start` | Start debugging | `configName?` |
| `vscode_debug_stop` | Stop debugging | none |
| `vscode_debug_pause` | Pause execution | none |
| `vscode_debug_continue` | Continue execution | none |
| `vscode_set_breakpoint` | Set/toggle breakpoint | `path`, `line` |
| `vscode_get_breakpoints` | List breakpoints | none |

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript 5.x |
| VS Code API | @types/vscode |
| MCP Protocol | @modelcontextprotocol/sdk v1.x |
| HTTP Server | Node.js http (built-in) |
| Transport | Streamable HTTP |
| Build | esbuild (bundler) |
| Package Manager | npm |

---

## Project Structure

```
vscode-mcp-server/
├── .vscode/
│   ├── launch.json          # Debug configurations
│   └── tasks.json           # Build tasks
├── src/
│   ├── extension.ts         # Extension entry point
│   ├── server/
│   │   ├── index.ts         # HTTP server setup
│   │   └── mcpHandler.ts    # MCP protocol handler
│   ├── tools/
│   │   ├── index.ts         # Tool registry
│   │   ├── fileTools.ts     # File operations
│   │   ├── editorTools.ts   # Editor operations
│   │   ├── codeTools.ts     # Code intelligence
│   │   ├── terminalTools.ts # Terminal operations
│   │   ├── workspaceTools.ts # Workspace & tasks
│   │   └── debugTools.ts    # Debug operations
│   ├── utils/
│   │   └── vscodeHelpers.ts # VS Code API helpers
│   └── types/
│       └── index.ts         # Type definitions
├── package.json             # Extension manifest
├── tsconfig.json            # TypeScript config
├── esbuild.js               # Build script
├── README.md                # User documentation
├── CLAUDE.md                # Project instructions
└── PLAN.md                  # This file
```

---

## Implementation Phases

### Phase 1: Project Setup (Foundation)
1. Initialize VS Code extension project with TypeScript
2. Configure build system (esbuild)
3. Set up basic extension activation
4. Create HTTP server scaffold
5. **Test**: Extension loads, server starts, responds to ping

### Phase 2: MCP Protocol Layer
1. Implement MCP protocol handler
2. Set up tool registration system
3. Implement request/response handling
4. Add error handling and logging
5. **Test**: MCP client can connect and list tools

### Phase 3: Core File Tools
1. Implement `vscode_open_file`
2. Implement `vscode_close_file`
3. Implement `vscode_save_file`
4. Implement `vscode_get_open_files`
5. Implement `vscode_read_file`
6. Implement `vscode_create_file`
7. **Test**: All file operations work via MCP

### Phase 4: Editor Tools
1. Implement `vscode_goto_line`
2. Implement `vscode_goto_symbol`
3. Implement `vscode_get_selection`
4. Implement `vscode_insert_text`
5. Implement `vscode_replace_text`
6. Implement `vscode_get_active_editor`
7. **Test**: All editor operations work via MCP

### Phase 5: Code Intelligence Tools
1. Implement `vscode_get_diagnostics`
2. Implement `vscode_get_symbols`
3. Implement `vscode_find_references`
4. Implement `vscode_get_definition`
5. Implement `vscode_search_symbols`
6. **Test**: Code intelligence works via MCP

### Phase 6: Terminal Tools
1. Implement `vscode_terminal_create`
2. Implement `vscode_terminal_send`
3. Implement `vscode_terminal_list`
4. Implement `vscode_terminal_close`
5. **Test**: Terminal operations work via MCP

### Phase 7: Workspace & Task Tools
1. Implement `vscode_run_command`
2. Implement `vscode_run_task`
3. Implement `vscode_get_tasks`
4. Implement `vscode_get_workspace_info`
5. **Test**: Workspace operations work via MCP

### Phase 8: Debug Tools
1. Implement `vscode_debug_start`
2. Implement `vscode_debug_stop`
3. Implement `vscode_debug_pause/continue`
4. Implement `vscode_set_breakpoint`
5. Implement `vscode_get_breakpoints`
6. **Test**: Debug operations work via MCP

### Phase 9: Polish & Documentation
1. Add status bar indicator
2. Add configuration options (port, enabled tools)
3. Add server toggle commands
4. Write comprehensive README
5. Create Claude Code integration guide
6. **Test**: Full end-to-end with Claude Code

---

## Testing Strategy (Ralph Wiggum Method)

### Per-Phase Testing

After each implementation unit:
1. **Manual Test**: Open VS Code Extension Host, verify feature
2. **MCP Test**: Use MCP Inspector or curl to test endpoint
3. **Integration Test**: Test from Claude Code if possible

### Test Commands

```bash
# Test server is running
curl http://localhost:9002/mcp

# Test tool listing (MCP protocol)
curl -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Test specific tool call
curl -X POST http://localhost:9002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vscode_get_open_files","arguments":{}}}'
```

---

## Configuration

### Extension Settings (package.json contributes)

```json
{
  "vscode-mcp-server.port": 9002,
  "vscode-mcp-server.host": "127.0.0.1",
  "vscode-mcp-server.autoStart": true,
  "vscode-mcp-server.enabledTools": {
    "file": true,
    "editor": true,
    "code": true,
    "terminal": true,
    "workspace": true,
    "debug": true
  }
}
```

### Claude Code Integration

Add to Claude Code's MCP config:
```json
{
  "mcpServers": {
    "vscode": {
      "url": "http://localhost:9002/mcp"
    }
  }
}
```

---

## Security Considerations

1. **Localhost only** - Server binds to 127.0.0.1 only
2. **No authentication** - Relies on localhost security
3. **Command validation** - Validate all inputs before execution
4. **Path validation** - Ensure paths are within workspace
5. **Shell command caution** - Warn users about terminal risks

---

## Success Criteria

1. Extension installs and activates in VS Code
2. HTTP server starts on configured port
3. All 26 tools respond to MCP requests
4. Claude Code can:
   - Open/close/edit files
   - Navigate code
   - Run terminal commands
   - Start/stop debugger
   - Run tasks
5. Documentation enables easy setup

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| VS Code API changes | Pin VS Code engine version |
| MCP SDK breaking changes | Use stable v1.x |
| Port conflicts | Configurable port |
| Performance issues | Async operations, timeouts |
| Security concerns | Localhost-only, validation |

---

## Next Steps

1. **Approve this plan** or request modifications
2. **Phase 1**: Start with project scaffolding
3. **Iterate**: Code → Test → Fix → Repeat
4. **Update**: Send progress via Telegram

---

## Sources

- [VS Code MCP Developer Guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [juehang/vscode-mcp-server](https://github.com/juehang/vscode-mcp-server)
- [BifrostMCP](https://github.com/biegehydra/BifrostMCP)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Model Context Protocol](https://modelcontextprotocol.io)
