import * as vscode from 'vscode';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';
import { AgentDiscovery, ProjectInfo, ProjectActivity } from '../services/agentDiscovery';
import { TerminalWatcher, TerminalInfo } from '../services/terminalWatcher';
import { TmuxManager } from '../services/tmuxManager';
import { TerminalMonitor, TerminalState, StateChange } from '../services/terminalMonitor';
import { NotificationService } from '../services/notificationService';
import { actionLog } from '../services/actionLog';

/**
 * Dashboard MCP Tools
 *
 * These tools enable AI agents to fully control the dashboard via MCP:
 * - List, add, remove, reorder projects
 * - Create tmux-backed terminals for projects
 * - Get project details with terminal info
 * - All operations are headless and don't interrupt the user
 */

/**
 * Register all dashboard MCP tools
 */
export function registerDashboardTools(): void {
  registerDashboardListProjects();
  registerDashboardAddProject();
  registerDashboardRemoveProject();
  registerDashboardGetProject();
  registerDashboardCreateTerminal();
  registerDashboardReorderProjects();
  registerDashboardSetProjectColor();
  registerGetWebviews();
  registerDashboardGetState();
  registerTerminalMonitorStatus();
  registerTerminalMonitorStart();
  registerTerminalMonitorStop();
  registerNotificationConfig();
  registerNotificationTest();
  // Action log tools
  registerActionLogGet();
  registerActionLogStats();
  registerActionLogClear();
  // Terminal command history
  registerTerminalCommandHistory();
  registerMcpCreatedTerminals();
  // Card embedded terminal tools
  registerCardTerminalsList();
  registerCardTerminalRead();
  registerCardTerminalSend();
  // Direct tmux access (survives restarts)
  registerTmuxSessionsList();
  registerTmuxSessionRead();
  registerTmuxSessionSend();
}

/**
 * vscode_dashboard_list_projects - List all tracked projects with status
 */
function registerDashboardListProjects(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_list_projects',
    description: 'List all projects tracked in the dashboard with their status, terminals, and activity state',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          enum: ['name', 'activity', 'order'],
          description: 'Sort projects by name, activity level, or custom order (default: order)',
          default: 'order',
        },
        includeTerminals: {
          type: 'boolean',
          description: 'Include terminal details in response (default: true)',
          default: true,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const sortBy = (args.sortBy as string) ?? 'order';
    const includeTerminals = (args.includeTerminals as boolean) ?? true;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const projects = await agentDiscovery.discoverProjects();

      // Sort if requested
      let sortedProjects = [...projects];
      if (sortBy === 'name') {
        sortedProjects.sort((a, b) => a.name.localeCompare(b.name));
      } else if (sortBy === 'activity') {
        const activityOrder: Record<ProjectActivity, number> = {
          running: 0,
          waiting: 1,
          idle: 2,
        };
        sortedProjects.sort((a, b) => {
          const aOrder = activityOrder[a.activity || 'idle'];
          const bOrder = activityOrder[b.activity || 'idle'];
          return aOrder - bOrder;
        });
      }
      // 'order' keeps the default order from discoverProjects

      const projectList = sortedProjects.map((project) => {
        const base = {
          name: project.name,
          path: project.path,
          activity: project.activity || 'idle',
          isLocal: project.isLocal,
          accentColor: project.accentColor || null,
          agentCount: project.agents.length,
          terminalCount: project.terminals.length,
        };

        if (includeTerminals) {
          return {
            ...base,
            terminals: project.terminals.map((t) => ({
              processId: t.processId,
              name: t.name,
              agentType: t.agentType,
              isActive: t.isActive,
              lastOutputAt: t.lastOutputAt || null,
            })),
          };
        }

        return base;
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: projectList.length,
                sortedBy: sortBy,
                projects: projectList,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing projects: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_dashboard_add_project - Add a project to the dashboard
 */
function registerDashboardAddProject(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_add_project',
    description: 'Add a project to the dashboard by path. The project will be tracked and displayed in the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        name: {
          type: 'string',
          description: 'Display name for the project (defaults to directory name)',
        },
      },
      required: ['path'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPath = args.path as string;
    const name = (args.name as string) || projectPath.split('/').pop() || 'Project';

    try {
      const agentDiscovery = AgentDiscovery.getInstance();

      // Check if project already exists
      const existing = agentDiscovery.getTrackedProjects();
      const alreadyTracked = existing.some((p) => p.path === projectPath);

      if (alreadyTracked) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  added: false,
                  reason: 'Project already tracked',
                  path: projectPath,
                  name,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Add the project
      agentDiscovery.addProject(projectPath, name);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                added: true,
                project: {
                  name,
                  path: projectPath,
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
        content: [{ type: 'text', text: `Error adding project: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_dashboard_remove_project - Remove a project from the dashboard
 */
function registerDashboardRemoveProject(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_remove_project',
    description: 'Remove a project from the dashboard. This does not delete any files, just stops tracking it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the project to remove',
        },
      },
      required: ['path'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPath = args.path as string;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();

      // Check if project exists
      const existing = agentDiscovery.getTrackedProjects();
      const project = existing.find((p) => p.path === projectPath);

      if (!project) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  removed: false,
                  reason: 'Project not found',
                  path: projectPath,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Remove the project
      agentDiscovery.removeProject(projectPath);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                removed: true,
                project: {
                  name: project.name,
                  path: projectPath,
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
        content: [{ type: 'text', text: `Error removing project: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_dashboard_get_project - Get detailed info about a specific project
 */
function registerDashboardGetProject(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_get_project',
    description: 'Get detailed information about a specific project including all terminals and their states',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the project to get info for',
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include last terminal output in response (default: false)',
          default: false,
        },
        outputLines: {
          type: 'number',
          description: 'Number of output lines to include per terminal (default: 20)',
          default: 20,
        },
      },
      required: ['path'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPath = args.path as string;
    const includeOutput = (args.includeOutput as boolean) ?? false;
    const outputLines = (args.outputLines as number) ?? 20;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const terminalWatcher = TerminalWatcher.getInstance();
      const projects = await agentDiscovery.discoverProjects();

      const project = projects.find((p) => p.path === projectPath);

      if (!project) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  found: false,
                  path: projectPath,
                  availableProjects: projects.map((p) => ({ name: p.name, path: p.path })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Get detailed terminal info
      const terminalDetails = await Promise.all(
        project.terminals.map(async (t) => {
          const info = terminalWatcher.getTerminal(t.processId);
          const state = await terminalWatcher.getTerminalState(t.processId);

          const detail: Record<string, unknown> = {
            processId: t.processId,
            name: t.name,
            agentType: t.agentType,
            isActive: t.isActive,
            state,
            currentCommand: info?.currentCommand || null,
            tmuxSession: info?.tmuxSession || null,
            lastOutputAt: t.lastOutputAt || null,
          };

          if (includeOutput) {
            const output = await terminalWatcher.getLastOutput(t.processId, outputLines);
            detail.lastOutput = output;
          }

          return detail;
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                found: true,
                project: {
                  name: project.name,
                  path: project.path,
                  activity: project.activity || 'idle',
                  isLocal: project.isLocal,
                  accentColor: project.accentColor || null,
                },
                terminals: terminalDetails,
                agents: project.agents.map((a) => ({
                  type: a.type,
                  name: a.name,
                  color: a.color,
                  terminalId: a.terminalId,
                  isActive: a.isActive,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting project: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_dashboard_create_terminal - Create a tmux-backed terminal for a project
 */
function registerDashboardCreateTerminal(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_create_terminal',
    description:
      'Create a new tmux-backed terminal for a project. The terminal is associated with the project and can be controlled headlessly via MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path of the project to create terminal for',
        },
        name: {
          type: 'string',
          description: 'Name for the terminal (defaults to project name)',
        },
        show: {
          type: 'boolean',
          description: 'Show the terminal after creation (default: false for headless operation)',
          default: false,
        },
        embedded: {
          type: 'boolean',
          description: 'Create terminal embedded in dashboard card instead of VS Code terminal tab (default: false)',
          default: false,
        },
        env: {
          type: 'object',
          description: 'Environment variables to set in the terminal',
        },
      },
      required: ['projectPath'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    console.log('[dashboardTools] vscode_dashboard_create_terminal called with args:', JSON.stringify(args, null, 2));
    console.log('[dashboardTools] args.embedded raw value:', args.embedded, '| type:', typeof args.embedded);
    const projectPath = args.projectPath as string;
    const name = args.name as string | undefined;
    const show = (args.show as boolean) ?? false;
    // Handle both boolean true and string 'true' for robustness
    const embedded = args.embedded === true || args.embedded === 'true';
    console.log('[dashboardTools] embedded resolved to:', embedded);
    const env = args.env as Record<string, string> | undefined;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const terminalWatcher = TerminalWatcher.getInstance();
      const tmux = TmuxManager.getInstance();

      // Check if tmux is available
      const tmuxAvailable = await tmux.isAvailable();
      if (!tmuxAvailable) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  created: false,
                  error: 'tmux is not available',
                  hint: 'Install tmux with: brew install tmux (macOS) or apt install tmux (Linux)',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // Get project name for terminal naming
      const projects = await agentDiscovery.discoverProjects();
      const project = projects.find((p) => p.path === projectPath);
      const projectName = project?.name || projectPath.split('/').pop() || 'Terminal';
      const terminalName = name || projectName;

      // If embedded mode, send message to dashboard webview instead of creating VS Code terminal
      if (embedded) {
        console.log('[dashboardTools] embedded=true, checking DashboardPanel');
        const { DashboardPanel } = await import('../dashboard/DashboardPanel');
        console.log('[dashboardTools] DashboardPanel.currentPanel:', !!DashboardPanel.currentPanel);
        if (DashboardPanel.currentPanel) {
          DashboardPanel.currentPanel.sendCreateEmbeddedTerminalMessage(projectPath, terminalName);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    created: true,
                    embedded: true,
                    terminal: {
                      name: terminalName,
                      projectPath,
                      backend: 'tmux',
                      location: 'dashboard-card',
                    },
                    hint: 'Terminal is embedded in the dashboard card. The card will expand to show the terminal.',
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
                text: JSON.stringify(
                  {
                    created: false,
                    error: 'Dashboard panel is not open',
                    hint: 'Open the dashboard first with the "Xerebro: Open Dashboard" command, then retry with embedded=true',
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      }

      // Create tmux-backed terminal (standard VS Code terminal tab)
      const result = await tmux.createTerminal(terminalName, projectPath, env);
      const terminal = result.terminal;
      const tmuxSession = result.sessionName;

      // Get process ID and register with watcher
      const pid = await terminal.processId;
      if (pid) {
        terminalWatcher.setTmuxSession(pid, tmuxSession);
        // Associate terminal with project
        terminalWatcher.setTerminalProject(pid, projectPath);
        // Mark as MCP-created (AI-created)
        terminalWatcher.setCreatedByMcp(pid, true);
      }

      // Show terminal if requested
      if (show) {
        terminal.show(true); // preserveFocus = true
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                created: true,
                embedded: false,
                terminal: {
                  name: terminal.name,
                  processId: pid,
                  tmuxSession,
                  projectPath,
                  backend: 'tmux',
                  location: 'vscode-terminal-tab',
                },
                hint: 'Use vscode_terminal_send to send commands, vscode_terminal_read_buffer to read output',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_dashboard_reorder_projects - Reorder projects in the dashboard
 */
function registerDashboardReorderProjects(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_reorder_projects',
    description: 'Reorder projects in the dashboard. Provide an array of project paths in the desired order.',
    inputSchema: {
      type: 'object',
      properties: {
        order: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of project paths in desired display order',
        },
      },
      required: ['order'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const order = args.order as string[];

    try {
      if (!Array.isArray(order)) {
        return {
          content: [{ type: 'text', text: 'order must be an array of project paths' }],
          isError: true,
        };
      }

      const agentDiscovery = AgentDiscovery.getInstance();
      agentDiscovery.setProjectOrder(order);

      // Verify the new order
      const projects = await agentDiscovery.discoverProjects();
      const newOrder = projects.map((p) => ({ name: p.name, path: p.path }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                reordered: true,
                newOrder,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reordering projects: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_dashboard_set_project_color - Set the accent color for a project
 */
function registerDashboardSetProjectColor(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_set_project_color',
    description: 'Set the accent color for a project in the dashboard. Use hex colors like #ff6b00.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the project to set color for',
        },
        color: {
          type: 'string',
          description: 'Hex color code (e.g., #ff6b00). Omit to remove custom color.',
        },
      },
      required: ['path'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPath = args.path as string;
    const color = args.color as string | undefined;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();

      // Validate color format if provided
      if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  set: false,
                  error: 'Invalid color format. Use hex format like #ff6b00',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      agentDiscovery.setProjectColor(projectPath, color);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                set: true,
                path: projectPath,
                color: color || null,
                action: color ? 'color set' : 'color removed',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error setting project color: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_get_webviews - List all active webviews in VS Code
 */
function registerGetWebviews(): void {
  const definition: MCPTool = {
    name: 'vscode_get_webviews',
    description: 'List all active webviews in VS Code including dashboard panels, sidebar views, and their state',
    inputSchema: {
      type: 'object',
      properties: {
        includeHtml: {
          type: 'boolean',
          description: 'Include HTML content summary (default: false)',
          default: false,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const webviews: Array<{
        type: string;
        id: string;
        title?: string;
        visible: boolean;
        active: boolean;
        viewColumn?: number;
      }> = [];

      // Get all tab groups and look for webview panels
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          if (tab.input && typeof tab.input === 'object' && 'viewType' in tab.input) {
            const input = tab.input as { viewType: string };
            webviews.push({
              type: 'panel',
              id: input.viewType,
              title: tab.label,
              visible: tabGroup.isActive,
              active: tab.isActive,
              viewColumn: tabGroup.viewColumn,
            });
          }
        }
      }

      // Check for known dashboard webviews
      const { DashboardPanel } = await import('../dashboard/DashboardPanel');
      if (DashboardPanel.currentPanel) {
        const existingIdx = webviews.findIndex(w => w.id === 'aiAgentDashboard');
        if (existingIdx === -1) {
          webviews.push({
            type: 'dashboard-panel',
            id: 'aiAgentDashboard',
            title: 'Xerebro Dashboard',
            visible: true,
            active: true,
          });
        } else {
          webviews[existingIdx].type = 'dashboard-panel';
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: webviews.length,
                webviews,
                hint: 'Use vscode_dashboard_get_state for detailed dashboard state',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing webviews: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_dashboard_get_state - Get full dashboard state including all projects, terminals, and preview data
 */
function registerDashboardGetState(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_get_state',
    description: 'Get the complete dashboard state including all projects, terminals, activity status, and terminal preview content (ANSI stripped)',
    inputSchema: {
      type: 'object',
      properties: {
        includeTerminalOutput: {
          type: 'boolean',
          description: 'Include terminal output preview (default: true)',
          default: true,
        },
        outputLines: {
          type: 'number',
          description: 'Number of output lines per terminal (default: 30)',
          default: 30,
        },
        includeAgentDetails: {
          type: 'boolean',
          description: 'Include AI agent details for each project (default: true)',
          default: true,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const includeTerminalOutput = (args.includeTerminalOutput as boolean) ?? true;
    const outputLines = (args.outputLines as number) ?? 30;
    const includeAgentDetails = (args.includeAgentDetails as boolean) ?? true;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const terminalWatcher = TerminalWatcher.getInstance();
      const tmux = TmuxManager.getInstance();

      const projects = await agentDiscovery.discoverProjects();

      // Build detailed state for each project
      const projectStates = await Promise.all(
        projects.map(async (project) => {
          // Get terminal details with output
          const terminalStates = await Promise.all(
            project.terminals.map(async (terminal) => {
              const info = terminalWatcher.getTerminal(terminal.processId);
              const terminalState: Record<string, unknown> = {
                processId: terminal.processId,
                name: terminal.name,
                agentType: terminal.agentType,
                isActive: terminal.isActive,
                tmuxSession: info?.tmuxSession || null,
                currentCommand: info?.currentCommand || null,
                lastOutputAt: terminal.lastOutputAt || null,
              };

              if (includeTerminalOutput) {
                // Try to get output from tmux if available
                if (info?.tmuxSession) {
                  try {
                    const output = await tmux.readBuffer(info.tmuxSession, outputLines);
                    terminalState.outputPreview = output || '';
                    terminalState.outputSource = 'tmux';
                  } catch {
                    // Fall back to terminal watcher
                    const output = await terminalWatcher.getLastOutput(terminal.processId, outputLines);
                    terminalState.outputPreview = output || '';
                    terminalState.outputSource = 'watcher';
                  }
                } else {
                  const output = await terminalWatcher.getLastOutput(terminal.processId, outputLines);
                  terminalState.outputPreview = output || '';
                  terminalState.outputSource = 'watcher';
                }
              }

              return terminalState;
            })
          );

          const projectState: Record<string, unknown> = {
            name: project.name,
            path: project.path,
            activity: project.activity || 'idle',
            isLocal: project.isLocal,
            accentColor: project.accentColor || null,
            terminalCount: project.terminals.length,
            terminals: terminalStates,
          };

          if (includeAgentDetails) {
            projectState.agents = project.agents.map((agent) => ({
              type: agent.type,
              name: agent.name,
              color: agent.color,
              terminalId: agent.terminalId,
              isActive: agent.isActive,
            }));
          }

          return projectState;
        })
      );

      // Check if dashboard panel is open
      let dashboardPanelOpen = false;
      try {
        const { DashboardPanel } = await import('../dashboard/DashboardPanel');
        dashboardPanelOpen = !!DashboardPanel.currentPanel;
      } catch {
        // Ignore
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                dashboardPanelOpen,
                projectCount: projectStates.length,
                totalTerminals: projectStates.reduce((sum, p) => sum + (p.terminalCount as number), 0),
                projects: projectStates,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting dashboard state: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_monitor_status - Get status of all monitored terminals
 */
function registerTerminalMonitorStatus(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_monitor_status',
    description: 'Get the current state of all dashboard terminals including whether they are idle, processing, waiting for input, or have completed tasks. Also detects context usage warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        filterState: {
          type: 'string',
          enum: ['idle', 'processing', 'waiting_input', 'completed', 'error', 'context_warning'],
          description: 'Filter to only show terminals in this state (optional)',
        },
        filterAgent: {
          type: 'string',
          enum: ['claude', 'opencode', 'shell'],
          description: 'Filter by agent type (optional)',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filterState = args.filterState as TerminalState | undefined;
    const filterAgent = args.filterAgent as string | undefined;

    try {
      const monitor = TerminalMonitor.getInstance();
      let statuses = await monitor.getStatus();

      // Apply filters
      if (filterState) {
        statuses = statuses.filter(s => s.state === filterState);
      }
      if (filterAgent) {
        statuses = statuses.filter(s => s.agentType === filterAgent);
      }

      // Group by state for summary
      const summary: Record<string, number> = {
        idle: 0,
        processing: 0,
        waiting_input: 0,
        completed: 0,
        error: 0,
        context_warning: 0,
        unknown: 0,
      };
      for (const status of statuses) {
        summary[status.state] = (summary[status.state] || 0) + 1;
      }

      // Find terminals needing attention
      const needsAttention = statuses.filter(s =>
        s.state === 'waiting_input' ||
        s.state === 'error' ||
        s.state === 'context_warning' ||
        s.state === 'completed'
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                totalTerminals: statuses.length,
                summary,
                needsAttention: needsAttention.map(s => ({
                  session: s.sessionName,
                  state: s.state,
                  agent: s.agentType,
                  project: s.projectPath,
                  contextUsage: s.contextUsage,
                  hasQuestion: s.hasQuestion,
                })),
                allTerminals: statuses.map(s => ({
                  session: s.sessionName,
                  state: s.state,
                  agent: s.agentType,
                  project: s.projectPath,
                  contextUsage: s.contextUsage,
                  lastOutput: s.lastOutput.slice(-200),
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting terminal status: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_monitor_start - Start monitoring terminals for state changes
 */
function registerTerminalMonitorStart(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_monitor_start',
    description: 'Start monitoring dashboard terminals for state changes. Will notify when terminals transition between states (idle, processing, waiting_input, completed, error, context_warning).',
    inputSchema: {
      type: 'object',
      properties: {
        intervalMs: {
          type: 'number',
          description: 'Polling interval in milliseconds (default: 3000)',
          default: 3000,
        },
        notifyOnStates: {
          type: 'array',
          items: { type: 'string' },
          description: 'States to notify about (default: all important states)',
          default: ['waiting_input', 'completed', 'error', 'context_warning'],
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const intervalMs = (args.intervalMs as number) ?? 3000;
    const notifyOnStates = (args.notifyOnStates as string[]) ?? ['waiting_input', 'completed', 'error', 'context_warning'];

    try {
      const monitor = TerminalMonitor.getInstance();

      // Register callback for notifications
      monitor.onStateChange((change: StateChange) => {
        if (notifyOnStates.includes(change.newState)) {
          // Show VS Code notification
          const message = `🖥️ ${change.message}`;
          if (change.newState === 'error') {
            vscode.window.showErrorMessage(message);
          } else if (change.newState === 'waiting_input' || change.newState === 'context_warning') {
            vscode.window.showWarningMessage(message);
          } else {
            vscode.window.showInformationMessage(message);
          }
        }
      });

      monitor.start(intervalMs);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'monitoring_started',
                intervalMs,
                notifyOnStates,
                message: 'Terminal monitor started. You will be notified when terminals change state.',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error starting monitor: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_monitor_stop - Stop monitoring terminals
 */
function registerTerminalMonitorStop(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_monitor_stop',
    description: 'Stop monitoring dashboard terminals for state changes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    try {
      const monitor = TerminalMonitor.getInstance();
      monitor.stop();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'monitoring_stopped',
                message: 'Terminal monitor stopped.',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error stopping monitor: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_notification_config - Get or update notification configuration
 */
function registerNotificationConfig(): void {
  const definition: MCPTool = {
    name: 'vscode_notification_config',
    description: 'Get or update terminal notification configuration. Control which events trigger notifications and sounds.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Enable or disable all notifications',
        },
        soundEnabled: {
          type: 'boolean',
          description: 'Enable or disable sound with notifications',
        },
        notifyOnIdle: {
          type: 'boolean',
          description: 'Notify when AI becomes ready for input',
        },
        notifyOnWaitingInput: {
          type: 'boolean',
          description: 'Notify when AI asks a question',
        },
        notifyOnCompleted: {
          type: 'boolean',
          description: 'Notify when task completes',
        },
        notifyOnError: {
          type: 'boolean',
          description: 'Notify when error occurs',
        },
        notifyOnContextWarning: {
          type: 'boolean',
          description: 'Notify when context usage is high',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const notificationService = NotificationService.getInstance();

      // If any args provided, update config
      const hasUpdates = Object.keys(args).length > 0;
      if (hasUpdates) {
        notificationService.updateConfig(args);
      }

      // Return current config
      const config = notificationService.getConfig();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                updated: hasUpdates,
                config,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error with notification config: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_notification_test - Test notification with sound
 */
function registerNotificationTest(): void {
  const definition: MCPTool = {
    name: 'vscode_notification_test',
    description: 'Test the notification system by sending a test notification with sound.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['idle', 'waiting_input', 'completed', 'error', 'context_warning'],
          description: 'State to simulate for test notification (default: waiting_input)',
          default: 'waiting_input',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const state = (args.state as TerminalState) || 'waiting_input';
      const notificationService = NotificationService.getInstance();

      notificationService.testNotification(state);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tested: true,
                state,
                message: `Test notification sent for state: ${state}`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error testing notification: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_action_log_get - Get action history
 */
function registerActionLogGet(): void {
  const definition: MCPTool = {
    name: 'vscode_action_log_get',
    description: 'Get the history of MCP tool calls. Shows what the AI has been doing in VS Code.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of actions to return (default: 50)',
          default: 50,
        },
        status: {
          type: 'string',
          enum: ['pending', 'success', 'error'],
          description: 'Filter by status (optional)',
        },
        toolName: {
          type: 'string',
          description: 'Filter by tool name (partial match, optional)',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const limit = (args.limit as number) ?? 50;
      const status = args.status as string | undefined;
      const toolName = args.toolName as string | undefined;

      const actions = actionLog.getHistory(limit, { status, toolName });
      const pending = actionLog.getPending();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: actions.length,
                pendingCount: pending.length,
                actions: actions.map((a) => ({
                  id: a.id,
                  tool: a.toolName,
                  status: a.status,
                  timestamp: new Date(a.timestamp).toISOString(),
                  duration: a.duration ? `${a.duration}ms` : null,
                  args: a.args,
                  error: a.error,
                  // Truncate large results
                  result: a.result
                    ? JSON.stringify(a.result).slice(0, 200)
                    : null,
                })),
                pending: pending.map((a) => ({
                  id: a.id,
                  tool: a.toolName,
                  startedAt: new Date(a.timestamp).toISOString(),
                  args: a.args,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting action log: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_action_log_stats - Get action statistics
 */
function registerActionLogStats(): void {
  const definition: MCPTool = {
    name: 'vscode_action_log_stats',
    description: 'Get statistics about MCP tool usage including most used tools, success rate, etc.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    try {
      const stats = actionLog.getStats();

      const successRate = stats.totalActions > 0
        ? ((stats.successCount / stats.totalActions) * 100).toFixed(1)
        : '0';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalActions: stats.totalActions,
                successCount: stats.successCount,
                errorCount: stats.errorCount,
                pendingCount: stats.pendingCount,
                successRate: `${successRate}%`,
                lastActionAt: stats.lastActionAt
                  ? new Date(stats.lastActionAt).toISOString()
                  : null,
                topTools: stats.topTools,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting stats: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_action_log_clear - Clear action history
 */
function registerActionLogClear(): void {
  const definition: MCPTool = {
    name: 'vscode_action_log_clear',
    description: 'Clear the action history log.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be true to confirm clearing',
        },
      },
      required: ['confirm'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (!args.confirm) {
      return {
        content: [{ type: 'text', text: 'Set confirm: true to clear history' }],
      };
    }

    actionLog.clearHistory();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ cleared: true }, null, 2),
        },
      ],
    };
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_command_history - Get command history for a terminal
 */
function registerTerminalCommandHistory(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_command_history',
    description: 'Get the command history ("conversation") for a terminal. Shows all commands sent to the terminal, their sources (MCP/AI vs user), outputs, and execution status.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: {
          type: 'number',
          description: 'Process ID of the terminal',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of commands to return (default: 50)',
          default: 50,
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include command outputs in response (default: true)',
          default: true,
        },
        filterSource: {
          type: 'string',
          enum: ['mcp', 'user', 'unknown'],
          description: 'Filter by command source (optional)',
        },
      },
      required: ['processId'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const processId = args.processId as number;
    const limit = (args.limit as number) ?? 50;
    const includeOutput = (args.includeOutput as boolean) ?? true;
    const filterSource = args.filterSource as string | undefined;

    try {
      const terminalWatcher = TerminalWatcher.getInstance();
      const terminalInfo = terminalWatcher.getTerminal(processId);

      if (!terminalInfo) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Terminal not found',
              processId,
              hint: 'Use vscode_terminal_list to see available terminals',
            }, null, 2),
          }],
          isError: true,
        };
      }

      let history = terminalWatcher.getCommandHistory(processId, limit);

      // Filter by source if specified
      if (filterSource) {
        history = history.filter(cmd => cmd.source === filterSource);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            terminalId: processId,
            terminalName: terminalInfo.name,
            createdByMcp: terminalInfo.createdByMcp,
            agentType: terminalInfo.agentType,
            projectPath: terminalInfo.projectPath || null,
            commandCount: history.length,
            totalCommands: terminalInfo.commandHistory.length,
            commands: history.map(cmd => ({
              id: cmd.id,
              command: cmd.command,
              timestamp: new Date(cmd.timestamp).toISOString(),
              source: cmd.source,
              status: cmd.status,
              duration: cmd.duration ? `${cmd.duration}ms` : null,
              exitCode: cmd.exitCode ?? null,
              output: includeOutput && cmd.output
                ? cmd.output.slice(0, 1000)
                : null,
              outputTruncated: includeOutput && cmd.output
                ? cmd.output.length > 1000
                : false,
            })),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error getting command history: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_mcp_created_terminals - List terminals created by MCP (AI)
 */
function registerMcpCreatedTerminals(): void {
  const definition: MCPTool = {
    name: 'vscode_mcp_created_terminals',
    description: 'List all terminals that were created by MCP (AI). These are terminals the AI created to work on tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        includeHistory: {
          type: 'boolean',
          description: 'Include command history summary (default: true)',
          default: true,
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include last terminal output (default: false)',
          default: false,
        },
        outputLines: {
          type: 'number',
          description: 'Number of output lines to include (default: 20)',
          default: 20,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const includeHistory = (args.includeHistory as boolean) ?? true;
    const includeOutput = (args.includeOutput as boolean) ?? false;
    const outputLines = (args.outputLines as number) ?? 20;

    try {
      const terminalWatcher = TerminalWatcher.getInstance();
      const mcpTerminals = terminalWatcher.getMcpCreatedTerminals();

      const terminalDetails = await Promise.all(
        mcpTerminals.map(async (t) => {
          const detail: Record<string, unknown> = {
            processId: t.id,
            name: t.name,
            agentType: t.agentType,
            isActive: t.isActive,
            projectPath: t.projectPath || null,
            tmuxSession: t.tmuxSession || null,
            state: t.state,
          };

          if (includeHistory) {
            const mcpCommands = t.commandHistory.filter(c => c.source === 'mcp');
            detail.commandSummary = {
              total: t.commandHistory.length,
              fromMcp: mcpCommands.length,
              pending: t.commandHistory.filter(c => c.status === 'pending').length,
              errors: t.commandHistory.filter(c => c.status === 'error').length,
              lastCommand: t.commandHistory.length > 0
                ? {
                    command: t.commandHistory[t.commandHistory.length - 1].command,
                    status: t.commandHistory[t.commandHistory.length - 1].status,
                    timestamp: new Date(t.commandHistory[t.commandHistory.length - 1].timestamp).toISOString(),
                  }
                : null,
            };
          }

          if (includeOutput) {
            detail.lastOutput = await terminalWatcher.getLastOutput(t.id, outputLines);
          }

          return detail;
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: mcpTerminals.length,
            terminals: terminalDetails,
            hint: 'Use vscode_terminal_command_history to see full command history for a terminal',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing MCP terminals: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_tmux_sessions_list - List all tmux sessions (card terminals persist here)
 */
function registerTmuxSessionsList(): void {
  const definition: MCPTool = {
    name: 'vscode_tmux_sessions_list',
    description: 'List all tmux sessions. Card terminals use tmux and persist across VS Code restarts. Use this to find and read from any terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Filter sessions by name pattern (e.g., "xvsc" for card terminals)',
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include recent output from each session (default: false)',
          default: false,
        },
        outputLines: {
          type: 'number',
          description: 'Number of output lines to include (default: 20)',
          default: 20,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filter = args.filter as string | undefined;
    const includeOutput = (args.includeOutput as boolean) ?? false;
    const outputLines = (args.outputLines as number) ?? 20;

    try {
      const tmux = TmuxManager.getInstance();
      const sessions = await tmux.listSessions();

      let filteredSessions = sessions;
      if (filter) {
        filteredSessions = sessions.filter(s => s.includes(filter));
      }

      const sessionDetails = await Promise.all(
        filteredSessions.map(async (sessionName) => {
          const detail: Record<string, unknown> = {
            sessionName,
            isCardTerminal: sessionName.startsWith('xvsc_'),
          };

          if (includeOutput) {
            const output = await tmux.readBuffer(sessionName, outputLines);
            detail.output = output || '';
          }

          return detail;
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: sessionDetails.length,
            sessions: sessionDetails,
            hint: 'Use vscode_tmux_session_read to read more output, vscode_tmux_session_send to send commands',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing tmux sessions: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_tmux_session_read - Read output from a tmux session
 */
function registerTmuxSessionRead(): void {
  const definition: MCPTool = {
    name: 'vscode_tmux_session_read',
    description: 'Read the output buffer from a tmux session (50K line scrollback).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionName: {
          type: 'string',
          description: 'The tmux session name (from vscode_tmux_sessions_list)',
        },
        lines: {
          type: 'number',
          description: 'Number of lines to read (default: 100)',
          default: 100,
        },
      },
      required: ['sessionName'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const sessionName = args.sessionName as string;
    const lines = (args.lines as number) ?? 100;

    try {
      const tmux = TmuxManager.getInstance();
      const output = await tmux.readBuffer(sessionName, lines);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sessionName,
            lines,
            output: output || '',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading tmux session: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_tmux_session_send - Send text to a tmux session
 */
function registerTmuxSessionSend(): void {
  const definition: MCPTool = {
    name: 'vscode_tmux_session_send',
    description: 'Send text/command to a tmux session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionName: {
          type: 'string',
          description: 'The tmux session name (from vscode_tmux_sessions_list)',
        },
        text: {
          type: 'string',
          description: 'Text to send to the session',
        },
        addNewLine: {
          type: 'boolean',
          description: 'Add newline after text (default: true)',
          default: true,
        },
      },
      required: ['sessionName', 'text'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const sessionName = args.sessionName as string;
    const text = args.text as string;
    const addNewLine = (args.addNewLine as boolean) ?? true;

    try {
      const tmux = TmuxManager.getInstance();
      const textToSend = addNewLine ? text + '\n' : text;
      await tmux.sendKeys(sessionName, textToSend);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sent: true,
            sessionName,
            text,
            addNewLine,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error sending to tmux session: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_card_terminals_list - List all active floating window terminals in the dashboard
 */
function registerCardTerminalsList(): void {
  const definition: MCPTool = {
    name: 'vscode_card_terminals_list',
    description: 'List all active floating window terminals in the dashboard. These are terminals inside dashboard floating windows (opened by clicking project cards).',
    inputSchema: {
      type: 'object',
      properties: {
        includeOutput: {
          type: 'boolean',
          description: 'Include recent output from each terminal (default: false)',
          default: false,
        },
        outputLines: {
          type: 'number',
          description: 'Number of output lines to include (default: 30)',
          default: 30,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const includeOutput = (args.includeOutput as boolean) ?? false;
    const outputLines = (args.outputLines as number) ?? 30;

    try {
      const { DashboardPanel } = await import('../dashboard/DashboardPanel');

      if (!DashboardPanel.currentPanel) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: 0,
              terminals: [],
              hint: 'Dashboard panel is not open. Open it first with vscode_open_xerebro_dashboard.',
            }, null, 2),
          }],
        };
      }

      const floatingTerminals = DashboardPanel.currentPanel.getFloatingWindowTerminals();

      const terminalDetails = await Promise.all(
        floatingTerminals.map(async (t) => {
          const detail: Record<string, unknown> = {
            clientId: t.clientId,
            sessionName: t.sessionName,
            projectPath: t.projectPath,
            terminalId: t.terminalId,
          };

          if (includeOutput) {
            const output = await DashboardPanel.currentPanel!.readFloatingWindowOutput(t.clientId, outputLines);
            detail.output = output || '';
          }

          return detail;
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: floatingTerminals.length,
            terminals: terminalDetails,
            hint: 'Use vscode_card_terminal_read to read terminal output, vscode_card_terminal_send to send commands',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing floating window terminals: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_card_terminal_read - Read output from a floating window terminal
 */
function registerCardTerminalRead(): void {
  const definition: MCPTool = {
    name: 'vscode_card_terminal_read',
    description: 'Read the output buffer from a floating window terminal in the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          description: 'The clientId of the floating window terminal (from vscode_card_terminals_list)',
        },
        lines: {
          type: 'number',
          description: 'Number of lines to read (default: 100)',
          default: 100,
        },
      },
      required: ['clientId'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const clientId = args.clientId as string;
    const lines = (args.lines as number) ?? 100;

    try {
      const { DashboardPanel } = await import('../dashboard/DashboardPanel');

      if (!DashboardPanel.currentPanel) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Dashboard panel is not open',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const output = await DashboardPanel.currentPanel.readFloatingWindowOutput(clientId, lines);

      if (output === null) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Floating window terminal not found',
              clientId,
              hint: 'Use vscode_card_terminals_list to see available terminals',
            }, null, 2),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            clientId,
            lines,
            output,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading floating window terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_card_terminal_send - Send text to a floating window terminal
 */
function registerCardTerminalSend(): void {
  const definition: MCPTool = {
    name: 'vscode_card_terminal_send',
    description: 'Send text/command to a floating window terminal in the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          description: 'The clientId of the floating window terminal (from vscode_card_terminals_list)',
        },
        text: {
          type: 'string',
          description: 'Text to send to the terminal',
        },
        addNewLine: {
          type: 'boolean',
          description: 'Add newline after text (default: true)',
          default: true,
        },
      },
      required: ['clientId', 'text'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const clientId = args.clientId as string;
    const text = args.text as string;
    const addNewLine = (args.addNewLine as boolean) ?? true;

    try {
      const { DashboardPanel } = await import('../dashboard/DashboardPanel');

      if (!DashboardPanel.currentPanel) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Dashboard panel is not open',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const success = await DashboardPanel.currentPanel.sendToFloatingWindow(clientId, text, addNewLine);

      if (!success) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Floating window terminal not found',
              clientId,
              hint: 'Use vscode_card_terminals_list to see available terminals',
            }, null, 2),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sent: true,
            clientId,
            text,
            addNewLine,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error sending to floating window terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}
