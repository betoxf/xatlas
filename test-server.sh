#!/bin/bash
# Test script for VS Code MCP Server

PORT=${1:-9002}
HOST="127.0.0.1"
URL="http://$HOST:$PORT"

echo "=========================================="
echo "  VS Code MCP Server Test Suite"
echo "=========================================="
echo ""

# Health check
echo "1. Health Check:"
curl -s "$URL/health" | jq .
echo ""

# Initialize
echo "2. Initialize:"
curl -s -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | jq .
echo ""

# List tools
echo "3. List Tools (should show 34 tools):"
TOOL_COUNT=$(curl -s -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools | length')
echo "Tool count: $TOOL_COUNT"
echo ""

echo "All registered tools:"
curl -s -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | jq -r '.result.tools[].name' | sort
echo ""

# Test vscode_info
echo "4. Test vscode_info:"
curl -s -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"vscode_info","arguments":{}}}' | jq '.result.content[0].text | fromjson'
echo ""

# Test vscode_get_workspace_info
echo "5. Test vscode_get_workspace_info:"
curl -s -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"vscode_get_workspace_info","arguments":{}}}' | jq '.result.content[0].text | fromjson'
echo ""

echo "=========================================="
echo "  Test Complete!"
echo "=========================================="
echo ""
echo "Available tools by category:"
echo ""
echo "  FILE OPERATIONS (6):"
echo "    vscode_open_file, vscode_close_file, vscode_save_file"
echo "    vscode_get_open_files, vscode_read_file, vscode_create_file"
echo ""
echo "  EDITOR OPERATIONS (6):"
echo "    vscode_goto_line, vscode_goto_symbol, vscode_get_selection"
echo "    vscode_insert_text, vscode_replace_text, vscode_get_active_editor"
echo ""
echo "  CODE INTELLIGENCE (5):"
echo "    vscode_get_diagnostics, vscode_get_symbols, vscode_find_references"
echo "    vscode_get_definition, vscode_search_symbols"
echo ""
echo "  TERMINAL (6):"
echo "    vscode_terminal_create, vscode_terminal_send, vscode_terminal_execute"
echo "    vscode_terminal_read_output, vscode_terminal_list, vscode_terminal_close"
echo ""
echo "  WORKSPACE & TASKS (4):"
echo "    vscode_run_command, vscode_run_task"
echo "    vscode_get_tasks, vscode_get_workspace_info"
echo ""
echo "  DEBUG (6):"
echo "    vscode_debug_start, vscode_debug_stop, vscode_debug_pause"
echo "    vscode_debug_continue, vscode_set_breakpoint, vscode_get_breakpoints"
echo ""
echo "  INFO (1):"
echo "    vscode_info"
echo ""
echo "Total: 34 tools"
