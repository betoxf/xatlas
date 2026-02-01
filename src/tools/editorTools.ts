import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';

// Store recent document changes for watching
interface DocumentChange {
  timestamp: number;
  file: string;
  changes: {
    range: { startLine: number; startCol: number; endLine: number; endCol: number };
    text: string;
    rangeLength: number;
  }[];
}

const recentChanges: DocumentChange[] = [];
const MAX_CHANGES = 100;
let changeListener: vscode.Disposable | null = null;

/**
 * Register all editor operation tools
 */
export function registerEditorTools(): void {
  registerGotoLine();
  registerGotoSymbol();
  registerGetSelection();
  registerInsertText();
  registerReplaceText();
  registerGetActiveEditor();
  registerGetLiveContent();
  registerWatchChanges();

  // Set up document change listener
  setupChangeListener();
}

/**
 * Set up listener for document changes
 */
function setupChangeListener(): void {
  if (changeListener) {
    changeListener.dispose();
  }

  changeListener = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length === 0) return;

    const change: DocumentChange = {
      timestamp: Date.now(),
      file: event.document.fileName,
      changes: event.contentChanges.map(c => ({
        range: {
          startLine: c.range.start.line + 1,
          startCol: c.range.start.character + 1,
          endLine: c.range.end.line + 1,
          endCol: c.range.end.character + 1,
        },
        text: c.text,
        rangeLength: c.rangeLength,
      })),
    };

    recentChanges.unshift(change);

    // Keep only last MAX_CHANGES
    while (recentChanges.length > MAX_CHANGES) {
      recentChanges.pop();
    }
  });
}

/**
 * Clean up change listener
 */
export function disposeChangeListener(): void {
  if (changeListener) {
    changeListener.dispose();
    changeListener = null;
  }
}

/**
 * vscode_goto_line - Navigate to a specific line
 */
function registerGotoLine(): void {
  const definition: MCPTool = {
    name: 'vscode_goto_line',
    description: 'Navigate to a specific line in a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to file. Omit to use active editor.',
        },
        line: {
          type: 'number',
          description: 'Line number (1-based)',
        },
        column: {
          type: 'number',
          description: 'Column number (1-based)',
          default: 1,
        },
        select: {
          type: 'boolean',
          description: 'Select the entire line',
          default: false,
        },
      },
      required: ['line'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string | undefined;
    const line = args.line as number;
    const column = (args.column as number) || 1;
    const selectLine = args.select as boolean;

    try {
      let editor = vscode.window.activeTextEditor;

      // Open file if path specified
      if (filePath) {
        const uri = resolveFilePath(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(document);
      }

      if (!editor) {
        return {
          content: [{ type: 'text', text: 'No active editor' }],
          isError: true,
        };
      }

      // Convert to 0-based
      const position = new vscode.Position(line - 1, column - 1);

      if (selectLine) {
        const lineText = editor.document.lineAt(line - 1);
        editor.selection = new vscode.Selection(lineText.range.start, lineText.range.end);
      } else {
        editor.selection = new vscode.Selection(position, position);
      }

      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );

      return {
        content: [
          {
            type: 'text',
            text: `Navigated to line ${line}, column ${column} in ${editor.document.fileName}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error navigating: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_goto_symbol - Navigate to a symbol
 */
function registerGotoSymbol(): void {
  const definition: MCPTool = {
    name: 'vscode_goto_symbol',
    description: 'Navigate to a symbol (function, class, variable) in the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to find',
        },
        path: {
          type: 'string',
          description: 'Limit search to this file',
        },
      },
      required: ['symbol'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const symbolName = args.symbol as string;
    const filePath = args.path as string | undefined;

    try {
      let symbols: vscode.SymbolInformation[];

      if (filePath) {
        // Search in specific file
        const uri = resolveFilePath(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          uri
        );

        if (docSymbols) {
          // Find matching symbol in document
          const found = findSymbolInDocument(docSymbols, symbolName);
          if (found) {
            const editor = await vscode.window.showTextDocument(document);
            editor.selection = new vscode.Selection(found.range.start, found.range.start);
            editor.revealRange(found.range, vscode.TextEditorRevealType.InCenter);

            return {
              content: [
                {
                  type: 'text',
                  text: `Found ${found.name} (${vscode.SymbolKind[found.kind]}) at line ${found.range.start.line + 1}`,
                },
              ],
            };
          }
        }

        return {
          content: [{ type: 'text', text: `Symbol not found: ${symbolName}` }],
          isError: true,
        };
      } else {
        // Search workspace
        symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          symbolName
        );

        if (symbols && symbols.length > 0) {
          // Go to first match
          const symbol = symbols[0];
          const document = await vscode.workspace.openTextDocument(symbol.location.uri);
          const editor = await vscode.window.showTextDocument(document);
          editor.selection = new vscode.Selection(
            symbol.location.range.start,
            symbol.location.range.start
          );
          editor.revealRange(symbol.location.range, vscode.TextEditorRevealType.InCenter);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    found: symbol.name,
                    kind: vscode.SymbolKind[symbol.kind],
                    file: symbol.location.uri.fsPath,
                    line: symbol.location.range.start.line + 1,
                    totalMatches: symbols.length,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [{ type: 'text', text: `Symbol not found: ${symbolName}` }],
          isError: true,
        };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error finding symbol: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_selection - Get selected text
 */
function registerGetSelection(): void {
  const definition: MCPTool = {
    name: 'vscode_get_selection',
    description: 'Get the currently selected text in the active editor',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return {
        content: [{ type: 'text', text: 'No active editor' }],
        isError: true,
      };
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              text: selectedText,
              isEmpty: selection.isEmpty,
              startLine: selection.start.line + 1,
              startColumn: selection.start.character + 1,
              endLine: selection.end.line + 1,
              endColumn: selection.end.character + 1,
              file: editor.document.fileName,
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
 * vscode_insert_text - Insert text at cursor or position
 */
function registerInsertText(): void {
  const definition: MCPTool = {
    name: 'vscode_insert_text',
    description: 'Insert text at the cursor position or specified location',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to insert',
        },
        path: {
          type: 'string',
          description: 'File path. Omit to use active editor.',
        },
        line: {
          type: 'number',
          description: 'Line number (1-based). Omit to insert at cursor.',
        },
        column: {
          type: 'number',
          description: 'Column number (1-based)',
          default: 1,
        },
      },
      required: ['text'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const text = args.text as string;
    const filePath = args.path as string | undefined;
    const line = args.line as number | undefined;
    const column = (args.column as number) || 1;

    try {
      let editor = vscode.window.activeTextEditor;

      if (filePath) {
        const uri = resolveFilePath(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(document);
      }

      if (!editor) {
        return {
          content: [{ type: 'text', text: 'No active editor' }],
          isError: true,
        };
      }

      const position =
        line !== undefined
          ? new vscode.Position(line - 1, column - 1)
          : editor.selection.active;

      await editor.edit(editBuilder => {
        editBuilder.insert(position, text);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Inserted ${text.length} characters at line ${position.line + 1}, column ${position.character + 1}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error inserting text: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_replace_text - Replace text in a range
 */
function registerReplaceText(): void {
  const definition: MCPTool = {
    name: 'vscode_replace_text',
    description: 'Replace text in a specified range',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path',
        },
        startLine: {
          type: 'number',
          description: 'Start line (1-based)',
        },
        startColumn: {
          type: 'number',
          description: 'Start column (1-based)',
          default: 1,
        },
        endLine: {
          type: 'number',
          description: 'End line (1-based)',
        },
        endColumn: {
          type: 'number',
          description: 'End column (1-based). Omit for end of line.',
        },
        newText: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['path', 'startLine', 'endLine', 'newText'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string;
    const startLine = args.startLine as number;
    const startColumn = (args.startColumn as number) || 1;
    const endLine = args.endLine as number;
    const endColumn = args.endColumn as number | undefined;
    const newText = args.newText as string;

    try {
      const uri = resolveFilePath(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);

      // Calculate end column if not specified
      const actualEndColumn =
        endColumn !== undefined ? endColumn : document.lineAt(endLine - 1).text.length + 1;

      const range = new vscode.Range(
        new vscode.Position(startLine - 1, startColumn - 1),
        new vscode.Position(endLine - 1, actualEndColumn - 1)
      );

      const oldText = document.getText(range);

      await editor.edit(editBuilder => {
        editBuilder.replace(range, newText);
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                replaced: {
                  startLine,
                  startColumn,
                  endLine,
                  endColumn: actualEndColumn,
                  oldLength: oldText.length,
                  newLength: newText.length,
                },
                file: uri.fsPath,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error replacing text: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_active_editor - Get active editor info
 */
function registerGetActiveEditor(): void {
  const definition: MCPTool = {
    name: 'vscode_get_active_editor',
    description: 'Get information about the active editor',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ active: false }, null, 2),
          },
        ],
      };
    }

    const document = editor.document;
    const selection = editor.selection;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              active: true,
              file: document.fileName,
              languageId: document.languageId,
              lineCount: document.lineCount,
              isDirty: document.isDirty,
              isUntitled: document.isUntitled,
              cursor: {
                line: selection.active.line + 1,
                column: selection.active.character + 1,
              },
              selection: {
                isEmpty: selection.isEmpty,
                startLine: selection.start.line + 1,
                startColumn: selection.start.character + 1,
                endLine: selection.end.line + 1,
                endColumn: selection.end.character + 1,
              },
              viewColumn: editor.viewColumn,
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
 * Helper to resolve file paths
 */
function resolveFilePath(filePath: string): vscode.Uri {
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
  }
  return vscode.Uri.file(filePath);
}

/**
 * Helper to find symbol in document symbols (recursive)
 */
function findSymbolInDocument(
  symbols: vscode.DocumentSymbol[],
  name: string
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.name.toLowerCase().includes(name.toLowerCase())) {
      return symbol;
    }
    if (symbol.children.length > 0) {
      const found = findSymbolInDocument(symbol.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * vscode_get_live_content - Get current content including unsaved changes
 */
function registerGetLiveContent(): void {
  const definition: MCPTool = {
    name: 'vscode_get_live_content',
    description: 'Get the current live content of a file including unsaved changes. See what the user is typing in real-time.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. Omit to use active editor.',
        },
        startLine: {
          type: 'number',
          description: 'Start line (1-based). Omit for full content.',
        },
        endLine: {
          type: 'number',
          description: 'End line (1-based). Omit for full content.',
        },
        aroundCursor: {
          type: 'number',
          description: 'Get N lines around cursor position instead of full file.',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string | undefined;
    const startLine = args.startLine as number | undefined;
    const endLine = args.endLine as number | undefined;
    const aroundCursor = args.aroundCursor as number | undefined;

    try {
      let document: vscode.TextDocument;
      let editor = vscode.window.activeTextEditor;

      if (filePath) {
        const uri = resolveFilePath(filePath);
        document = await vscode.workspace.openTextDocument(uri);
      } else if (editor) {
        document = editor.document;
      } else {
        return {
          content: [{ type: 'text', text: 'No active editor and no path specified' }],
          isError: true,
        };
      }

      let content: string;
      let actualStartLine = 1;
      let actualEndLine = document.lineCount;

      if (aroundCursor !== undefined && editor && editor.document === document) {
        // Get lines around cursor
        const cursorLine = editor.selection.active.line;
        actualStartLine = Math.max(0, cursorLine - aroundCursor) + 1;
        actualEndLine = Math.min(document.lineCount - 1, cursorLine + aroundCursor) + 1;

        const range = new vscode.Range(
          new vscode.Position(actualStartLine - 1, 0),
          new vscode.Position(actualEndLine - 1, document.lineAt(actualEndLine - 1).text.length)
        );
        content = document.getText(range);
      } else if (startLine !== undefined && endLine !== undefined) {
        // Get specific range
        actualStartLine = startLine;
        actualEndLine = Math.min(endLine, document.lineCount);

        const range = new vscode.Range(
          new vscode.Position(startLine - 1, 0),
          new vscode.Position(actualEndLine - 1, document.lineAt(actualEndLine - 1).text.length)
        );
        content = document.getText(range);
      } else {
        // Get full content
        content = document.getText();
      }

      // Get cursor info if available
      const cursorInfo = editor && editor.document === document ? {
        line: editor.selection.active.line + 1,
        column: editor.selection.active.character + 1,
        hasSelection: !editor.selection.isEmpty,
      } : null;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                file: document.fileName,
                languageId: document.languageId,
                isDirty: document.isDirty,
                totalLines: document.lineCount,
                range: {
                  startLine: actualStartLine,
                  endLine: actualEndLine,
                },
                cursor: cursorInfo,
                content,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting content: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_watch_changes - Get recent document changes
 */
function registerWatchChanges(): void {
  const definition: MCPTool = {
    name: 'vscode_watch_changes',
    description: 'Get recent document changes (keystrokes, edits). Captures what the user is typing in real-time.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Filter changes to specific file path.',
        },
        since: {
          type: 'number',
          description: 'Get changes since this timestamp (ms since epoch).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of changes to return (default: 20)',
          default: 20,
        },
        clear: {
          type: 'boolean',
          description: 'Clear change history after reading',
          default: false,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filterFile = args.file as string | undefined;
    const since = args.since as number | undefined;
    const limit = (args.limit as number) ?? 20;
    const clear = (args.clear as boolean) ?? false;

    try {
      let changes = [...recentChanges];

      // Filter by file
      if (filterFile) {
        changes = changes.filter(c => c.file.includes(filterFile));
      }

      // Filter by timestamp
      if (since !== undefined) {
        changes = changes.filter(c => c.timestamp > since);
      }

      // Limit results
      changes = changes.slice(0, limit);

      // Clear if requested
      if (clear) {
        recentChanges.length = 0;
      }

      // Format for readability
      const formatted = changes.map(c => ({
        timestamp: c.timestamp,
        ago: `${Math.round((Date.now() - c.timestamp) / 1000)}s ago`,
        file: c.file,
        changes: c.changes.map(ch => ({
          at: `L${ch.range.startLine}:${ch.range.startCol}`,
          deleted: ch.rangeLength,
          inserted: ch.text.length > 50 ? ch.text.substring(0, 50) + '...' : ch.text,
          fullText: ch.text,
        })),
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalStored: recentChanges.length,
                returned: formatted.length,
                oldestTimestamp: changes.length > 0 ? changes[changes.length - 1].timestamp : null,
                newestTimestamp: changes.length > 0 ? changes[0].timestamp : null,
                changes: formatted,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting changes: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}
