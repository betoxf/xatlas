import * as vscode from 'vscode';
import * as path from 'path';
import * as http from 'http';
import { TerminalWatcher, TerminalInfo, AgentType, AGENT_PATTERNS } from './terminalWatcher';
import { TmuxManager } from './tmuxManager';
import { CONFIG_NAMESPACE } from './extensionInfo';

/**
 * Information about an AI agent instance
 */
export interface AgentInstance {
  type: AgentType;
  name: string;
  color: string;
  terminalId: number;
  terminalName: string;
  isActive: boolean;
  isLocal: boolean;
}

export type ProjectActivity =
  | 'idle'           // Ready for input, showing prompt
  | 'running'        // Recently active output
  | 'waiting'        // Waiting for user response (legacy)
  | 'processing'     // AI is thinking/working
  | 'waiting_input'  // AI asked a question
  | 'completed'      // Just finished a task
  | 'error'          // Error occurred
  | 'context_warning'; // Context usage high

/**
 * Information about a terminal in a project
 */
export interface TerminalInstance {
  processId: number;
  name: string;
  agentType: AgentType;
  isActive: boolean;
  lastOutput: string;
  lastOutputAt: number;
}

/**
 * Information about a project/workspace
 */
export interface ProjectInfo {
  name: string;
  path: string;
  isLocal: boolean;
  terminals: TerminalInstance[];
  agents: AgentInstance[];
  activity?: ProjectActivity;
  accentColor?: string;
}

export interface ProjectActivityChange {
  projectPath: string;
  previousActivity?: ProjectActivity;
  activity: ProjectActivity;
  timestamp: number;
}

/**
 * Response from a remote dashboard API
 */
interface RemoteDashboardInfo {
  workspace: string;
  workspacePath: string;
  terminals: Array<{
    id: number;
    name: string;
    agentType: string;
    isActive: boolean;
    lastOutput: string;
    lastOutputAt?: number;
  }>;
}

/**
 * Service to discover AI agents across VS Code windows
 */
export class AgentDiscovery {
  private static instance: AgentDiscovery;
  private terminalWatcher: TerminalWatcher;
  private remoteWindows: Map<number, ProjectInfo> = new Map();
  private scanPorts = { start: 9002, end: 9015 };
  private projectActivity: Map<string, { activity: ProjectActivity; updatedAt: number }> = new Map();
  private activityCallbacks: Array<(change: ProjectActivityChange) => void> = [];
  private storage?: vscode.Memento;
  private projectOrder: string[] = [];
  private projectColors: Map<string, string> = new Map();
  private discoveryCache: { projects: ProjectInfo[]; timestamp: number } | null = null;
  private discoveryInFlight: Promise<ProjectInfo[]> | null = null;
  private remoteProjectsCache: { projects: ProjectInfo[]; timestamp: number } | null = null;
  private remoteDiscoveryInFlight: Promise<ProjectInfo[]> | null = null;

  private static readonly ACTIVITY_TTL_MS = 15000;
  private static readonly OUTPUT_ACTIVITY_TTL_MS = 12000;
  private static readonly STORAGE_KEY = 'operador.trackedProjects';
  private static readonly ORDER_KEY = 'operador.projectOrder';
  private static readonly COLOR_KEY = 'operador.projectColors';
  private static readonly DISCOVERY_CACHE_TTL_MS = 8000;
  private static readonly REMOTE_DISCOVERY_TTL_MS = 15000;

  // Track added projects (path -> project info)
  private addedProjects: Map<string, { name: string; path: string }> = new Map();

  private constructor(terminalWatcher: TerminalWatcher) {
    this.terminalWatcher = terminalWatcher;
  }

  public static getInstance(terminalWatcher?: TerminalWatcher): AgentDiscovery {
    if (!AgentDiscovery.instance) {
      if (!terminalWatcher) {
        terminalWatcher = TerminalWatcher.getInstance();
      }
      AgentDiscovery.instance = new AgentDiscovery(terminalWatcher);
    }
    return AgentDiscovery.instance;
  }

  /**
   * Add a project to track
   */
  public addProject(path: string, name: string): void {
    this.addedProjects.set(path, { name, path });
    this.invalidateDiscoveryCache();
    this.persistProjects();
  }

  /**
   * Remove a project from tracking
   */
  public removeProject(path: string): void {
    this.addedProjects.delete(path);
    this.invalidateDiscoveryCache();
    if (this.projectOrder.length > 0) {
      this.projectOrder = this.projectOrder.filter((entry) => entry !== path);
      this.persistProjectOrder();
    }
    if (this.projectColors.has(path)) {
      this.projectColors.delete(path);
      this.persistProjectColors();
    }
    this.persistProjects();
  }

  /**
   * Get all tracked projects
   */
  public getTrackedProjects(): Array<{ name: string; path: string }> {
    return Array.from(this.addedProjects.values());
  }

  public setProjectOrder(order: string[]): void {
    if (!Array.isArray(order)) {
      return;
    }
    const seen = new Set<string>();
    this.projectOrder = order.filter((path) => {
      if (typeof path !== 'string' || !path || seen.has(path)) {
        return false;
      }
      seen.add(path);
      return true;
    });
    this.invalidateDiscoveryCache();
    this.persistProjectOrder();
  }

  public setProjectColor(path: string, color?: string): void {
    if (!path) {
      return;
    }
    if (!color) {
      this.projectColors.delete(path);
    } else {
      this.projectColors.set(path, color);
    }
    this.invalidateDiscoveryCache();
    this.persistProjectColors();
  }

  public setStorage(storage: vscode.Memento): void {
    this.storage = storage;
    const stored = storage.get<Array<{ name: string; path: string }>>(
      AgentDiscovery.STORAGE_KEY,
      []
    );

    if (Array.isArray(stored)) {
      stored.forEach((project) => {
        if (!project || !project.path || !project.name) {
          return;
        }
        if (!this.addedProjects.has(project.path)) {
          this.addedProjects.set(project.path, { name: project.name, path: project.path });
        }
      });
    }

    const storedOrder = storage.get<string[]>(AgentDiscovery.ORDER_KEY, []);
    if (Array.isArray(storedOrder)) {
      this.projectOrder = storedOrder.filter((path) => typeof path === 'string' && path);
    }

    const storedColors = storage.get<Record<string, string>>(AgentDiscovery.COLOR_KEY, {});
    if (storedColors && typeof storedColors === 'object') {
      Object.entries(storedColors).forEach(([path, color]) => {
        if (typeof path === 'string' && path && typeof color === 'string' && color) {
          this.projectColors.set(path, color);
        }
      });
    }

    this.invalidateDiscoveryCache(true);
  }

  public setProjectActivity(path: string, activity: ProjectActivity): void {
    const previous = this.projectActivity.get(path)?.activity;
    const timestamp = Date.now();
    this.projectActivity.set(path, { activity, updatedAt: timestamp });

    if (previous !== activity) {
      const change: ProjectActivityChange = {
        projectPath: path,
        previousActivity: previous,
        activity,
        timestamp,
      };
      for (const callback of this.activityCallbacks) {
        try {
          callback(change);
        } catch {
          // Keep callbacks isolated.
        }
      }
    }

    // Keep cached project list hot by updating activity in place instead of
    // forcing a full rediscovery on every activity signal.
    if (this.discoveryCache) {
      for (const project of this.discoveryCache.projects) {
        if (project.path === path) {
          project.activity = activity;
          break;
        }
      }
      this.discoveryCache.timestamp = Date.now();
    }
  }

  public clearProjectActivity(path: string): void {
    this.projectActivity.delete(path);
    this.discoveryCache = null;
  }

  public onProjectActivityChange(callback: (change: ProjectActivityChange) => void): void {
    this.activityCallbacks.push(callback);
  }

  public offProjectActivityChange(callback: (change: ProjectActivityChange) => void): void {
    const idx = this.activityCallbacks.indexOf(callback);
    if (idx >= 0) {
      this.activityCallbacks.splice(idx, 1);
    }
  }

  private invalidateDiscoveryCache(includeRemote: boolean = false): void {
    this.discoveryCache = null;
    if (includeRemote) {
      this.remoteProjectsCache = null;
    }
  }

  private persistProjects(): void {
    if (!this.storage) {
      return;
    }
    const payload = Array.from(this.addedProjects.values());
    void this.storage.update(AgentDiscovery.STORAGE_KEY, payload);
  }

  private persistProjectOrder(): void {
    if (!this.storage) {
      return;
    }
    void this.storage.update(AgentDiscovery.ORDER_KEY, this.projectOrder);
  }

  private persistProjectColors(): void {
    if (!this.storage) {
      return;
    }
    const payload: Record<string, string> = {};
    this.projectColors.forEach((color, path) => {
      if (path && color) {
        payload[path] = color;
      }
    });
    void this.storage.update(AgentDiscovery.COLOR_KEY, payload);
  }

  private applyProjectOrder(projects: ProjectInfo[]): ProjectInfo[] {
    if (!this.projectOrder.length) {
      return projects;
    }

    const orderIndex = new Map(this.projectOrder.map((path, index) => [path, index]));
    const withIndex = projects.map((project, index) => ({
      project,
      order: orderIndex.has(project.path) ? orderIndex.get(project.path)! : Number.MAX_SAFE_INTEGER,
      index,
    }));

    withIndex.sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.index - b.index;
    });

    return withIndex.map((entry) => entry.project);
  }

  /**
   * Discover all projects with their agents
   */
  public async discoverProjects(options?: { force?: boolean }): Promise<ProjectInfo[]> {
    const force = options?.force === true;
    const now = Date.now();

    if (!force && this.discoveryCache) {
      if (now - this.discoveryCache.timestamp < AgentDiscovery.DISCOVERY_CACHE_TTL_MS) {
        return this.discoveryCache.projects;
      }
    }

    if (!force && this.discoveryInFlight) {
      return this.discoveryInFlight;
    }

    const pending = this.discoverProjectsInternal(force);
    this.discoveryInFlight = pending;
    try {
      const projects = await pending;
      this.discoveryCache = { projects, timestamp: Date.now() };
      return projects;
    } finally {
      if (this.discoveryInFlight === pending) {
        this.discoveryInFlight = null;
      }
    }
  }

  private async discoverProjectsInternal(force: boolean): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = [];
    const allTerminals = this.terminalWatcher.getTerminals();
    const tmux = TmuxManager.getInstance();
    try {
      await tmux.refreshTrackedSessions();
    } catch {
      // Best-effort refresh only.
    }

    // Get current workspace path
    const currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // Add current window first so newly added projects appear to the right.
    if (currentWorkspacePath) {
      const localProject = await this.discoverCurrentWindow();
      if (localProject) {
        const added = this.addedProjects.get(currentWorkspacePath);
        if (added) {
          localProject.name = added.name;
        }
        projects.push(localProject);
      }
    }

    // Add manually added projects after the current workspace
    for (const [projectPath, projectInfo] of this.addedProjects) {
      if (projectPath === currentWorkspacePath) {
        continue;
      }

      // Find terminals that match this project
      const projectName = projectPath.split('/').pop() || '';
      const projectTerminals = allTerminals.filter((t) => {
        if (t.cwd) {
          return this.isPathWithin(t.cwd, projectPath);
        }
        return t.name === projectName || t.name.toLowerCase().includes(projectName.toLowerCase());
      });

      const terminalInstances = projectTerminals.map((t) => this.mapTerminalInfo(t));
      const knownTerminalIds = new Set(terminalInstances.map((terminal) => terminal.processId));
      const tmuxTerminals = tmux
        .getAllSessions()
        .filter((session) => {
          if (!session.cwd) {
            return false;
          }
          if (knownTerminalIds.has(session.terminalId)) {
            return false;
          }
          return this.isPathWithin(session.cwd, projectPath);
        })
        .map((session) => this.mapTmuxSession(session));
      terminalInstances.push(...tmuxTerminals);
      const agents = projectTerminals
        .filter((t) => t.agentType !== 'generic')
        .map((t) => this.mapAgentFromTerminal(t));
      const activity = this.resolveProjectActivity(projectPath, terminalInstances, agents);

      projects.push({
        name: projectInfo.name,
        path: projectPath,
        isLocal: true,
        terminals: terminalInstances,
        agents,
        activity,
      });
    }

    // Get remote projects (from other VS Code windows)
    const remoteProjects = await this.discoverRemoteProjects(force);

    // Filter out remotes that are already in added projects
    for (const remote of remoteProjects) {
      if (!this.addedProjects.has(remote.path)) {
        projects.push(remote);
      }
    }

    const ordered = this.applyProjectOrder(projects);
    ordered.forEach((project) => {
      const color = this.projectColors.get(project.path);
      if (color) {
        project.accentColor = color;
      }
    });

    return ordered;
  }

  /**
   * Discover the current VS Code window as a project
   */
  private async discoverCurrentWindow(): Promise<ProjectInfo | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const workspacePaths = workspaceFolders.map((folder) => folder.uri.fsPath);
    const workspaceNames = workspaceFolders.map((folder) => folder.name.toLowerCase());
    const allTerminals = this.terminalWatcher.getTerminals();
    const tmux = TmuxManager.getInstance();
    const localTerminals = allTerminals.filter((t) => {
      if (t.cwd) {
        return workspacePaths.some((workspacePath) => this.isPathWithin(t.cwd as string, workspacePath));
      }
      return workspaceNames.some((name) => t.name.toLowerCase().includes(name));
    });
      const terminalInstances = localTerminals.map((t) => this.mapTerminalInfo(t));
      const knownTerminalIds = new Set(terminalInstances.map((terminal) => terminal.processId));
      const tmuxTerminals = tmux
        .getAllSessions()
        .filter((session) => {
          if (!session.cwd) {
            return false;
          }
          if (knownTerminalIds.has(session.terminalId)) {
            return false;
          }
          return workspacePaths.some((workspacePath) => this.isPathWithin(session.cwd as string, workspacePath));
        })
        .map((session) => this.mapTmuxSession(session));
      terminalInstances.push(...tmuxTerminals);
      const agents = localTerminals
        .filter((t) => t.agentType !== 'generic')
        .map((t) => this.mapAgentFromTerminal(t));
      const activity = this.resolveProjectActivity(workspaceFolders[0].uri.fsPath, terminalInstances, agents);

      return {
        name: workspaceFolders[0].name,
        path: workspaceFolders[0].uri.fsPath,
        isLocal: true,
        terminals: terminalInstances,
        agents,
        activity,
      };
    }

  private isPathWithin(target: string, parent: string): boolean {
    const normalizedTarget = path.resolve(target);
    const normalizedParent = path.resolve(parent);
    const relative = path.relative(normalizedParent, normalizedTarget);
    if (relative === '') {
      return true;
    }
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Discover projects from other VS Code windows via HTTP
   */
  private async discoverRemoteProjects(force: boolean = false): Promise<ProjectInfo[]> {
    const now = Date.now();

    if (!force && this.remoteProjectsCache) {
      if (now - this.remoteProjectsCache.timestamp < AgentDiscovery.REMOTE_DISCOVERY_TTL_MS) {
        return this.remoteProjectsCache.projects;
      }
    }

    if (!force && this.remoteDiscoveryInFlight) {
      return this.remoteDiscoveryInFlight;
    }

    const pending = this.discoverRemoteProjectsInternal();
    this.remoteDiscoveryInFlight = pending;
    try {
      const projects = await pending;
      this.remoteProjectsCache = { projects, timestamp: Date.now() };
      return projects;
    } finally {
      if (this.remoteDiscoveryInFlight === pending) {
        this.remoteDiscoveryInFlight = null;
      }
    }
  }

  private async discoverRemoteProjectsInternal(): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = [];
    const currentPort = vscode.workspace
      .getConfiguration(CONFIG_NAMESPACE)
      .get<number>('port', 9002);

    // Get current workspace path to avoid duplicates
    const currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // Scan ports for other VS Code MCP servers
    const portPromises: Promise<{ port: number; data: RemoteDashboardInfo | null }>[] = [];

    for (let port = this.scanPorts.start; port <= this.scanPorts.end; port++) {
      if (port === currentPort) continue; // Skip our own port
      portPromises.push(
        this.fetchRemoteDashboard(port).then((data) => ({ port, data }))
      );
    }

    const results = await Promise.all(portPromises);

    for (const result of results) {
      if (result.data) {
        // Skip if it's the same workspace as current window
        if (result.data.workspacePath === currentWorkspacePath) {
          continue;
        }

        const project: ProjectInfo = {
          name: result.data.workspace,
          path: result.data.workspacePath,
          isLocal: false,
          terminals: result.data.terminals.map((t) => ({
            processId: t.id,
            name: t.name,
            agentType: t.agentType as AgentType,
            isActive: t.isActive,
            lastOutput: t.lastOutput,
            lastOutputAt: t.lastOutputAt || 0,
          })),
          agents: result.data.terminals
            .filter((t) => t.agentType !== 'generic')
            .map((t) => ({
              type: t.agentType as AgentType,
              name: this.getAgentName(t.agentType as AgentType),
              color: this.getAgentColor(t.agentType as AgentType),
              terminalId: t.id,
              terminalName: t.name,
              isActive: t.isActive,
              isLocal: false,
            })),
          activity: this.resolveProjectActivity(
            result.data.workspacePath,
            result.data.terminals.map((t) => ({
              processId: t.id,
              name: t.name,
              agentType: t.agentType as AgentType,
              isActive: t.isActive,
              lastOutput: t.lastOutput,
              lastOutputAt: t.lastOutputAt || 0,
            })),
            result.data.terminals
              .filter((t) => t.agentType !== 'generic')
              .map((t) => ({
                type: t.agentType as AgentType,
                name: this.getAgentName(t.agentType as AgentType),
                color: this.getAgentColor(t.agentType as AgentType),
                terminalId: t.id,
                terminalName: t.name,
                isActive: t.isActive,
                isLocal: false,
              }))
          ),
        };
        projects.push(project);
      }
    }

    return projects;
  }

  /**
   * Fetch dashboard info from a remote VS Code window
   */
  private fetchRemoteDashboard(port: number): Promise<RemoteDashboardInfo | null> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/dashboard/info',
          method: 'GET',
          timeout: 180,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json as RemoteDashboardInfo);
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  /**
   * Map TerminalInfo to TerminalInstance
   */
  private mapTerminalInfo(info: TerminalInfo): TerminalInstance {
    return {
      processId: info.id,
      name: info.name,
      agentType: info.agentType,
      isActive: info.isActive,
      lastOutput: info.lastOutput,
      lastOutputAt: info.lastOutputAt,
    };
  }

  private mapTmuxSession(session: { terminalId: number; terminalName: string; cwd?: string }): TerminalInstance {
    return {
      processId: session.terminalId,
      name: session.terminalName || 'Terminal',
      agentType: 'generic',
      isActive: true,
      lastOutput: '',
      lastOutputAt: 0,
    };
  }

  private resolveProjectActivity(
    projectPath: string,
    terminals: TerminalInstance[],
    agents: AgentInstance[]
  ): ProjectActivity {
    // Check for manually set activity first
    const activityEntry = this.projectActivity.get(projectPath);
    if (activityEntry && Date.now() - activityEntry.updatedAt < AgentDiscovery.ACTIVITY_TTL_MS) {
      return activityEntry.activity;
    }

    // Analyze terminal output for detailed state
    for (const terminal of terminals) {
      const state = this.analyzeTerminalState(terminal.lastOutput);
      if (state !== 'idle') {
        return state;
      }
    }

    // Fall back to time-based activity detection
    const now = Date.now();
    if (
      terminals.some(
        (terminal) =>
          terminal.lastOutputAt && now - terminal.lastOutputAt < AgentDiscovery.OUTPUT_ACTIVITY_TTL_MS
      )
    ) {
      return 'running';
    }

    return 'idle';
  }

  /**
   * Analyze terminal output to determine detailed state
   */
  private analyzeTerminalState(text: string): ProjectActivity {
    if (!text) {
      return 'idle';
    }

    const lastLines = text.slice(-1500); // Last ~1500 chars

    // Check for context warning (high priority)
    if (this.outputIndicatesContextWarning(lastLines)) {
      return 'context_warning';
    }

    // Check for error state
    if (this.outputIndicatesError(lastLines)) {
      return 'error';
    }

    // Check for processing/thinking state
    if (this.outputIndicatesProcessing(lastLines)) {
      return 'processing';
    }

    // Check for waiting for input (question asked)
    if (this.outputIndicatesWaitingInput(lastLines)) {
      return 'waiting_input';
    }

    // Check for completed state
    if (this.outputIndicatesCompleted(lastLines)) {
      return 'completed';
    }

    // Legacy waiting check
    if (this.outputIndicatesWaiting(lastLines)) {
      return 'waiting';
    }

    return 'idle';
  }

  private outputIndicatesProcessing(text: string): boolean {
    const patterns = [
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Spinner characters
      /Thinking\.\.\./i,
      /Processing\.\.\./i,
      /Working\.\.\./i,
      /Reading\s+\w+/i,
      /Writing\s+\w+/i,
      /Searching/i,
      /⏳/,
      /━+.*\d+%/, // Progress bar
      /Loading/i,
      /Analyzing/i,
      /Compiling/i,
      /Building/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private outputIndicatesWaitingInput(text: string): boolean {
    const patterns = [
      /\?\s*$/m, // Ends with question mark
      /Select.*:/i,
      /Choose.*:/i,
      /Pick.*:/i,
      /Which.*\?/i,
      /Options:/i,
      /\[Y\/n\]/i,
      /\[y\/N\]/i,
      /Enter.*:/i,
      /Input.*:/i,
      /❯\s*\[/, // Selection prompt
      />\s*\[.*\]/, // Selection list
      /What would you like/i,
      /How should I/i,
      /Should I/i,
      /Do you want/i,
      /Would you like/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private outputIndicatesCompleted(text: string): boolean {
    // Only match if it's in the last few lines (recent completion)
    const lastFewLines = text.split('\n').slice(-10).join('\n');
    const patterns = [
      /✓\s+\w+/,  // Checkmark followed by text
      /✔/,
      /Done[.!]?$/im,
      /Completed[.!]?$/im,
      /Success[.!]?$/im,
      /Finished[.!]?$/im,
      /All \d+ .*(?:fixed|updated|created)/i,
    ];
    return patterns.some((p) => p.test(lastFewLines));
  }

  private outputIndicatesError(text: string): boolean {
    const lines = text
      .split('\n')
      .slice(-20)
      .map((line) => line.replace(/\r/g, '').trimEnd())
      .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return false;
    }

    const patterns = [
      /Error:/i,
      /Failed:/i,
      /Failed to /i,
      /✗/,
      /❌/,
      /FATAL/i,
      /Exception:/i,
      /Traceback/i,
      /panic:/i,
    ];

    const tailBlock = lines.slice(-6).join('\n');
    if (this.outputIndicatesBenignStartupWarning(tailBlock)) {
      return false;
    }

    const last = lines[lines.length - 1];
    const previous = lines[lines.length - 2] ?? '';

    if (patterns.some((p) => p.test(last))) {
      return !this.outputIndicatesBenignStartupWarning(last);
    }

    if (this.looksLikePrompt(last) && patterns.some((p) => p.test(previous))) {
      return !this.outputIndicatesBenignStartupWarning(previous);
    }

    return false;
  }

  private outputIndicatesBenignStartupWarning(text: string): boolean {
    if (!text) {
      return false;
    }

    const patterns = [
      /MCP\s+client\s+for\s+['"]?\w+['"]?\s+failed\s+to\s+start/i,
      /failed\s+to\s+start\s+MCP\s+client/i,
      /MCP\s+server\s+.*\s+is\s+not\s+configured/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  private looksLikePrompt(line: string): boolean {
    if (!line) {
      return false;
    }

    const trimmed = line.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trimEnd();
    if (!trimmed || trimmed.length > 120) {
      return false;
    }

    return /[$#%>❯]\s*$/.test(trimmed);
  }

  private outputIndicatesContextWarning(text: string): boolean {
    // Check for high context usage (>80%)
    const match = text.match(/(\d+)%\s*(?:context|used)|(\d+)k\/(\d+)k\s*tokens?\s*\((\d+)%\)/i);
    if (match) {
      const percentage = parseInt(match[1] || match[4] || '0');
      if (percentage > 80) {
        return true;
      }
    }
    return false;
  }

  private outputIndicatesWaiting(text: string): boolean {
    if (!text) {
      return false;
    }
    const patterns = [
      /waiting for (?:input|response)/i,
      /press (?:enter|return|any key)/i,
      /continue\?\s*(?:\(?y\/n\)?|\[y\/n\])?/i,
      /\by\/n\??\b/i,
      /type (?:a|your) (?:message|prompt|response)/i,
      /enter (?:your )?(?:message|prompt|response)/i,
      /awaiting (?:input|response)/i,
      /ready for (?:input|your)/i,
      /your move/i,
      /type move/i,
    ];

    return patterns.some((pattern) => pattern.test(text));
  }

  /**
   * Map a terminal to an AgentInstance
   */
  private mapAgentFromTerminal(info: TerminalInfo): AgentInstance {
    return {
      type: info.agentType,
      name: this.getAgentName(info.agentType),
      color: this.getAgentColor(info.agentType),
      terminalId: info.id,
      terminalName: info.name,
      isActive: info.isActive,
      isLocal: true,
    };
  }

  /**
   * Get display name for an agent type
   */
  private getAgentName(type: AgentType): string {
    if (type === 'generic') return 'Terminal';
    return AGENT_PATTERNS[type].name;
  }

  /**
   * Get color for an agent type
   */
  private getAgentColor(type: AgentType): string {
    if (type === 'generic') return '#9e9e9e';
    return AGENT_PATTERNS[type].color;
  }

  /**
   * Create a terminal for a project using tmux backend
   */
  public async createTerminalForProject(
    projectPath: string,
    options?: {
      name?: string;
      env?: Record<string, string>;
      show?: boolean;
    }
  ): Promise<{ terminal: vscode.Terminal; tmuxSession: string; pid: number } | null> {
    // Import TmuxManager dynamically to avoid circular dependencies
    const { TmuxManager } = await import('./tmuxManager');
    const tmux = TmuxManager.getInstance();

    const tmuxAvailable = await tmux.isAvailable();
    if (!tmuxAvailable) {
      return null;
    }

    // Get project name for terminal naming
    const project = this.addedProjects.get(projectPath);
    const projectName = project?.name || projectPath.split('/').pop() || 'Terminal';
    const terminalName = options?.name || projectName;

    // Create tmux-backed terminal
    const result = await tmux.createTerminal(terminalName, projectPath, options?.env);
    const terminal = result.terminal;
    const tmuxSession = result.sessionName;

    // Get process ID and register with watcher
    const pid = await terminal.processId;
    if (pid) {
      this.terminalWatcher.setTmuxSession(pid, tmuxSession);
      this.terminalWatcher.setTerminalProject(pid, projectPath);
    }

    // Show terminal if requested
    if (options?.show) {
      terminal.show(true); // preserveFocus = true
    }

    return pid ? { terminal, tmuxSession, pid } : null;
  }

  /**
   * Get all terminals associated with a project
   */
  public getProjectTerminals(projectPath: string): TerminalInfo[] {
    return this.terminalWatcher.getTerminalsForProject(projectPath);
  }

  /**
   * Get the project path for a terminal
   */
  public getTerminalProject(pid: number): string | undefined {
    return this.terminalWatcher.getTerminalProject(pid);
  }

  /**
   * Associate a terminal with a project
   */
  public associateTerminalWithProject(pid: number, projectPath: string): void {
    this.terminalWatcher.setTerminalProject(pid, projectPath);
  }
}
