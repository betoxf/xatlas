import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';

/**
 * Register all code intelligence tools
 */
export function registerCodeTools(): void {
  registerGetDiagnostics();
  registerGetSymbols();
  registerFindReferences();
  registerGetDefinition();
  registerSearchSymbols();
}

/**
 * vscode_get_diagnostics - Get errors and warnings
 */
function registerGetDiagnostics(): void {
  const definition: MCPTool = {
    name: 'vscode_get_diagnostics',
    description: 'Get diagnostics (errors, warnings, info) for a file or workspace',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. Omit to get diagnostics for all open files.',
        },
        severity: {
          type: 'string',
          description: 'Filter by severity: error, warning, info, hint, or all',
          enum: ['error', 'warning', 'info', 'hint', 'all'],
          default: 'all',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string | undefined;
    const severityFilter = (args.severity as string) || 'all';

    try {
      let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

      if (filePath) {
        const uri = resolveFilePath(filePath);
        const fileDiagnostics = vscode.languages.getDiagnostics(uri);
        diagnostics = [[uri, fileDiagnostics]];
      } else {
        diagnostics = vscode.languages.getDiagnostics();
      }

      // Map severity filter to DiagnosticSeverity
      const severityMap: Record<string, vscode.DiagnosticSeverity | undefined> = {
        error: vscode.DiagnosticSeverity.Error,
        warning: vscode.DiagnosticSeverity.Warning,
        info: vscode.DiagnosticSeverity.Information,
        hint: vscode.DiagnosticSeverity.Hint,
        all: undefined,
      };

      const targetSeverity = severityMap[severityFilter];

      const result: Array<{
        file: string;
        diagnostics: Array<{
          message: string;
          severity: string;
          line: number;
          column: number;
          endLine: number;
          endColumn: number;
          source?: string;
          code?: string | number;
        }>;
      }> = [];

      for (const [uri, fileDiags] of diagnostics) {
        const filtered = targetSeverity !== undefined
          ? fileDiags.filter(d => d.severity === targetSeverity)
          : fileDiags;

        if (filtered.length > 0) {
          result.push({
            file: uri.fsPath,
            diagnostics: filtered.map(d => ({
              message: d.message,
              severity: getSeverityName(d.severity),
              line: d.range.start.line + 1,
              column: d.range.start.character + 1,
              endLine: d.range.end.line + 1,
              endColumn: d.range.end.character + 1,
              source: d.source,
              code: typeof d.code === 'object' ? d.code.value : d.code,
            })),
          });
        }
      }

      const totalCount = result.reduce((sum, f) => sum + f.diagnostics.length, 0);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalCount,
                fileCount: result.length,
                diagnostics: result,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting diagnostics: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_symbols - Get document symbols
 */
function registerGetSymbols(): void {
  const definition: MCPTool = {
    name: 'vscode_get_symbols',
    description: 'Get all symbols (functions, classes, variables) in a document',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. Omit to use active editor.',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string | undefined;

    try {
      let uri: vscode.Uri;

      if (filePath) {
        uri = resolveFilePath(filePath);
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return {
            content: [{ type: 'text', text: 'No active editor and no path specified' }],
            isError: true,
          };
        }
        uri = editor.document.uri;
      }

      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );

      if (!symbols || symbols.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ file: uri.fsPath, symbols: [], message: 'No symbols found' }, null, 2),
            },
          ],
        };
      }

      const flattenSymbols = (
        syms: vscode.DocumentSymbol[],
        parent?: string
      ): Array<{
        name: string;
        kind: string;
        line: number;
        endLine: number;
        parent?: string;
        detail?: string;
      }> => {
        const result: Array<{
          name: string;
          kind: string;
          line: number;
          endLine: number;
          parent?: string;
          detail?: string;
        }> = [];

        for (const sym of syms) {
          result.push({
            name: sym.name,
            kind: vscode.SymbolKind[sym.kind],
            line: sym.range.start.line + 1,
            endLine: sym.range.end.line + 1,
            parent,
            detail: sym.detail || undefined,
          });

          if (sym.children.length > 0) {
            result.push(...flattenSymbols(sym.children, sym.name));
          }
        }

        return result;
      };

      const flatSymbols = flattenSymbols(symbols);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                file: uri.fsPath,
                symbolCount: flatSymbols.length,
                symbols: flatSymbols,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting symbols: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_find_references - Find all references to a symbol
 */
function registerFindReferences(): void {
  const definition: MCPTool = {
    name: 'vscode_find_references',
    description: 'Find all references to a symbol at a given position',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path',
        },
        line: {
          type: 'number',
          description: 'Line number (1-based)',
        },
        column: {
          type: 'number',
          description: 'Column number (1-based)',
        },
      },
      required: ['path', 'line', 'column'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string;
    const line = args.line as number;
    const column = args.column as number;

    try {
      const uri = resolveFilePath(filePath);
      const position = new vscode.Position(line - 1, column - 1);

      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        position
      );

      if (!locations || locations.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ references: [], message: 'No references found' }, null, 2),
            },
          ],
        };
      }

      const references = locations.map(loc => ({
        file: loc.uri.fsPath,
        line: loc.range.start.line + 1,
        column: loc.range.start.character + 1,
        endLine: loc.range.end.line + 1,
        endColumn: loc.range.end.character + 1,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                searchPosition: { file: uri.fsPath, line, column },
                referenceCount: references.length,
                references,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error finding references: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_definition - Go to definition
 */
function registerGetDefinition(): void {
  const definition: MCPTool = {
    name: 'vscode_get_definition',
    description: 'Get the definition location of a symbol at a given position',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path',
        },
        line: {
          type: 'number',
          description: 'Line number (1-based)',
        },
        column: {
          type: 'number',
          description: 'Column number (1-based)',
        },
        goTo: {
          type: 'boolean',
          description: 'Navigate to the definition',
          default: false,
        },
      },
      required: ['path', 'line', 'column'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string;
    const line = args.line as number;
    const column = args.column as number;
    const goTo = args.goTo as boolean;

    try {
      const uri = resolveFilePath(filePath);
      const position = new vscode.Position(line - 1, column - 1);

      const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeDefinitionProvider',
        uri,
        position
      );

      if (!definitions || definitions.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ definitions: [], message: 'No definition found' }, null, 2),
            },
          ],
        };
      }

      const result = definitions.map(def => {
        if ('targetUri' in def) {
          // LocationLink
          return {
            file: def.targetUri.fsPath,
            line: def.targetRange.start.line + 1,
            column: def.targetRange.start.character + 1,
            endLine: def.targetRange.end.line + 1,
            endColumn: def.targetRange.end.character + 1,
          };
        } else {
          // Location
          return {
            file: def.uri.fsPath,
            line: def.range.start.line + 1,
            column: def.range.start.character + 1,
            endLine: def.range.end.line + 1,
            endColumn: def.range.end.character + 1,
          };
        }
      });

      // Navigate to first definition if requested
      if (goTo && result.length > 0) {
        const firstDef = result[0];
        const defUri = vscode.Uri.file(firstDef.file);
        const document = await vscode.workspace.openTextDocument(defUri);
        const editor = await vscode.window.showTextDocument(document);
        const defPosition = new vscode.Position(firstDef.line - 1, firstDef.column - 1);
        editor.selection = new vscode.Selection(defPosition, defPosition);
        editor.revealRange(new vscode.Range(defPosition, defPosition), vscode.TextEditorRevealType.InCenter);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                searchPosition: { file: uri.fsPath, line, column },
                definitionCount: result.length,
                definitions: result,
                navigated: goTo,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting definition: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_search_symbols - Search workspace symbols
 */
function registerSearchSymbols(): void {
  const definition: MCPTool = {
    name: 'vscode_search_symbols',
    description: 'Search for symbols across the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or pattern to search',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results',
          default: 50,
        },
      },
      required: ['query'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const query = args.query as string;
    const maxResults = (args.maxResults as number) || 50;

    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );

      if (!symbols || symbols.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ query, symbols: [], message: 'No symbols found' }, null, 2),
            },
          ],
        };
      }

      const limited = symbols.slice(0, maxResults);

      const result = limited.map(sym => ({
        name: sym.name,
        kind: vscode.SymbolKind[sym.kind],
        file: sym.location.uri.fsPath,
        line: sym.location.range.start.line + 1,
        column: sym.location.range.start.character + 1,
        containerName: sym.containerName || undefined,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                totalFound: symbols.length,
                returned: result.length,
                symbols: result,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching symbols: ${error}` }],
        isError: true,
      };
    }
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
 * Helper to get severity name
 */
function getSeverityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'unknown';
  }
}
