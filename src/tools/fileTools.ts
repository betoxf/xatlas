import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';

/**
 * Register all file operation tools
 */
export function registerFileTools(): void {
  registerOpenFile();
  registerCloseFile();
  registerSaveFile();
  registerGetOpenFiles();
  registerReadFile();
  registerCreateFile();
}

/**
 * vscode_open_file - Open a file in the editor
 */
function registerOpenFile(): void {
  const definition: MCPTool = {
    name: 'vscode_open_file',
    description: 'Open a file in VS Code editor',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative path to the file',
        },
        viewColumn: {
          type: 'number',
          description: 'Editor column to open in (1=first, 2=second, etc.)',
          default: 1,
        },
        preview: {
          type: 'boolean',
          description: 'Open as preview tab (will be replaced by next file)',
          default: false,
        },
      },
      required: ['path'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string;
    const viewColumn = (args.viewColumn as number) || 1;
    const preview = (args.preview as boolean) ?? false;

    try {
      const uri = resolveFilePath(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        viewColumn: viewColumn as vscode.ViewColumn,
        preview,
      });

      return {
        content: [{ type: 'text', text: `Opened: ${uri.fsPath}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error opening file: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_close_file - Close a file or all files
 */
function registerCloseFile(): void {
  const definition: MCPTool = {
    name: 'vscode_close_file',
    description: 'Close a file tab or all tabs',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to file to close. Omit to close active editor.',
        },
        all: {
          type: 'boolean',
          description: 'Close all open editors',
          default: false,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string | undefined;
    const closeAll = args.all as boolean;

    try {
      if (closeAll) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        return {
          content: [{ type: 'text', text: 'Closed all editors' }],
        };
      }

      if (filePath) {
        const uri = resolveFilePath(filePath);
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
        const tab = tabs.find(
          t => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === uri.fsPath
        );

        if (tab) {
          await vscode.window.tabGroups.close(tab);
          return {
            content: [{ type: 'text', text: `Closed: ${uri.fsPath}` }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `File not open: ${filePath}` }],
            isError: true,
          };
        }
      } else {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        return {
          content: [{ type: 'text', text: 'Closed active editor' }],
        };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error closing file: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_save_file - Save a file
 */
function registerSaveFile(): void {
  const definition: MCPTool = {
    name: 'vscode_save_file',
    description: 'Save a file or all files',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to file to save. Omit to save active editor.',
        },
        all: {
          type: 'boolean',
          description: 'Save all open files',
          default: false,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string | undefined;
    const saveAll = args.all as boolean;

    try {
      if (saveAll) {
        await vscode.workspace.saveAll();
        return {
          content: [{ type: 'text', text: 'Saved all files' }],
        };
      }

      if (filePath) {
        const uri = resolveFilePath(filePath);
        const document = vscode.workspace.textDocuments.find(
          doc => doc.uri.fsPath === uri.fsPath
        );

        if (document) {
          await document.save();
          return {
            content: [{ type: 'text', text: `Saved: ${uri.fsPath}` }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `File not open: ${filePath}` }],
            isError: true,
          };
        }
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await editor.document.save();
          return {
            content: [{ type: 'text', text: `Saved: ${editor.document.fileName}` }],
          };
        } else {
          return {
            content: [{ type: 'text', text: 'No active editor' }],
            isError: true,
          };
        }
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error saving file: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_open_files - List all open files
 */
function registerGetOpenFiles(): void {
  const definition: MCPTool = {
    name: 'vscode_get_open_files',
    description: 'Get list of all open files in the editor',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    const tabs = vscode.window.tabGroups.all.flatMap(group =>
      group.tabs
        .filter(tab => tab.input instanceof vscode.TabInputText)
        .map(tab => ({
          path: (tab.input as vscode.TabInputText).uri.fsPath,
          isActive: tab.isActive,
          isDirty: tab.isDirty,
          group: group.viewColumn,
        }))
    );

    const activeEditor = vscode.window.activeTextEditor;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              openFiles: tabs,
              activeFile: activeEditor?.document.fileName || null,
              totalCount: tabs.length,
            },
            null,
            2
          ),
        },
      ],
    };
  };

  registerTool(definition, handler);
}

/**
 * vscode_read_file - Read file contents
 */
function registerReadFile(): void {
  const definition: MCPTool = {
    name: 'vscode_read_file',
    description: 'Read the contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read',
        },
        startLine: {
          type: 'number',
          description: 'Start line (1-based). Omit to read from beginning.',
        },
        endLine: {
          type: 'number',
          description: 'End line (1-based, inclusive). Omit to read to end.',
        },
      },
      required: ['path'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string;
    const startLine = args.startLine as number | undefined;
    const endLine = args.endLine as number | undefined;

    try {
      const uri = resolveFilePath(filePath);

      // Try to get from open document first, otherwise read from disk
      let content: string;
      const openDoc = vscode.workspace.textDocuments.find(
        doc => doc.uri.fsPath === uri.fsPath
      );

      if (openDoc) {
        content = openDoc.getText();
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        content = Buffer.from(bytes).toString('utf-8');
      }

      // Apply line range if specified
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n');
        const start = (startLine || 1) - 1;
        const end = endLine || lines.length;
        content = lines.slice(start, end).join('\n');
      }

      // Limit content size to prevent huge responses
      const MAX_SIZE = 100000;
      if (content.length > MAX_SIZE) {
        content = content.substring(0, MAX_SIZE) + '\n... (truncated)';
      }

      return {
        content: [{ type: 'text', text: content }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading file: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_create_file - Create a new file
 */
function registerCreateFile(): void {
  const definition: MCPTool = {
    name: 'vscode_create_file',
    description: 'Create a new file with optional content',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path for the new file',
        },
        content: {
          type: 'string',
          description: 'Initial content for the file',
          default: '',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite if file exists',
          default: false,
        },
        openAfter: {
          type: 'boolean',
          description: 'Open the file after creating',
          default: true,
        },
      },
      required: ['path'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string;
    const content = (args.content as string) || '';
    const overwrite = args.overwrite as boolean;
    const openAfter = (args.openAfter as boolean) ?? true;

    try {
      const uri = resolveFilePath(filePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(uri);
        if (!overwrite) {
          return {
            content: [{ type: 'text', text: `File already exists: ${filePath}. Use overwrite: true to replace.` }],
            isError: true,
          };
        }
      } catch {
        // File doesn't exist, which is fine
      }

      // Create parent directories if needed
      const parentUri = vscode.Uri.file(path.dirname(uri.fsPath));
      try {
        await vscode.workspace.fs.createDirectory(parentUri);
      } catch {
        // Directory might already exist
      }

      // Write the file
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));

      // Open if requested
      if (openAfter) {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
      }

      return {
        content: [{ type: 'text', text: `Created: ${uri.fsPath}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating file: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * Helper to resolve file paths (absolute or workspace-relative)
 */
function resolveFilePath(filePath: string): vscode.Uri {
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }

  // Try workspace-relative path
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
  }

  // Fallback to treating as absolute
  return vscode.Uri.file(filePath);
}
