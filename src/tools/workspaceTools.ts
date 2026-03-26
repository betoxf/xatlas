import * as vscode from 'vscode';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';

/**
 * Register all workspace and task tools
 */
export function registerWorkspaceTools(): void {
  registerRunCommand();
  registerRunTask();
  registerGetTasks();
  registerGetWorkspaceInfo();
  registerOpenXerebroDashboard();
}

/**
 * vscode_run_command - Run any VS Code command
 */
function registerRunCommand(): void {
  const definition: MCPTool = {
    name: 'vscode_run_command',
    description: 'Execute any VS Code command by ID',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command ID (e.g., "editor.action.formatDocument", "workbench.action.files.save")',
        },
        args: {
          type: 'array',
          description: 'Arguments to pass to the command',
        },
      },
      required: ['command'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const command = args.command as string;
    const commandArgs = args.args as unknown[] | undefined;

    try {
      let result: unknown;

      if (commandArgs && commandArgs.length > 0) {
        result = await vscode.commands.executeCommand(command, ...commandArgs);
      } else {
        result = await vscode.commands.executeCommand(command);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                executed: command,
                args: commandArgs || [],
                result: result !== undefined ? String(result) : 'Command executed (no return value)',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error executing command: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_run_task - Run a VS Code task
 */
function registerRunTask(): void {
  const definition: MCPTool = {
    name: 'vscode_run_task',
    description: 'Run a configured VS Code task',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Task name or label to run',
        },
        waitForCompletion: {
          type: 'boolean',
          description: 'Wait for task to complete before returning',
          default: false,
        },
      },
      required: ['name'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const taskName = args.name as string;
    const waitForCompletion = args.waitForCompletion as boolean;

    try {
      // Fetch all tasks
      const tasks = await vscode.tasks.fetchTasks();

      // Find matching task
      const task = tasks.find(
        t => t.name === taskName || t.name.toLowerCase().includes(taskName.toLowerCase())
      );

      if (!task) {
        const availableTasks = tasks.map(t => t.name).join(', ');
        return {
          content: [
            {
              type: 'text',
              text: `Task not found: "${taskName}". Available tasks: ${availableTasks || 'none'}`,
            },
          ],
          isError: true,
        };
      }

      // Execute the task
      const execution = await vscode.tasks.executeTask(task);

      if (waitForCompletion) {
        // Wait for task to complete
        await new Promise<void>(resolve => {
          const disposable = vscode.tasks.onDidEndTaskProcess(e => {
            if (e.execution === execution) {
              disposable.dispose();
              resolve();
            }
          });

          // Timeout after 5 minutes
          setTimeout(() => {
            disposable.dispose();
            resolve();
          }, 300000);
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                started: true,
                task: task.name,
                source: task.source,
                scope: task.scope ? String(task.scope) : 'global',
                waitedForCompletion: waitForCompletion,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error running task: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_tasks - List available tasks
 */
function registerGetTasks(): void {
  const definition: MCPTool = {
    name: 'vscode_get_tasks',
    description: 'List all available VS Code tasks',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filter by task type (e.g., "npm", "shell", "typescript")',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filterType = args.type as string | undefined;

    try {
      let tasks = await vscode.tasks.fetchTasks();

      if (filterType) {
        tasks = tasks.filter(
          t => t.definition.type.toLowerCase() === filterType.toLowerCase()
        );
      }

      const taskList = tasks.map(t => ({
        name: t.name,
        type: t.definition.type,
        source: t.source,
        scope: getScopeName(t.scope),
        detail: t.detail || undefined,
      }));

      // Group by source
      const grouped: Record<string, typeof taskList> = {};
      for (const task of taskList) {
        const source = task.source;
        if (!grouped[source]) {
          grouped[source] = [];
        }
        grouped[source].push(task);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalCount: taskList.length,
                filter: filterType || 'none',
                bySource: grouped,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting tasks: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_workspace_info - Get workspace information
 */
function registerGetWorkspaceInfo(): void {
  const definition: MCPTool = {
    name: 'vscode_get_workspace_info',
    description: 'Get information about the current workspace',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspaceFile = vscode.workspace.workspaceFile;
      const config = vscode.workspace.getConfiguration();

      // Get some useful workspace settings
      const editorConfig = vscode.workspace.getConfiguration('editor');
      const filesConfig = vscode.workspace.getConfiguration('files');

      const info = {
        name: vscode.workspace.name || 'Untitled',
        workspaceFile: workspaceFile?.fsPath || null,
        isMultiRoot: (workspaceFolders?.length || 0) > 1,
        folders: workspaceFolders?.map(f => ({
          name: f.name,
          path: f.uri.fsPath,
          index: f.index,
        })) || [],
        settings: {
          tabSize: editorConfig.get('tabSize'),
          insertSpaces: editorConfig.get('insertSpaces'),
          autoSave: filesConfig.get('autoSave'),
          encoding: filesConfig.get('encoding'),
          eol: filesConfig.get('eol'),
        },
        extensions: {
          // List some active extensions
          count: vscode.extensions.all.length,
          active: vscode.extensions.all
            .filter(e => e.isActive)
            .slice(0, 20)
            .map(e => ({
              id: e.id,
              name: e.packageJSON?.displayName || e.id,
            })),
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting workspace info: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * Helper to get scope name
 */
function getScopeName(scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined): string {
  if (scope === undefined) {
    return 'unknown';
  }
  if (scope === vscode.TaskScope.Global) {
    return 'global';
  }
  if (scope === vscode.TaskScope.Workspace) {
    return 'workspace';
  }
  if (typeof scope === 'object' && 'name' in scope) {
    return scope.name;
  }
  return 'unknown';
}

/**
 * vscode_open_xerebro_dashboard - Open the xatlas dashboard
 */
function registerOpenXerebroDashboard(): void {
  const definition: MCPTool = {
    name: 'vscode_open_xerebro_dashboard',
    description: 'Open the xatlas dashboard in VS Code',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    try {
      await vscode.commands.executeCommand('vscode-mcp-server.openDashboard');

      return {
        content: [
          {
            type: 'text',
            text: 'Opened xatlas dashboard',
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error opening dashboard: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}
