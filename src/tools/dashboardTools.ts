import * as vscode from 'vscode';
import * as path from 'path';
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
 * - Create and control collaborative project terminals
 * - Get project details with terminal info
 * - Collaboration-first defaults (visual card terminals), with optional headless paths
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
  registerCardTerminalOpen();
  registerCardTerminalRead();
  registerCardTerminalSend();
  registerProjectTerminalsList();
  registerProjectTerminalsClose();
  registerProjectTerminalSend();
  registerProjectTerminalRead();
  // Direct tmux access (survives restarts)
  registerTmuxSessionsList();
  registerTmuxSessionRead();
  registerTmuxSessionSend();
}

async function ensureDashboardPanelOpen(): Promise<import('../dashboard/DashboardPanel').DashboardPanel | null> {
  const { DashboardPanel } = await import('../dashboard/DashboardPanel');
  if (!DashboardPanel.currentPanel) {
    await vscode.commands.executeCommand('vscode-mcp-server.openDashboard');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return DashboardPanel.currentPanel || null;
}

function ensureProjectTracked(
  agentDiscovery: AgentDiscovery,
  projectPath: string,
  autoAddProject: boolean
): { tracked: boolean; projectName: string } {
  const existing = agentDiscovery.getTrackedProjects().find((p) => p.path === projectPath);
  if (existing) {
    return { tracked: true, projectName: existing.name };
  }

  const projectName = path.basename(projectPath) || 'Project';
  if (!autoAddProject) {
    return { tracked: false, projectName };
  }

  agentDiscovery.addProject(projectPath, projectName);
  return { tracked: true, projectName };
}

function isSameProjectPath(left: string, right: string): boolean {
  try {
    return path.resolve(left) === path.resolve(right);
  } catch {
    return left === right;
  }
}

async function resolveProjectPath(
  projectPath: string | undefined,
  projectName: string | undefined,
  agentDiscovery: AgentDiscovery
): Promise<{ projectPath?: string; projectName?: string; project?: ProjectInfo }> {
  const normalizedProjectPath = typeof projectPath === 'string' && projectPath.trim() ? projectPath.trim() : undefined;
  const normalizedProjectName = typeof projectName === 'string' && projectName.trim() ? projectName.trim() : undefined;

  const projects = await agentDiscovery.discoverProjects();

  if (normalizedProjectPath) {
    const found = projects.find((p) => isSameProjectPath(p.path, normalizedProjectPath));
    return {
      projectPath: normalizedProjectPath,
      projectName: found?.name || normalizedProjectName || path.basename(normalizedProjectPath) || 'Project',
      project: found,
    };
  }

  if (!normalizedProjectName) {
    return {};
  }

  const lowered = normalizedProjectName.toLowerCase();
  const found = projects.find((p) => p.name.toLowerCase() === lowered);
  if (!found) {
    return {};
  }

  return {
    projectPath: found.path,
    projectName: found.name,
    project: found,
  };
}

type OpenProjectTerminalOptions = {
  clientId?: string;
  terminalId?: number;
  terminalName?: string;
  createNewTerminal?: boolean;
  visibilityMode?: VisibilityMode;
};

type ProjectTerminalTarget = {
  clientId?: string;
  sessionName?: string;
  terminalId?: number;
  created: boolean;
  source: 'attached' | 'detached' | 'opened';
  error?: string;
};

type VisibilityMode = 'background' | 'foreground' | 'card_open';
type UiAction = 'none' | 'opened_card' | 'opened_window' | 'focused_window';

function normalizeVisibilityMode(
  value: unknown,
  fallback: VisibilityMode = 'background'
): VisibilityMode {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'background' || normalized === 'foreground' || normalized === 'card_open') {
    return normalized;
  }
  return fallback;
}

function resolveCreateVisibilityMode(args: Record<string, unknown>): VisibilityMode {
  const explicit = normalizeVisibilityMode(args.visibilityMode, 'background');
  if (typeof args.visibilityMode === 'string') {
    return explicit;
  }

  const headless = args.headless === true || args.headless === 'true';
  if (headless) {
    return 'background';
  }
  // Default to non-disruptive behavior unless visibilityMode is explicitly provided.
  return 'background';
}

function deriveUiAction(target: ProjectTerminalTarget, visibilityMode: VisibilityMode): UiAction {
  if (target.source === 'attached' || target.source === 'detached') {
    return 'none';
  }
  if (visibilityMode === 'foreground') {
    return 'focused_window';
  }
  if (visibilityMode === 'card_open') {
    return 'opened_card';
  }
  return 'opened_window';
}

async function createDetachedTmuxTerminal(
  tmux: TmuxManager,
  projectPath: string,
  terminalName?: string
): Promise<{ sessionName: string; terminalId: number }> {
  const terminalId = Date.now();
  const requestedName =
    typeof terminalName === 'string' && terminalName.trim()
      ? terminalName.trim()
      : path.basename(projectPath) || 'Terminal';
  const sessionName = await tmux.createSession(terminalId, requestedName, projectPath);
  return { sessionName, terminalId };
}

async function ensureProjectTerminalClient(
  panel: import('../dashboard/DashboardPanel').DashboardPanel | null,
  projectPath: string,
  options?: OpenProjectTerminalOptions
): Promise<ProjectTerminalTarget> {
  const visibilityMode = options?.visibilityMode ?? 'background';
  const tmux = TmuxManager.getInstance();
  try {
    await tmux.refreshTrackedSessions();
  } catch {
    // Best-effort refresh only.
  }

  const trackedSessionNames = new Set(tmux.getAllSessions().map((session) => session.sessionName));
  const allTerminals = panel ? panel.getFloatingWindowTerminals() : [];
  const projectTerminals = allTerminals
    .filter((terminal) => isSameProjectPath(terminal.projectPath, projectPath))
    .filter((terminal) => trackedSessionNames.has(terminal.sessionName))
    .sort((a, b) => (b.terminalId || 0) - (a.terminalId || 0));
  const attachedSessionKeys = new Set(
    projectTerminals.map((terminal) => `${terminal.sessionName}:${terminal.terminalId}`)
  );
  const detachedSessions = tmux
    .getAllSessions()
    .filter(
      (session) =>
        typeof session.cwd === 'string' &&
        session.cwd.length > 0 &&
        isSameProjectPath(session.cwd, projectPath) &&
        !attachedSessionKeys.has(`${session.sessionName}:${session.terminalId}`)
    )
    .sort((a, b) => (b.terminalId || 0) - (a.terminalId || 0));

  const requestedClientId = typeof options?.clientId === 'string' && options.clientId.trim() ? options.clientId.trim() : undefined;

  if (requestedClientId) {
    if (!panel) {
      return {
        created: false,
        source: 'attached',
        error: 'clientId targeting requires dashboard panel to be open',
      };
    }

    const explicit = projectTerminals.find((terminal) => terminal.clientId === requestedClientId);
    if (explicit) {
      return { clientId: explicit.clientId, terminalId: explicit.terminalId, created: false, source: 'attached' };
    }
    return {
      created: false,
      source: 'attached',
      error: `Terminal clientId "${requestedClientId}" is not attached to project ${projectPath}`,
    };
  }

  const requestedTerminalId =
    typeof options?.terminalId === 'number' && Number.isFinite(options.terminalId)
      ? options.terminalId
      : undefined;

  const requestedName =
    typeof options?.terminalName === 'string' && options.terminalName.trim()
      ? options.terminalName.trim()
      : undefined;
  const createNewTerminal = options?.createNewTerminal ?? false;

  let resolvedTerminalId =
    requestedTerminalId !== undefined
      ? requestedTerminalId
      : requestedName
        ? panel?.resolveCardTerminalId(projectPath, requestedName)
        : undefined;

  if (resolvedTerminalId === undefined && requestedName) {
    const byName = tmux.getSessionByName(requestedName);
    if (
      byName &&
      typeof byName.cwd === 'string' &&
      byName.cwd.length > 0 &&
      isSameProjectPath(byName.cwd, projectPath)
    ) {
      resolvedTerminalId = byName.terminalId;
    }
  }

  // First preference: already attached collaborative terminal.
  if (resolvedTerminalId !== undefined) {
    const byTerminalId = projectTerminals.find((terminal) => terminal.terminalId === resolvedTerminalId);
    if (byTerminalId && !createNewTerminal) {
      return {
        clientId: byTerminalId.clientId,
        terminalId: byTerminalId.terminalId,
        created: false,
        source: 'attached',
      };
    }
  } else if (requestedName && !createNewTerminal) {
    const normalizedRequestedName = requestedName.toLowerCase();
    const byAttachedName = projectTerminals.find((terminal) => {
      const tmuxInfo = tmux.getSessionByTerminalId(terminal.terminalId);
      const tmuxName = (tmuxInfo?.terminalName || '').trim().toLowerCase();
      return tmuxName.length > 0 && tmuxName === normalizedRequestedName;
    });

    if (byAttachedName) {
      return {
        clientId: byAttachedName.clientId,
        terminalId: byAttachedName.terminalId,
        created: false,
        source: 'attached',
      };
    }
  } else if (!requestedName && !createNewTerminal && projectTerminals.length > 0) {
    return {
      clientId: projectTerminals[0].clientId,
      terminalId: projectTerminals[0].terminalId,
      created: false,
      source: 'attached',
    };
  }

  if (visibilityMode === 'background') {
    if (!createNewTerminal) {
      let detachedCandidate:
        | ReturnType<TmuxManager['getAllSessions']>[number]
        | undefined;

      if (resolvedTerminalId !== undefined) {
        detachedCandidate = detachedSessions.find((session) => session.terminalId === resolvedTerminalId);
      } else if (requestedName) {
        const normalizedName = requestedName.toLowerCase();
        detachedCandidate = detachedSessions.find(
          (session) => (session.terminalName || '').trim().toLowerCase() === normalizedName
        );
      } else {
        detachedCandidate = detachedSessions[0];
      }

      if (detachedCandidate) {
        return {
          sessionName: detachedCandidate.sessionName,
          terminalId: detachedCandidate.terminalId,
          created: false,
          source: 'detached',
        };
      }
    }

    const createdDetached = await createDetachedTmuxTerminal(tmux, projectPath, requestedName);
    return {
      sessionName: createdDetached.sessionName,
      terminalId: createdDetached.terminalId,
      created: true,
      source: 'detached',
    };
  }

  // Fallback: open/attach visually in dashboard.
  if (!panel) {
    return {
      created: false,
      source: 'opened',
      error: 'Dashboard panel is required for non-background visibility modes',
    };
  }

  const opened = await panel.openCardTerminal(projectPath, {
    terminalName: requestedName,
    terminalId: resolvedTerminalId,
    createNewTerminal: createNewTerminal,
  });

  if (!opened.success || !opened.clientId) {
    return {
      created: false,
      source: 'opened',
      error: opened.error || `Unable to open collaborative terminal for ${projectPath}`,
    };
  }

  return { clientId: opened.clientId, terminalId: resolvedTerminalId, created: true, source: 'opened' };
}

type CollaborationState =
  | 'idle'
  | 'processing'
  | 'waiting_input'
  | 'completed'
  | 'error'
  | 'unknown';

type OutputObservation = {
  state: CollaborationState;
  stateReason: string;
  commandEchoed: boolean;
  observedMs: number;
  outputTail: string;
};

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) {
      return line;
    }
  }
  return '';
}

function classifyCollaborativeOutput(raw: string): { state: CollaborationState; reason: string } {
  const text = raw || '';
  const lastLine = lastNonEmptyLine(text);

  // High-priority: obvious errors
  if (/(traceback|exception|fatal|command not found|no such file|permission denied|error:)/i.test(text)) {
    return { state: 'error', reason: 'error_pattern' };
  }

  // Waiting for user input / selection
  if (
    /(\?\s*$)|(\[Y\/n\])|(\[y\/N\])|(select.*:)|(choose.*:)|(pick.*:)|(enter.*:)|(confirm.*:)|(what would you like)|(should i)/im.test(
      text
    )
  ) {
    return { state: 'waiting_input', reason: 'input_prompt' };
  }

  // Ongoing work indicators
  if (/(thinking|processing|loading|analyzing|running|executing|working)/i.test(text)) {
    return { state: 'processing', reason: 'processing_pattern' };
  }
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text)) {
    return { state: 'processing', reason: 'spinner' };
  }

  // Completion hints from common tools
  if (/(completed|done|finished|success|all set|ran )/i.test(text)) {
    return { state: 'completed', reason: 'completion_pattern' };
  }

  // Prompt visible -> terminal is currently idle/ready.
  if (/[$#%>❯]\s*$/.test(lastLine)) {
    return { state: 'idle', reason: 'prompt_visible' };
  }

  return { state: 'unknown', reason: 'no_match' };
}

function toOutputTail(output: string, maxChars: number): string {
  if (!output) {
    return '';
  }
  return output.length > maxChars ? output.slice(-maxChars) : output;
}

async function observeCollaborativeSend(
  panel: import('../dashboard/DashboardPanel').DashboardPanel,
  clientId: string,
  commandText: string,
  options?: {
    observeMs?: number;
    pollMs?: number;
    lines?: number;
    waitForFinalState?: boolean;
    maxTailChars?: number;
  }
): Promise<OutputObservation> {
  const observeMs = Math.max(0, Math.min((options?.observeMs ?? 1800), 15000));
  const pollMs = Math.max(100, Math.min((options?.pollMs ?? 250), 1000));
  const lines = Math.max(20, Math.min((options?.lines ?? 120), 1000));
  const waitForFinalState = (options?.waitForFinalState as boolean) ?? false;
  const maxTailChars = Math.max(500, Math.min((options?.maxTailChars ?? 6000), 40000));

  const startedAt = Date.now();
  let lastOutput = (await panel.readFloatingWindowOutput(clientId, lines)) || '';
  let lastState = classifyCollaborativeOutput(lastOutput);
  let echoed = commandText.trim().length === 0;

  // Fast path when no observation is requested.
  if (observeMs === 0) {
    return {
      state: lastState.state,
      stateReason: lastState.reason,
      commandEchoed: echoed,
      observedMs: 0,
      outputTail: toOutputTail(lastOutput, maxTailChars),
    };
  }

  while (Date.now() - startedAt < observeMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = (await panel.readFloatingWindowOutput(clientId, lines)) || '';
    if (current) {
      lastOutput = current;
      lastState = classifyCollaborativeOutput(current);
      if (!echoed && commandText.trim()) {
        echoed = current.includes(commandText.trim());
      }
      if (
        waitForFinalState &&
        (lastState.state === 'idle' || lastState.state === 'completed' || lastState.state === 'waiting_input' || lastState.state === 'error')
      ) {
        break;
      }
    }
  }

  return {
    state: lastState.state,
    stateReason: lastState.reason,
    commandEchoed: echoed,
    observedMs: Date.now() - startedAt,
    outputTail: toOutputTail(lastOutput, maxTailChars),
  };
}

async function observeTmuxSend(
  tmux: TmuxManager,
  sessionName: string,
  commandText: string,
  options?: {
    observeMs?: number;
    pollMs?: number;
    lines?: number;
    waitForFinalState?: boolean;
    maxTailChars?: number;
  }
): Promise<OutputObservation> {
  const observeMs = Math.max(0, Math.min((options?.observeMs ?? 1800), 15000));
  const pollMs = Math.max(100, Math.min((options?.pollMs ?? 250), 1000));
  const lines = Math.max(20, Math.min((options?.lines ?? 120), 1000));
  const waitForFinalState = (options?.waitForFinalState as boolean) ?? false;
  const maxTailChars = Math.max(500, Math.min((options?.maxTailChars ?? 6000), 40000));

  const startedAt = Date.now();
  let lastOutput = (await tmux.readBuffer(sessionName, lines)) || '';
  let lastState = classifyCollaborativeOutput(lastOutput);
  let echoed = commandText.trim().length === 0;

  if (observeMs === 0) {
    return {
      state: lastState.state,
      stateReason: lastState.reason,
      commandEchoed: echoed,
      observedMs: 0,
      outputTail: toOutputTail(lastOutput, maxTailChars),
    };
  }

  while (Date.now() - startedAt < observeMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = (await tmux.readBuffer(sessionName, lines)) || '';
    if (current) {
      lastOutput = current;
      lastState = classifyCollaborativeOutput(current);
      if (!echoed && commandText.trim()) {
        echoed = current.includes(commandText.trim());
      }
      if (
        waitForFinalState &&
        (lastState.state === 'idle' || lastState.state === 'completed' || lastState.state === 'waiting_input' || lastState.state === 'error')
      ) {
        break;
      }
    }
  }

  return {
    state: lastState.state,
    stateReason: lastState.reason,
    commandEchoed: echoed,
    observedMs: Date.now() - startedAt,
    outputTail: toOutputTail(lastOutput, maxTailChars),
  };
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
 * vscode_dashboard_create_terminal - Create a project terminal (collaborative by default)
 */
function registerDashboardCreateTerminal(): void {
  const definition: MCPTool = {
    name: 'vscode_dashboard_create_terminal',
    description:
      'Create a terminal for a project. Defaults to background collaborative mode (non-disruptive). Use visibilityMode to open/focus visually.',
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
        createNewTerminal: {
          type: 'boolean',
          description: 'When using embedded mode, create a new terminal tab in that project before attaching (default: true)',
          default: true,
        },
        show: {
          type: 'boolean',
          description: 'Show the VS Code terminal tab after creation (only applies when embedded=false, default: true)',
          default: true,
        },
        embedded: {
          type: 'boolean',
          description: 'Create/use terminal embedded in dashboard project card (default: true for collaborative behavior)',
          default: true,
        },
        headless: {
          type: 'boolean',
          description: 'Force headless/non-visual behavior (default: false). When true, creates regular VS Code terminal tab and does not auto-open card terminal.',
          default: false,
        },
        visibilityMode: {
          type: 'string',
          enum: ['background', 'foreground', 'card_open'],
          description: 'How visible the terminal should be: background (default, non-disruptive), foreground (focus), card_open (open card/window without focus steal where possible).',
          default: 'background',
        },
        autoAddProject: {
          type: 'boolean',
          description: 'Automatically add project to dashboard tracking if missing (default: true)',
          default: true,
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
    const show = (args.show as boolean) ?? true;
    const createNewTerminal = (args.createNewTerminal as boolean) ?? true;
    const headless = args.headless === true || args.headless === 'true';
    const autoAddProject = (args.autoAddProject as boolean) ?? true;
    const visibilityMode = resolveCreateVisibilityMode(args);
    // Embedded defaults to true unless explicitly set false.
    const embedded = args.embedded === undefined
      ? true
      : args.embedded === true || args.embedded === 'true';
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

      // Ensure project is tracked so it appears in dashboard flows.
      const tracked = ensureProjectTracked(agentDiscovery, projectPath, autoAddProject);
      if (!tracked.tracked) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  created: false,
                  error: 'Project is not tracked in dashboard',
                  projectPath,
                  hint: 'Enable autoAddProject=true or add it first with vscode_dashboard_add_project',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const terminalName = name || tracked.projectName;
      const collaborative = !headless && embedded;

      // Collaborative path supports both non-disruptive background and visible modes.
      if (collaborative) {
        if (visibilityMode === 'background') {
          try {
            await tmux.refreshTrackedSessions();
          } catch {
            // Best-effort refresh only.
          }

          let detachedSession:
            | ReturnType<TmuxManager['getAllSessions']>[number]
            | undefined;

          if (!createNewTerminal) {
            const allProjectSessions = tmux
              .getAllSessions()
              .filter(
                (session) =>
                  typeof session.cwd === 'string' &&
                  session.cwd.length > 0 &&
                  isSameProjectPath(session.cwd, projectPath)
              )
              .sort((a, b) => (b.terminalId || 0) - (a.terminalId || 0));

            const normalizedRequestedName = terminalName.trim().toLowerCase();
            detachedSession = allProjectSessions.find(
              (session) => (session.terminalName || '').trim().toLowerCase() === normalizedRequestedName
            ) || allProjectSessions[0];
          }

          const detached = detachedSession
            ? {
                sessionName: detachedSession.sessionName,
                terminalId: detachedSession.terminalId,
                terminalName: detachedSession.terminalName || terminalName,
                created: false,
              }
            : {
                ...(await createDetachedTmuxTerminal(tmux, projectPath, terminalName)),
                terminalName,
                created: true,
              };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    created: detached.created,
                    embedded: true,
                    collaborative: true,
                    visibilityModeApplied: visibilityMode,
                    uiAction: 'none' as UiAction,
                    terminal: {
                      name: detached.terminalName,
                      projectPath,
                      backend: 'tmux',
                      location: 'background-session',
                      clientId: null,
                      terminalId: detached.terminalId,
                      sessionName: detached.sessionName,
                    },
                    hint: 'Running in background. Open the project card/window any time to watch and collaborate live.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const panel = await ensureDashboardPanelOpen();
        if (!panel) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    created: false,
                    error: 'Dashboard panel could not be opened',
                    hint: 'Open the xatlas dashboard manually with vscode_open_xerebro_dashboard and retry',
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        const opened = await panel.openCardTerminal(projectPath, {
          terminalName: terminalName,
          createNewTerminal: createNewTerminal,
        });

        if (!opened.success || !opened.clientId) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    created: false,
                    error: opened.error || 'Failed to open collaborative card terminal',
                    projectPath,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  created: true,
                  embedded: true,
                  collaborative: true,
                  visibilityModeApplied: visibilityMode,
                  uiAction: visibilityMode === 'foreground' ? 'focused_window' : 'opened_card',
                  terminal: {
                    name: terminalName,
                    projectPath,
                    backend: 'tmux',
                    location: 'dashboard-card',
                    clientId: opened.clientId,
                  },
                  hint: 'Collaborative terminal is visible in the project card. Use vscode_project_terminal_send/read or vscode_card_terminal_send/read with clientId.',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Headless/explicit non-embedded path: create tmux-backed VS Code terminal tab.
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
                collaborative: false,
                terminal: {
                  name: terminal.name,
                  processId: pid,
                  tmuxSession,
                  projectPath,
                  backend: 'tmux',
                  location: 'vscode-terminal-tab',
                },
                hint: 'Headless/non-embedded mode. For collaborative visible control, use embedded=true (default) and vscode_project_terminal_send/read.',
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
            title: 'xatlas Dashboard',
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
    description: 'Send and submit text/command to a tmux session. Just provide the text - Enter is handled automatically for reliable submission.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionName: {
          type: 'string',
          description: 'The tmux session name (from vscode_tmux_sessions_list)',
        },
        text: {
          type: 'string',
          description: 'Text/command to send and submit. Enter is sent automatically.',
        },
        addNewLine: {
          type: 'boolean',
          description: 'Submit after text (default: true). Set false to just type without submitting.',
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

      // Two-step approach for reliable submission:
      // 1. Send text without Enter (types the text)
      // 2. Send Enter separately (submits)
      // This works for both regular shells and Claude Code terminals
      if (addNewLine && text.length > 0) {
        // Step 1: Send text without newline
        await tmux.sendKeys(sessionName, text, false);
        // Small delay to ensure text is received
        await new Promise(resolve => setTimeout(resolve, 50));
        // Step 2: Send Enter to submit
        await tmux.sendKeys(sessionName, '', true);
      } else if (addNewLine) {
        // Just send Enter
        await tmux.sendKeys(sessionName, '', true);
      } else {
        // Just send text without Enter
        await tmux.sendKeys(sessionName, text, false);
      }

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
 * vscode_card_terminals_list - List all active collaborative terminals in the dashboard
 */
function registerCardTerminalsList(): void {
  const definition: MCPTool = {
    name: 'vscode_card_terminals_list',
    description:
      'List all active collaborative dashboard terminals (floating windows and project-card embedded terminals).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Optional project path to filter terminals to a single project',
        },
        projectName: {
          type: 'string',
          description: 'Optional project name to filter terminals when projectPath is not provided',
        },
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
    const projectPathArg = args.projectPath as string | undefined;
    const projectNameArg = args.projectName as string | undefined;
    const includeOutput = (args.includeOutput as boolean) ?? false;
    const outputLines = (args.outputLines as number) ?? 30;

    try {
      const panel = await ensureDashboardPanelOpen();
      if (!panel) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: 0,
              terminals: [],
              hint: 'Dashboard panel could not be opened.',
            }, null, 2),
          }],
        };
      }

      const agentDiscovery = AgentDiscovery.getInstance();
      const resolved = await resolveProjectPath(projectPathArg, projectNameArg, agentDiscovery);

      if ((projectPathArg || projectNameArg) && !resolved.projectPath) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project not found',
              projectPath: projectPathArg || null,
              projectName: projectNameArg || null,
              hint: 'Use vscode_dashboard_list_projects to inspect available projects.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const filteredTerminals = panel
        .getFloatingWindowTerminals()
        .filter((terminal) => !resolved.projectPath || isSameProjectPath(terminal.projectPath, resolved.projectPath));

      const tmux = TmuxManager.getInstance();
      try {
        await tmux.refreshTrackedSessions();
      } catch {
        // Best-effort refresh only.
      }
      const trackedTmuxSessions = tmux
        .getAllSessions()
        .filter((session) => {
          if (typeof session.cwd !== 'string' || session.cwd.length === 0) {
            return false;
          }
          if (!resolved.projectPath) {
            return true;
          }
          return isSameProjectPath(session.cwd, resolved.projectPath);
        });

      const activeSessionKeys = new Set(
        filteredTerminals.map((terminal) => `${terminal.sessionName}:${terminal.terminalId}`)
      );

      const terminalDetails = await Promise.all(
        filteredTerminals.map(async (t) => {
          const tmuxInfo = tmux.getSessionByTerminalId(t.terminalId);
          const detail: Record<string, unknown> = {
            clientId: t.clientId,
            sessionName: t.sessionName,
            projectPath: t.projectPath,
            terminalId: t.terminalId,
            terminalName: tmuxInfo?.terminalName || null,
            attached: true,
            source: 'card-client',
          };

          if (includeOutput) {
            const output = await panel.readFloatingWindowOutput(t.clientId, outputLines);
            detail.output = output || '';
          }

          return detail;
        })
      );

      const detachedDetails = await Promise.all(
        trackedTmuxSessions
          .filter((session) => !activeSessionKeys.has(`${session.sessionName}:${session.terminalId}`))
          .map(async (session) => {
            const detail: Record<string, unknown> = {
              clientId: null,
              sessionName: session.sessionName,
              projectPath: session.cwd || null,
              terminalId: session.terminalId,
              terminalName: session.terminalName || null,
              attached: false,
              source: 'tmux-detached',
            };

            if (includeOutput) {
              const output = await tmux.readBuffer(session.sessionName, outputLines);
              detail.output = output || '';
            }

            return detail;
          })
      );

      const allTerminalDetails = [...terminalDetails, ...detachedDetails];

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: allTerminalDetails.length,
            projectPath: resolved.projectPath || null,
            terminals: allTerminalDetails,
            hint: 'Use vscode_card_terminal_read/send or vscode_project_terminal_read/send.',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing collaborative terminals: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_card_terminal_open - Open/expand a project's embedded card terminal visually
 */
function registerCardTerminalOpen(): void {
  const definition: MCPTool = {
    name: 'vscode_card_terminal_open',
    description:
      'Open and expand a project card terminal in the dashboard. Supports selecting an existing terminal tab or creating a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'The full path to the project (from vscode_dashboard_list_projects)',
        },
        projectName: {
          type: 'string',
          description: 'Alternative: the project name (if projectPath not provided)',
        },
        terminalName: {
          type: 'string',
          description: 'Optional card terminal tab name to activate (or set when creating a new terminal)',
        },
        terminalId: {
          type: 'number',
          description: 'Optional terminal process id to activate if known',
        },
        createNewTerminal: {
          type: 'boolean',
          description: 'Create a new card terminal tab before opening (default: false)',
          default: false,
        },
        autoAddProject: {
          type: 'boolean',
          description: 'Automatically add project to dashboard tracking if missing (default: true)',
          default: true,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPathArg = args.projectPath as string | undefined;
    const projectNameArg = args.projectName as string | undefined;
    const terminalName = args.terminalName as string | undefined;
    const terminalId =
      typeof args.terminalId === 'number' && Number.isFinite(args.terminalId) ? (args.terminalId as number) : undefined;
    const createNewTerminal = (args.createNewTerminal as boolean) ?? false;
    const autoAddProject = (args.autoAddProject as boolean) ?? true;

    try {
      const panel = await ensureDashboardPanelOpen();
      if (!panel) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Dashboard panel could not be opened',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const agentDiscovery = AgentDiscovery.getInstance();
      const resolved = await resolveProjectPath(projectPathArg, projectNameArg, agentDiscovery);

      if (!resolved.projectPath) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'No project path or name specified',
              hint: 'Use vscode_dashboard_list_projects to see available projects',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const tracked = ensureProjectTracked(agentDiscovery, resolved.projectPath, autoAddProject);
      if (!tracked.tracked) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project is not tracked in dashboard',
              projectPath: resolved.projectPath,
              hint: 'Enable autoAddProject=true or call vscode_dashboard_add_project first.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const result = await panel.openCardTerminal(resolved.projectPath, {
        terminalName,
        terminalId,
        createNewTerminal,
      });

      if (!result.success) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: result.error || 'Failed to open card terminal',
              projectPath: resolved.projectPath,
            }, null, 2),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            opened: true,
            projectPath: resolved.projectPath,
            clientId: result.clientId,
            createNewTerminal,
            terminalName: terminalName || null,
            terminalId: terminalId ?? null,
            hint: 'Card terminal is ready. Use vscode_project_terminal_send/read or vscode_card_terminal_send/read.',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error opening card terminal: ${error}` }],
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
    description: 'Send and submit text/command to a card terminal. Just provide the text - Enter is handled automatically for reliable submission to both shells and Claude Code terminals.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          description: 'The clientId of the card terminal (from vscode_card_terminals_list)',
        },
        text: {
          type: 'string',
          description: 'Text/command to send and submit. Enter is sent automatically.',
        },
        addNewLine: {
          type: 'boolean',
          description: 'Submit after text (default: true). Set false to just type without submitting.',
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

/**
 * vscode_project_terminals_list - List terminals for a specific project
 */
function registerProjectTerminalsList(): void {
  const definition: MCPTool = {
    name: 'vscode_project_terminals_list',
    description:
      'List terminals for a project with both collaborative dashboard clients and detected VS Code terminal processes.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path to inspect terminals for',
        },
        projectName: {
          type: 'string',
          description: 'Alternative project name when projectPath is not provided',
        },
        includeOutput: {
          type: 'boolean',
          description: 'Include recent output snippets (default: false)',
          default: false,
        },
        outputLines: {
          type: 'number',
          description: 'Number of output lines when includeOutput=true (default: 50)',
          default: 50,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPathArg = args.projectPath as string | undefined;
    const projectNameArg = args.projectName as string | undefined;
    const includeOutput = (args.includeOutput as boolean) ?? false;
    const outputLines = (args.outputLines as number) ?? 50;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const resolved = await resolveProjectPath(projectPathArg, projectNameArg, agentDiscovery);

      if (!resolved.projectPath) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project path or name is required',
              hint: 'Provide projectPath or projectName. Use vscode_dashboard_list_projects to discover options.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const panel = await ensureDashboardPanelOpen();
      if (!panel) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Dashboard panel could not be opened',
              projectPath: resolved.projectPath,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const tmux = TmuxManager.getInstance();
      try {
        await tmux.refreshTrackedSessions();
      } catch {
        // Best-effort refresh only.
      }
      const trackedSessionNames = new Set(tmux.getAllSessions().map((session) => session.sessionName));

      const collaborativeClients = panel
        .getFloatingWindowTerminals()
        .filter((terminal) => isSameProjectPath(terminal.projectPath, resolved.projectPath))
        .filter((terminal) => trackedSessionNames.has(terminal.sessionName));

      const trackedTmuxSessions = tmux
        .getAllSessions()
        .filter(
          (session) =>
            typeof session.cwd === 'string' &&
            session.cwd.length > 0 &&
            isSameProjectPath(session.cwd, resolved.projectPath)
        );

      const activeSessionKeys = new Set(
        collaborativeClients.map((terminal) => `${terminal.sessionName}:${terminal.terminalId}`)
      );

      const terminalWatcher = TerminalWatcher.getInstance();
      const backendTerminals = terminalWatcher
        .getTerminalsForProject(resolved.projectPath)
        .map((terminal) => ({
          terminalId: terminal.id,
          name: terminal.name,
          agentType: terminal.agentType,
          isActive: terminal.isActive,
          state: terminal.state,
          tmuxSession: terminal.tmuxSession || null,
          createdByMcp: terminal.createdByMcp,
          lastOutputAt: terminal.lastOutputAt || null,
          projectPath: terminal.projectPath || terminal.cwd || resolved.projectPath,
        }));

      const collaborative = await Promise.all(
        collaborativeClients.map(async (client) => {
          const tmuxInfo = tmux.getSessionByTerminalId(client.terminalId);
          const detail: Record<string, unknown> = {
            clientId: client.clientId,
            sessionName: client.sessionName,
            terminalId: client.terminalId,
            projectPath: client.projectPath,
            terminalName: tmuxInfo?.terminalName || null,
            attached: true,
            source: 'card-client',
          };
          if (includeOutput) {
            detail.output = (await panel.readFloatingWindowOutput(client.clientId, outputLines)) || '';
          }
          return detail;
        })
      );

      const detachedCollaborative = await Promise.all(
        trackedTmuxSessions
          .filter((session) => !activeSessionKeys.has(`${session.sessionName}:${session.terminalId}`))
          .map(async (session) => {
            const detail: Record<string, unknown> = {
              clientId: null,
              sessionName: session.sessionName,
              terminalId: session.terminalId,
              projectPath: session.cwd || resolved.projectPath,
              terminalName: session.terminalName || null,
              attached: false,
              source: 'tmux-detached',
            };
            if (includeOutput) {
              detail.output = (await tmux.readBuffer(session.sessionName, outputLines)) || '';
            }
            return detail;
          })
      );

      const allCollaborative = [...collaborative, ...detachedCollaborative];

      const backend = await Promise.all(
        backendTerminals.map(async (terminal) => {
          const detail: Record<string, unknown> = { ...terminal };
          if (includeOutput) {
            detail.output = await terminalWatcher.getLastOutput(terminal.terminalId, outputLines);
          }
          return detail;
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            projectPath: resolved.projectPath,
            projectName: resolved.projectName || path.basename(resolved.projectPath),
            collaborativeTerminalCount: allCollaborative.length,
            backendTerminalCount: backend.length,
            collaborativeTerminals: allCollaborative,
            backendTerminals: backend,
            hint: 'Use vscode_project_terminal_send/read for collaboration-first control.',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing project terminals: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_project_terminals_close - Close project terminals by selector or all
 */
function registerProjectTerminalsClose(): void {
  const definition: MCPTool = {
    name: 'vscode_project_terminals_close',
    description:
      'Close terminals for a project. Supports closeAll, or targeting by clientId, terminalId, or terminalName.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path to close terminals for',
        },
        projectName: {
          type: 'string',
          description: 'Alternative project name when projectPath is not provided',
        },
        closeAll: {
          type: 'boolean',
          description: 'Close all terminals for the project (default: false)',
          default: false,
        },
        includeDetached: {
          type: 'boolean',
          description: 'When closeAll=true, include detached tmux sessions (default: true)',
          default: true,
        },
        clientId: {
          type: 'string',
          description: 'Close a specific attached collaborative terminal by clientId',
        },
        terminalId: {
          type: 'number',
          description: 'Close a specific terminal by terminal process id',
        },
        terminalName: {
          type: 'string',
          description: 'Close a specific terminal by terminal name',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPathArg = args.projectPath as string | undefined;
    const projectNameArg = args.projectName as string | undefined;
    const closeAll = (args.closeAll as boolean) ?? false;
    const includeDetached = (args.includeDetached as boolean) ?? true;
    const clientId = typeof args.clientId === 'string' ? args.clientId.trim() : '';
    const terminalId =
      typeof args.terminalId === 'number' && Number.isFinite(args.terminalId)
        ? (args.terminalId as number)
        : undefined;
    const terminalName = typeof args.terminalName === 'string' ? args.terminalName.trim() : '';

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const resolved = await resolveProjectPath(projectPathArg, projectNameArg, agentDiscovery);

      if (!resolved.projectPath) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project path or name is required',
              hint: 'Provide projectPath or projectName. Use vscode_dashboard_list_projects to discover options.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const panel = await ensureDashboardPanelOpen();
      if (!panel) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Dashboard panel could not be opened',
              projectPath: resolved.projectPath,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const tmux = TmuxManager.getInstance();
      try {
        await tmux.refreshTrackedSessions();
      } catch {
        // Best-effort refresh only.
      }

      const attached = panel
        .getFloatingWindowTerminals()
        .filter((terminal) => isSameProjectPath(terminal.projectPath, resolved.projectPath))
        .map((terminal) => {
          const tmuxInfo = tmux.getSessionByTerminalId(terminal.terminalId);
          return {
            clientId: terminal.clientId,
            sessionName: terminal.sessionName,
            terminalId: terminal.terminalId,
            terminalName: tmuxInfo?.terminalName || '',
            attached: true,
          };
        });

      const attachedSessionKeys = new Set(attached.map((item) => `${item.sessionName}:${item.terminalId}`));
      const detached = tmux
        .getAllSessions()
        .filter(
          (session) =>
            typeof session.cwd === 'string' &&
            session.cwd.length > 0 &&
            isSameProjectPath(session.cwd, resolved.projectPath) &&
            !attachedSessionKeys.has(`${session.sessionName}:${session.terminalId}`)
        )
        .map((session) => ({
          clientId: '',
          sessionName: session.sessionName,
          terminalId: session.terminalId,
          terminalName: session.terminalName || '',
          attached: false,
        }));

      let selected: Array<{
        clientId: string;
        sessionName: string;
        terminalId: number;
        terminalName: string;
        attached: boolean;
      }> = [];

      if (closeAll) {
        selected = includeDetached ? [...attached, ...detached] : [...attached];
      } else if (clientId) {
        selected = attached.filter((item) => item.clientId === clientId);
      } else if (terminalId !== undefined) {
        selected = [...attached, ...detached].filter((item) => item.terminalId === terminalId);
      } else if (terminalName) {
        const normalized = terminalName.toLowerCase();
        selected = [...attached, ...detached].filter(
          (item) => (item.terminalName || '').trim().toLowerCase() === normalized
        );
      } else if (attached.length > 0) {
        selected = [attached[0]];
      }

      if (selected.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              closed: false,
              projectPath: resolved.projectPath,
              error: 'No matching terminals found to close',
              hint: 'Use closeAll=true or provide clientId/terminalId/terminalName from vscode_project_terminals_list.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const uniqueBySession = new Map<string, typeof selected[number]>();
      selected.forEach((item) => {
        uniqueBySession.set(item.sessionName, item);
      });
      const uniqueTargets = Array.from(uniqueBySession.values());

      const closed: Array<{
        sessionName: string;
        terminalId: number;
        clientId: string | null;
        terminalName: string | null;
        attached: boolean;
      }> = [];
      const failed: Array<{ sessionName: string; reason: string }> = [];

      for (const target of uniqueTargets) {
        try {
          await tmux.killSession(target.sessionName);
          closed.push({
            sessionName: target.sessionName,
            terminalId: target.terminalId,
            clientId: target.clientId || null,
            terminalName: target.terminalName || null,
            attached: target.attached,
          });
        } catch (error) {
          failed.push({
            sessionName: target.sessionName,
            reason: String(error),
          });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        await tmux.refreshTrackedSessions();
      } catch {
        // Best-effort refresh only.
      }
      const remainingSessionNames = new Set(tmux.getAllSessions().map((session) => session.sessionName));

      const remainingAttached = panel
        .getFloatingWindowTerminals()
        .filter((terminal) => isSameProjectPath(terminal.projectPath, resolved.projectPath))
        .filter((terminal) => remainingSessionNames.has(terminal.sessionName));
      const remainingDetached = tmux
        .getAllSessions()
        .filter(
          (session) =>
            typeof session.cwd === 'string' &&
            session.cwd.length > 0 &&
            isSameProjectPath(session.cwd, resolved.projectPath)
        );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            closed: failed.length === 0,
            projectPath: resolved.projectPath,
            requestedCloseAll: closeAll,
            includeDetached,
            closedCount: closed.length,
            failedCount: failed.length,
            closedTerminals: closed,
            failed,
            remainingAttachedCount: remainingAttached.length,
            remainingTrackedTmuxCount: remainingDetached.length,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error closing project terminals: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_project_terminal_send - Send text to a project's collaborative terminal
 */
function registerProjectTerminalSend(): void {
  const definition: MCPTool = {
    name: 'vscode_project_terminal_send',
    description:
      'Send text/command to a project terminal with collaboration-first behavior. Defaults to background tmux mode (no UI steal), with optional foreground/card-open visual modes.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path to send command in',
        },
        projectName: {
          type: 'string',
          description: 'Alternative project name when projectPath is not provided',
        },
        clientId: {
          type: 'string',
          description: 'Optional exact collaborative terminal client id',
        },
        terminalId: {
          type: 'number',
          description: 'Optional terminal process id to target',
        },
        terminalName: {
          type: 'string',
          description: 'Optional card terminal tab name to target/switch to',
        },
        createNewTerminal: {
          type: 'boolean',
          description: 'Create a new terminal session before sending (default: false)',
          default: false,
        },
        visibilityMode: {
          type: 'string',
          enum: ['background', 'foreground', 'card_open'],
          description: 'Terminal visibility behavior (default: background). background keeps work headless but visible when user opens the project card.',
          default: 'background',
        },
        autoAddProject: {
          type: 'boolean',
          description: 'Automatically add project to dashboard tracking if missing (default: true)',
          default: true,
        },
        text: {
          type: 'string',
          description: 'Text/command to send',
        },
        addNewLine: {
          type: 'boolean',
          description: 'Submit after text (default: true)',
          default: true,
        },
        observeMs: {
          type: 'number',
          description: 'After sending, observe output for this many milliseconds to report command/state context (default: 1800, max: 15000)',
          default: 1800,
        },
        pollMs: {
          type: 'number',
          description: 'Polling interval while observing output (default: 250)',
          default: 250,
        },
        observeLines: {
          type: 'number',
          description: 'How many lines to inspect when observing output (default: 120)',
          default: 120,
        },
        waitForFinalState: {
          type: 'boolean',
          description: 'When true, keep observing until a terminal final-ish state is seen (idle/completed/waiting_input/error) or timeout',
          default: false,
        },
      },
      required: ['text'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPathArg = args.projectPath as string | undefined;
    const projectNameArg = args.projectName as string | undefined;
    const clientId = args.clientId as string | undefined;
    const terminalId =
      typeof args.terminalId === 'number' && Number.isFinite(args.terminalId) ? (args.terminalId as number) : undefined;
    const terminalName = args.terminalName as string | undefined;
    const createNewTerminal = (args.createNewTerminal as boolean) ?? false;
    const visibilityMode = normalizeVisibilityMode(args.visibilityMode, 'background');
    const autoAddProject = (args.autoAddProject as boolean) ?? true;
    const text = (args.text as string) ?? '';
    const addNewLine = (args.addNewLine as boolean) ?? true;
    const observeMs = (args.observeMs as number) ?? 1800;
    const pollMs = (args.pollMs as number) ?? 250;
    const observeLines = (args.observeLines as number) ?? 120;
    const waitForFinalState = (args.waitForFinalState as boolean) ?? false;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const resolved = await resolveProjectPath(projectPathArg, projectNameArg, agentDiscovery);

      if (!resolved.projectPath) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project path or name is required',
              hint: 'Provide projectPath or projectName. Use vscode_dashboard_list_projects to inspect projects.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const tracked = ensureProjectTracked(agentDiscovery, resolved.projectPath, autoAddProject);
      if (!tracked.tracked) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project is not tracked in dashboard',
              projectPath: resolved.projectPath,
              hint: 'Enable autoAddProject=true or add it with vscode_dashboard_add_project.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      let panel: import('../dashboard/DashboardPanel').DashboardPanel | null = null;
      const requiresPanel = visibilityMode !== 'background' || Boolean(clientId);
      if (requiresPanel) {
        panel = await ensureDashboardPanelOpen();
        if (!panel) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Dashboard panel could not be opened',
                projectPath: resolved.projectPath,
                visibilityMode,
              }, null, 2),
            }],
            isError: true,
          };
        }
      }

      const target = await ensureProjectTerminalClient(panel, resolved.projectPath, {
        clientId,
        terminalId,
        terminalName,
        createNewTerminal,
        visibilityMode,
      });

      if (target.error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: target.error,
              projectPath: resolved.projectPath,
              visibilityMode,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const uiAction = deriveUiAction(target, visibilityMode);

      if (target.source === 'detached') {
        if (!target.sessionName) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Detached terminal session is missing sessionName',
                projectPath: resolved.projectPath,
              }, null, 2),
            }],
            isError: true,
          };
        }

        const tmux = TmuxManager.getInstance();
        await tmux.sendKeys(target.sessionName, text, addNewLine);
        const observation = await observeTmuxSend(tmux, target.sessionName, text, {
          observeMs,
          pollMs,
          lines: observeLines,
          waitForFinalState,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              sent: true,
              projectPath: resolved.projectPath,
              clientId: null,
              source: target.source,
              sessionName: target.sessionName,
              terminalId: target.terminalId,
              openedOrSwitched: target.created,
              visibilityModeApplied: visibilityMode,
              uiAction,
              text,
              addNewLine,
              observation,
              hint: 'Command ran in background tmux session. Open the project card to watch/collaborate live.',
            }, null, 2),
          }],
        };
      }

      if (!panel || !target.clientId) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'No attached collaborative terminal available for visual send',
              projectPath: resolved.projectPath,
              visibilityMode,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const sent = await panel.sendToFloatingWindow(target.clientId, text, addNewLine);
      if (!sent) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Failed sending command to collaborative terminal',
              projectPath: resolved.projectPath,
              clientId: target.clientId,
              visibilityMode,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const observation = await observeCollaborativeSend(panel, target.clientId, text, {
        observeMs,
        pollMs,
        lines: observeLines,
        waitForFinalState,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sent: true,
            projectPath: resolved.projectPath,
            clientId: target.clientId,
            source: target.source,
            openedOrSwitched: target.created,
            visibilityModeApplied: visibilityMode,
            uiAction,
            text,
            addNewLine,
            observation,
            hint: 'Command is visible in dashboard for live collaboration.',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error sending to project terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_project_terminal_read - Read output from a project's collaborative terminal
 */
function registerProjectTerminalRead(): void {
  const definition: MCPTool = {
    name: 'vscode_project_terminal_read',
    description:
      'Read terminal output from a project with collaboration-first behavior. Defaults to background tmux mode with optional foreground/card-open visual modes.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project path to read terminal output from',
        },
        projectName: {
          type: 'string',
          description: 'Alternative project name when projectPath is not provided',
        },
        clientId: {
          type: 'string',
          description: 'Optional exact collaborative terminal client id',
        },
        terminalId: {
          type: 'number',
          description: 'Optional terminal process id to target',
        },
        terminalName: {
          type: 'string',
          description: 'Optional card terminal tab name to target/switch to',
        },
        createNewTerminal: {
          type: 'boolean',
          description: 'Create a new terminal session before reading (default: false)',
          default: false,
        },
        visibilityMode: {
          type: 'string',
          enum: ['background', 'foreground', 'card_open'],
          description: 'Terminal visibility behavior (default: background). background keeps work headless but visible when user opens the project card.',
          default: 'background',
        },
        autoAddProject: {
          type: 'boolean',
          description: 'Automatically add project to dashboard tracking if missing (default: true)',
          default: true,
        },
        lines: {
          type: 'number',
          description: 'Number of output lines to read (default: 100)',
          default: 100,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const projectPathArg = args.projectPath as string | undefined;
    const projectNameArg = args.projectName as string | undefined;
    const clientId = args.clientId as string | undefined;
    const terminalId =
      typeof args.terminalId === 'number' && Number.isFinite(args.terminalId) ? (args.terminalId as number) : undefined;
    const terminalName = args.terminalName as string | undefined;
    const createNewTerminal = (args.createNewTerminal as boolean) ?? false;
    const visibilityMode = normalizeVisibilityMode(args.visibilityMode, 'background');
    const autoAddProject = (args.autoAddProject as boolean) ?? true;
    const lines = (args.lines as number) ?? 100;

    try {
      const agentDiscovery = AgentDiscovery.getInstance();
      const resolved = await resolveProjectPath(projectPathArg, projectNameArg, agentDiscovery);

      if (!resolved.projectPath) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project path or name is required',
              hint: 'Provide projectPath or projectName. Use vscode_dashboard_list_projects to inspect projects.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const tracked = ensureProjectTracked(agentDiscovery, resolved.projectPath, autoAddProject);
      if (!tracked.tracked) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Project is not tracked in dashboard',
              projectPath: resolved.projectPath,
              hint: 'Enable autoAddProject=true or add it with vscode_dashboard_add_project.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      let panel: import('../dashboard/DashboardPanel').DashboardPanel | null = null;
      const requiresPanel = visibilityMode !== 'background' || Boolean(clientId);
      if (requiresPanel) {
        panel = await ensureDashboardPanelOpen();
        if (!panel) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Dashboard panel could not be opened',
                projectPath: resolved.projectPath,
                visibilityMode,
              }, null, 2),
            }],
            isError: true,
          };
        }
      }

      const target = await ensureProjectTerminalClient(panel, resolved.projectPath, {
        clientId,
        terminalId,
        terminalName,
        createNewTerminal,
        visibilityMode,
      });

      if (target.error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: target.error,
              projectPath: resolved.projectPath,
              visibilityMode,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const uiAction = deriveUiAction(target, visibilityMode);

      if (target.source === 'detached') {
        if (!target.sessionName) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Detached terminal session is missing sessionName',
                projectPath: resolved.projectPath,
              }, null, 2),
            }],
            isError: true,
          };
        }

        const tmux = TmuxManager.getInstance();
        const output = await tmux.readBuffer(target.sessionName, lines);
        const outputState = classifyCollaborativeOutput(output || '');

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              projectPath: resolved.projectPath,
              clientId: null,
              source: target.source,
              sessionName: target.sessionName,
              terminalId: target.terminalId,
              openedOrSwitched: target.created,
              visibilityModeApplied: visibilityMode,
              uiAction,
              lines,
              state: outputState.state,
              stateReason: outputState.reason,
              promptLine: lastNonEmptyLine(output || ''),
              output: output || '',
            }, null, 2),
          }],
        };
      }

      if (!panel || !target.clientId) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'No attached collaborative terminal available for visual read',
              projectPath: resolved.projectPath,
              visibilityMode,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const output = await panel.readFloatingWindowOutput(target.clientId, lines);

      if (output === null) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Collaborative terminal not found',
              projectPath: resolved.projectPath,
              clientId: target.clientId,
              visibilityMode,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const outputState = classifyCollaborativeOutput(output);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            projectPath: resolved.projectPath,
            clientId: target.clientId,
            source: target.source,
            openedOrSwitched: target.created,
            visibilityModeApplied: visibilityMode,
            uiAction,
            lines,
            state: outputState.state,
            stateReason: outputState.reason,
            promptLine: lastNonEmptyLine(output),
            output,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading project terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}
