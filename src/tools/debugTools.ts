import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';

/**
 * Register all debug tools
 */
export function registerDebugTools(): void {
  registerDebugStart();
  registerDebugStop();
  registerDebugPause();
  registerDebugContinue();
  registerSetBreakpoint();
  registerGetBreakpoints();
}

/**
 * vscode_debug_start - Start debugging
 */
function registerDebugStart(): void {
  const definition: MCPTool = {
    name: 'vscode_debug_start',
    description: 'Start a debug session',
    inputSchema: {
      type: 'object',
      properties: {
        configuration: {
          type: 'string',
          description: 'Name of debug configuration from launch.json. Omit to use default.',
        },
        noDebug: {
          type: 'boolean',
          description: 'Run without debugging (just execute)',
          default: false,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const configName = args.configuration as string | undefined;
    const noDebug = args.noDebug as boolean;

    try {
      // Get available configurations
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

      let started: boolean;

      if (configName) {
        // Start with specific configuration
        started = await vscode.debug.startDebugging(workspaceFolder, configName, { noDebug });
      } else {
        // Start with default configuration
        started = await vscode.debug.startDebugging(workspaceFolder, undefined, { noDebug });
      }

      if (started) {
        // Wait a moment for the session to initialize
        await new Promise(resolve => setTimeout(resolve, 500));

        const session = vscode.debug.activeDebugSession;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  started: true,
                  configuration: configName || 'default',
                  noDebug,
                  session: session
                    ? {
                        id: session.id,
                        name: session.name,
                        type: session.type,
                      }
                    : null,
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: 'Failed to start debug session. Check if launch.json is configured.',
            },
          ],
          isError: true,
        };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error starting debug: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_debug_stop - Stop debugging
 */
function registerDebugStop(): void {
  const definition: MCPTool = {
    name: 'vscode_debug_stop',
    description: 'Stop the current debug session',
    inputSchema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'Stop all debug sessions',
          default: false,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const stopAll = args.all as boolean;

    try {
      if (stopAll) {
        // Stop all sessions
        await vscode.commands.executeCommand('workbench.action.debug.stop');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ stopped: true, all: true }, null, 2),
            },
          ],
        };
      }

      const session = vscode.debug.activeDebugSession;

      if (!session) {
        return {
          content: [{ type: 'text', text: 'No active debug session' }],
          isError: true,
        };
      }

      await vscode.debug.stopDebugging(session);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                stopped: true,
                session: {
                  id: session.id,
                  name: session.name,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error stopping debug: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_debug_pause - Pause execution
 */
function registerDebugPause(): void {
  const definition: MCPTool = {
    name: 'vscode_debug_pause',
    description: 'Pause the current debug session',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    try {
      const session = vscode.debug.activeDebugSession;

      if (!session) {
        return {
          content: [{ type: 'text', text: 'No active debug session' }],
          isError: true,
        };
      }

      await vscode.commands.executeCommand('workbench.action.debug.pause');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                paused: true,
                session: session.name,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error pausing debug: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_debug_continue - Continue execution
 */
function registerDebugContinue(): void {
  const definition: MCPTool = {
    name: 'vscode_debug_continue',
    description: 'Continue execution in the current debug session',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Debug action: continue, stepOver, stepInto, stepOut',
          enum: ['continue', 'stepOver', 'stepInto', 'stepOut'],
          default: 'continue',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const action = (args.action as string) || 'continue';

    try {
      const session = vscode.debug.activeDebugSession;

      if (!session) {
        return {
          content: [{ type: 'text', text: 'No active debug session' }],
          isError: true,
        };
      }

      const commandMap: Record<string, string> = {
        continue: 'workbench.action.debug.continue',
        stepOver: 'workbench.action.debug.stepOver',
        stepInto: 'workbench.action.debug.stepInto',
        stepOut: 'workbench.action.debug.stepOut',
      };

      const command = commandMap[action];
      if (!command) {
        return {
          content: [{ type: 'text', text: `Invalid action: ${action}` }],
          isError: true,
        };
      }

      await vscode.commands.executeCommand(command);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                action,
                executed: true,
                session: session.name,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error in debug action: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_set_breakpoint - Set or toggle a breakpoint
 */
function registerSetBreakpoint(): void {
  const definition: MCPTool = {
    name: 'vscode_set_breakpoint',
    description: 'Set, toggle, or remove a breakpoint',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path for the breakpoint',
        },
        line: {
          type: 'number',
          description: 'Line number (1-based)',
        },
        condition: {
          type: 'string',
          description: 'Conditional expression for the breakpoint',
        },
        hitCondition: {
          type: 'string',
          description: 'Hit count condition',
        },
        logMessage: {
          type: 'string',
          description: 'Log message (logpoint) instead of breaking',
        },
        remove: {
          type: 'boolean',
          description: 'Remove breakpoint instead of adding',
          default: false,
        },
      },
      required: ['path', 'line'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.path as string;
    const line = args.line as number;
    const condition = args.condition as string | undefined;
    const hitCondition = args.hitCondition as string | undefined;
    const logMessage = args.logMessage as string | undefined;
    const remove = args.remove as boolean;

    try {
      const uri = resolveFilePath(filePath);
      const location = new vscode.Location(uri, new vscode.Position(line - 1, 0));

      if (remove) {
        // Find and remove existing breakpoint
        const breakpoints = vscode.debug.breakpoints.filter(bp => {
          if (bp instanceof vscode.SourceBreakpoint) {
            return (
              bp.location.uri.fsPath === uri.fsPath &&
              bp.location.range.start.line === line - 1
            );
          }
          return false;
        });

        if (breakpoints.length > 0) {
          vscode.debug.removeBreakpoints(breakpoints);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    removed: true,
                    file: uri.fsPath,
                    line,
                    count: breakpoints.length,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `No breakpoint found at ${filePath}:${line}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Create new breakpoint
      const breakpoint = new vscode.SourceBreakpoint(location, true, condition, hitCondition, logMessage);

      vscode.debug.addBreakpoints([breakpoint]);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                added: true,
                file: uri.fsPath,
                line,
                condition: condition || null,
                hitCondition: hitCondition || null,
                logMessage: logMessage || null,
                isLogpoint: !!logMessage,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error setting breakpoint: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_breakpoints - List all breakpoints
 */
function registerGetBreakpoints(): void {
  const definition: MCPTool = {
    name: 'vscode_get_breakpoints',
    description: 'Get all breakpoints',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Filter by file path',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filterPath = args.path as string | undefined;

    try {
      let breakpoints = vscode.debug.breakpoints;

      // Filter by path if specified
      if (filterPath) {
        const uri = resolveFilePath(filterPath);
        breakpoints = breakpoints.filter(bp => {
          if (bp instanceof vscode.SourceBreakpoint) {
            return bp.location.uri.fsPath === uri.fsPath;
          }
          return false;
        });
      }

      const result = breakpoints.map(bp => {
        if (bp instanceof vscode.SourceBreakpoint) {
          return {
            type: 'source',
            enabled: bp.enabled,
            file: bp.location.uri.fsPath,
            line: bp.location.range.start.line + 1,
            condition: bp.condition || null,
            hitCondition: bp.hitCondition || null,
            logMessage: bp.logMessage || null,
          };
        } else if (bp instanceof vscode.FunctionBreakpoint) {
          return {
            type: 'function',
            enabled: bp.enabled,
            functionName: bp.functionName,
            condition: bp.condition || null,
            hitCondition: bp.hitCondition || null,
          };
        } else {
          return {
            type: 'unknown',
            enabled: bp.enabled,
          };
        }
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: result.length,
                filter: filterPath || null,
                breakpoints: result,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting breakpoints: ${error}` }],
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
