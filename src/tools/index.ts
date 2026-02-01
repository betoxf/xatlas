import * as vscode from 'vscode';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';
import { registerFileTools } from './fileTools';
import { registerEditorTools } from './editorTools';
import { registerCodeTools } from './codeTools';
import { registerTerminalTools } from './terminalTools';
import { registerWorkspaceTools } from './workspaceTools';
import { registerDebugTools } from './debugTools';
import { registerDashboardTools } from './dashboardTools';

/**
 * Register all MCP tools
 */
export function registerAllTools(): void {
  // Register basic info tool for testing
  registerInfoTool();

  // Phase 2: File and Editor tools
  registerFileTools();
  registerEditorTools();

  // Phase 3: Code Intelligence tools
  registerCodeTools();

  // Phase 4: Terminal tools
  registerTerminalTools();

  // Phase 5: Workspace & Task tools
  registerWorkspaceTools();

  // Phase 6: Debug tools
  registerDebugTools();

  // Phase 7: Dashboard tools
  registerDashboardTools();
}

/**
 * Info tool - basic server info for testing
 */
function registerInfoTool(): void {
  const definition: MCPTool = {
    name: 'vscode_info',
    description: 'Get VS Code workspace and editor information',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };

  const handler = async (): Promise<ToolResult> => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const activeEditor = vscode.window.activeTextEditor;

    const info = {
      vscodeVersion: vscode.version,
      workspaceFolders: workspaceFolders?.map(f => ({
        name: f.name,
        path: f.uri.fsPath,
      })) || [],
      activeFile: activeEditor?.document.fileName || null,
      openFiles: vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputText)
        .map(t => (t.input as vscode.TabInputText).uri.fsPath),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(info, null, 2),
        },
      ],
    };
  };

  registerTool(definition, handler);
}
