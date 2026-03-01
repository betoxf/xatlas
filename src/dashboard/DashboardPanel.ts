import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import { AgentDiscovery, ProjectInfo, AgentInstance } from '../services/agentDiscovery';
import { TerminalWatcher } from '../services/terminalWatcher';
import { TmuxManager } from '../services/tmuxManager';
import { TmuxStreamBridge } from '../services/tmuxStreamBridge';
import { getActivePort } from '../server';

/**
 * Manages the AI Agent Dashboard webview panel
 *
 * Note: As of the unification effort, dashboard terminals now use VS Code terminals
 * with tmux backend (same as MCP tools) instead of embedded PTY terminals.
 * This allows AI agents to control dashboard terminals headlessly via MCP.
 */
export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private static readonly viewType = 'aiAgentDashboard';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private agentDiscovery: AgentDiscovery;
  private terminalWatcher: TerminalWatcher;
  private refreshDebounceTimer: NodeJS.Timeout | undefined;
  private eventRefreshTimer: NodeJS.Timeout | undefined;
  private isRefreshing: boolean = false;
  private mirrorNoticeAt: number = 0;
  private mirrorHostLabel: string = 'primary';

  // Tmux streaming bridge for embedded terminals
  private tmuxBridge: TmuxStreamBridge;
  // Track embedded terminal sessions: clientId -> { sessionName, projectPath, terminalId }
  private clientSessions: Map<string, { sessionName: string; projectPath: string; terminalId: number }> = new Map();
  // Buffered input queues to avoid one tmux process spawn per keystroke.
  private queuedInput: Map<
    string,
    { sessionName: string; buffer: string; flushing: boolean; timer?: NodeJS.Timeout }
  > = new Map();
  // Track VS Code terminal associations for legacy PTY compatibility
  private terminalClientIds = new Map<string, vscode.Terminal>(); // clientId -> terminal
  private static readonly INPUT_FLUSH_DELAY_MS = 8;
  private static readonly INPUT_MAX_BUFFER_SIZE = 64000;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    // Initialize services
    this.terminalWatcher = TerminalWatcher.getInstance();
    this.agentDiscovery = AgentDiscovery.getInstance(this.terminalWatcher);
    this.tmuxBridge = new TmuxStreamBridge();

    // Set the webview's initial html content
    this.update();

    // Listen for when the panel is disposed
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      message => {
        this.handleWebviewMessage(message);
      },
      null,
      this.disposables
    );

    // Update when panel becomes visible
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          this.refreshData();
        }
      },
      null,
      this.disposables
    );

    // Stream/event-driven refreshes: avoid periodic polling.
    this.disposables.push(
      vscode.window.onDidOpenTerminal(() => this.scheduleEventRefresh()),
      vscode.window.onDidCloseTerminal(() => this.scheduleEventRefresh()),
      vscode.window.onDidChangeActiveTerminal(() => this.scheduleEventRefresh(200)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleEventRefresh(300))
    );
  }

  /**
   * Create or show the dashboard panel
   */
  public static createOrShow(extensionUri: vscode.Uri): DashboardPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      return DashboardPanel.currentPanel;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Xerebro',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(extensionUri, 'src', 'dashboard', 'webview'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'xterm'),
        ],
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri);
    return DashboardPanel.currentPanel;
  }

  private isMirrorMode(): boolean {
    return false; // Every window now has its own server
  }

  private getMirrorConnection(): { host: string; port: number; label: string } {
    const config = vscode.workspace.getConfiguration('vscode-mcp-server');
    const host = config.get<string>('host', '127.0.0.1');
    const port = config.get<number>('port', 9002);
    return { host, port, label: `${host}:${port}` };
  }

  private maybeShowMirrorNotice(): void {
    const now = Date.now();
    if (now - this.mirrorNoticeAt < 3000) {
      return;
    }
    this.mirrorNoticeAt = now;
    vscode.window.showInformationMessage(
      `Xerebro is in mirror mode. Control terminals/projects in the host window (${this.mirrorHostLabel}).`
    );
  }

  private async postMirrorRequest(
    host: string,
    port: number,
    payload: unknown,
    timeoutMs: number = 4000
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const body = JSON.stringify(payload);
      const req = http.request(
        {
          host,
          port,
          path: '/mcp',
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString();
          });
          res.on('end', () => resolve(data || null));
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  private normalizeMirrorProjects(rawProjects: any[]): ProjectInfo[] {
    return rawProjects
      .map((project) => {
        const terminalsRaw = Array.isArray(project?.terminals) ? project.terminals : [];
        const agentsRaw = Array.isArray(project?.agents) ? project.agents : [];

        const terminals = terminalsRaw.map((terminal: any) => ({
          processId: Number(terminal?.processId || terminal?.terminalId || Date.now()),
          name: typeof terminal?.name === 'string' ? terminal.name : 'Terminal',
          agentType: terminal?.agentType || 'generic',
          isActive: !!terminal?.isActive,
          lastOutput:
            typeof terminal?.outputPreview === 'string'
              ? terminal.outputPreview
              : typeof terminal?.lastOutput === 'string'
                ? terminal.lastOutput
                : '',
          lastOutputAt: typeof terminal?.lastOutputAt === 'number' ? terminal.lastOutputAt : 0,
        }));

        const agents: AgentInstance[] = agentsRaw.map((agent: any) => ({
          type: agent?.type || 'generic',
          name: typeof agent?.name === 'string' ? agent.name : 'Agent',
          color: typeof agent?.color === 'string' ? agent.color : '#888888',
          terminalId: Number(agent?.terminalId || 0),
          terminalName: '',
          isActive: !!agent?.isActive,
          isLocal: project?.isLocal !== false,
        }));

        return {
          name: typeof project?.name === 'string' ? project.name : 'Project',
          path: typeof project?.path === 'string' ? project.path : '',
          isLocal: project?.isLocal !== false,
          terminals,
          agents,
          activity: project?.activity || 'idle',
          accentColor: typeof project?.accentColor === 'string' ? project.accentColor : undefined,
        } as ProjectInfo;
      })
      .filter((project) => !!project.path);
  }

  private async fetchMirrorProjects(): Promise<ProjectInfo[] | null> {
    const mirror = this.getMirrorConnection();
    this.mirrorHostLabel = mirror.label;

    const responseRaw = await this.postMirrorRequest(mirror.host, mirror.port, {
      jsonrpc: '2.0',
      id: `mirror-state-${Date.now()}`,
      method: 'tools/call',
      params: {
        name: 'vscode_dashboard_get_state',
        arguments: {
          includeTerminalOutput: true,
          outputLines: 30,
          includeAgentDetails: true,
        },
      },
    });

    if (!responseRaw) {
      return null;
    }

    try {
      const response = JSON.parse(responseRaw);
      const text = response?.result?.content?.find((item: any) => item?.type === 'text')?.text;
      if (!text || typeof text !== 'string') {
        return null;
      }
      const parsed = JSON.parse(text);
      const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
      return this.normalizeMirrorProjects(projects);
    } catch {
      return null;
    }
  }

  /**
   * Handle messages from the webview
   */
  private async handleWebviewMessage(message: any): Promise<void> {
    if (
      this.isMirrorMode() &&
      message.command &&
      message.command !== 'refresh' &&
      message.command !== 'debug:log'
    ) {
      this.maybeShowMirrorNotice();
      return;
    }

    switch (message.command) {
      case 'refresh':
        await this.refreshData();
        break;

      case 'sendCommand':
        await this.sendCommand(message.terminalId, message.text);
        break;

      case 'startAgent':
        await this.startAgent(message.agentType, message.projectPath);
        break;

      case 'stopAgent':
        await this.stopAgent(message.terminalId);
        break;

      case 'showTerminal':
        await this.showTerminal(message.terminalId);
        break;

      case 'focusTerminal':
        await this.focusRealTerminal(message.terminalId);
        break;

      case 'openTerminalInEditor':
        await this.openTerminalInEditor(message.terminalId);
        break;

      case 'openProjectTerminals':
        await this.openProjectTerminalsInEditor(message.project);
        break;

      case 'addProject':
        await this.addProject();
        break;

      case 'getTerminalOutput':
        await this.sendTerminalOutput(message.terminalId);
        break;

      case 'removeProject':
        await this.removeProject(message.projectPath);
        break;

      case 'projectActivity':
        if (
          typeof message.projectPath === 'string' &&
          (message.activity === 'idle' || message.activity === 'running' || message.activity === 'waiting' || message.activity === 'processing' || message.activity === 'waiting_input' || message.activity === 'completed' || message.activity === 'error' || message.activity === 'context_warning')
        ) {
          this.agentDiscovery.setProjectActivity(message.projectPath, message.activity);
        }
        break;

      case 'openProjectTerminal':
        await this.openProjectTerminal(message.projectPath, message.terminalName);
        break;

      case 'createProjectTerminal':
        await this.createProjectTerminal(message.projectPath, message.name);
        break;

      // Legacy PTY commands - now redirected to VS Code terminals
      // These are kept for backwards compatibility with existing webview code
      case 'pty:create':
        await this.createProjectTerminal(
          message.cwd,
          message.terminalName,
          message.clientId,
          message.cols,
          message.rows,
          message.terminalId
        );
        break;

      case 'pty:write':
        await this.sendToTerminalByClientId(message.id, message.data);
        break;

      case 'pty:resize':
        await this.resizeTerminalByClientId(message.id, message.cols, message.rows);
        break;

      case 'pty:kill':
        await this.closeTerminalByClientId(message.id);
        break;

      case 'pty:detach':
        await this.detachTerminalByClientId(message.id);
        break;

      // Card embedded terminal commands
      case 'card:pty:create':
        await this.createCardTerminal(
          message.projectPath,
          message.clientId,
          message.cols,
          message.rows,
          message.terminalId,
          message.terminalName
        );
        break;

      case 'card:pty:write':
        await this.sendToCardTerminal(message.id, message.projectPath, message.data);
        break;

      case 'card:pty:resize':
        await this.resizeCardTerminal(message.id, message.projectPath, message.cols, message.rows);
        break;

      case 'card:pty:detach':
        await this.detachCardTerminal(message.id, message.projectPath);
        break;

      case 'card:pty:kill':
        await this.killCardTerminal(message.id, message.projectPath);
        break;

      case 'reorderProjects':
        if (Array.isArray(message.order)) {
          this.agentDiscovery.setProjectOrder(message.order);
          await this.refreshData();
        }
        break;

      case 'debug:log':
        console.log('[Webview Debug]', message.message);
        break;
    }
  }

  /**
   * Open or focus a project terminal
   * Uses tmux-backed VS Code terminal for headless MCP control
   */
  private async openProjectTerminal(projectPath: string, terminalName?: string): Promise<void> {
    try {
      // Find existing terminal for this project
      const projectTerminals = this.terminalWatcher.getTerminalsForProject(projectPath);

      if (projectTerminals.length > 0) {
        // Find matching terminal by name, or use first one
        const targetTerminal = terminalName
          ? projectTerminals.find(t => t.name === terminalName)
          : projectTerminals[0];

        if (targetTerminal) {
          targetTerminal.terminal.show(false); // false = take focus
          await vscode.commands.executeCommand('workbench.action.terminal.focus');
          return;
        }
      }

      // Create new terminal for project
      await this.createProjectTerminal(projectPath);
    } catch (error) {
      console.error('Error opening project terminal:', error);
    }
  }

  /**
   * Create a new tmux-backed terminal for a project
   *
   * When clientId is provided, creates an embedded terminal for the dashboard webview
   * with tmux streaming. When clientId is not provided, creates a VS Code terminal panel.
   */
  private async createProjectTerminal(
    projectPath: string,
    name?: string,
    clientId?: string,
    cols?: number,
    rows?: number,
    terminalId?: number
  ): Promise<void> {
    try {
      const tmux = TmuxManager.getInstance();
      const tmuxAvailable = await tmux.isAvailable();

      const projectName = name || projectPath.split('/').pop() || 'Terminal';

      // If clientId is provided, create embedded terminal with tmux streaming
      // This keeps the terminal in the webview instead of opening VS Code terminal panel
      if (clientId) {
        console.log(`[DashboardPanel] Creating embedded terminal for clientId: ${clientId}, tmuxAvailable: ${tmuxAvailable}`);

        if (!tmuxAvailable) {
          // Tmux is required for embedded terminals
          console.log(`[DashboardPanel] Tmux not available, sending error`);
          this.panel.webview.postMessage({
            type: 'pty:error',
            error: 'tmux is required for embedded terminals. Install with: brew install tmux',
            clientId,
          });
          return;
        }

        let sessionName: string | undefined;
        let sessionTerminalId: number | undefined;
        let isReconnecting = false;

        if (typeof terminalId === 'number') {
          const tmuxInfo = tmux.getSessionByTerminalId(terminalId);
          if (tmuxInfo?.sessionName) {
            sessionName = tmuxInfo.sessionName;
            sessionTerminalId = tmuxInfo.terminalId;
            isReconnecting = true; // Reconnecting to existing session
            console.log(`[DashboardPanel] Reconnecting to existing session: ${sessionName}`);
          } else {
            const info = this.terminalWatcher.getTerminal(terminalId);
            if (info?.tmuxSession) {
              sessionName = info.tmuxSession;
              sessionTerminalId = info.id;
              isReconnecting = true; // Reconnecting to existing session
              console.log(`[DashboardPanel] Reconnecting to existing session from watcher: ${sessionName}`);
            }
          }
        }

        if (!sessionName) {
          sessionTerminalId = Date.now();
          console.log(`[DashboardPanel] Creating tmux session with terminalId: ${sessionTerminalId}`);
          sessionName = await tmux.createSession(sessionTerminalId, projectName, projectPath);
          console.log(`[DashboardPanel] Tmux session created: ${sessionName}`);
        }

        const hasSize = typeof cols === 'number' &&
          typeof rows === 'number' &&
          Number.isFinite(cols) &&
          Number.isFinite(rows) &&
          cols > 0 &&
          rows > 0;
        if (hasSize) {
          await tmux.resizeSession(sessionName, cols, rows);
        }

        // Track this session for input/output
        this.clientSessions.set(clientId, {
          sessionName,
          projectPath,
          terminalId: sessionTerminalId || Date.now(),
        });

        // Notify webview that PTY is ready first
        const reportedTerminalId = sessionTerminalId ?? terminalId;
        const reportedTerminalName =
          (typeof reportedTerminalId === 'number'
            ? tmux.getSessionByTerminalId(reportedTerminalId)?.terminalName
            : undefined) || projectName;
        this.panel.webview.postMessage({
          type: 'pty:created',
          id: clientId,
          clientId,
          pid: reportedTerminalId,
          terminalName: reportedTerminalName,
          tmuxSession: sessionName,
          backend: 'tmux',
          reconnect: isReconnecting, // Indicates we're reconnecting to existing session
        });

        // Give the tmux session a moment to initialize, then start streaming
        await new Promise(resolve => setTimeout(resolve, 50));

        console.log(`[DashboardPanel] Starting stream for clientId: ${clientId}, session: ${sessionName}`);

        // Start streaming tmux output to webview (pipe-pane)
        // Always include an initial snapshot so the current prompt/cwd is visible
        // even if it rendered before the pipe was attached.
        await this.tmuxBridge.startStream(clientId, sessionName, {
          onData: (payload) => {
            if (!payload || typeof payload.text !== 'string') return;
            this.panel.webview.postMessage({
              type: 'pty:data',
              id: clientId,
              data: payload.text,
              full: payload.full,
              reconnect: isReconnecting, // Pass reconnect flag to webview
            });
          },
          onExit: () => {
            this.panel.webview.postMessage({
              type: 'pty:exit',
              id: clientId,
              code: 0,
            });
            this.clearQueuedInput(`pty:${clientId}`);
            this.clientSessions.delete(clientId);
          },
          onError: (error) => {
            console.error(`[DashboardPanel] Tmux stream error for ${clientId}:`, error);
          },
        }, { cols, rows }, false);

        console.log(`[DashboardPanel] Stream started for clientId: ${clientId}`);

        // NOTE: Do NOT open VS Code terminal panel for embedded terminals
        return;
      }

      // No clientId - create VS Code terminal panel (for non-embedded use)
      let terminal: vscode.Terminal;
      let tmuxSession: string | undefined;

      if (tmuxAvailable) {
        // Create tmux-backed terminal for headless control
        const result = await tmux.createTerminal(projectName, projectPath);
        terminal = result.terminal;
        tmuxSession = result.sessionName;

        // Register with terminal watcher
        const pid = await terminal.processId;
        if (pid) {
          this.terminalWatcher.setTmuxSession(pid, tmuxSession);
          this.terminalWatcher.setTerminalProject(pid, projectPath);
        }
      } else {
        // Fallback to regular VS Code terminal
        terminal = vscode.window.createTerminal({
          name: projectName,
          cwd: projectPath,
        });
      }

      terminal.show(false);
      await vscode.commands.executeCommand('workbench.action.terminal.focus');
    } catch (error) {
      console.error('Error creating project terminal:', error);
      if (clientId) {
        this.panel.webview.postMessage({
          type: 'pty:error',
          error: error instanceof Error ? error.message : 'Failed to create terminal',
          clientId,
        });
      }
    }
  }

  private queueTmuxInput(queueKey: string, sessionName: string, data: string): void {
    if (!data) {
      return;
    }

    let entry = this.queuedInput.get(queueKey);
    if (!entry || entry.sessionName !== sessionName) {
      if (entry?.timer) {
        clearTimeout(entry.timer);
      }
      entry = {
        sessionName,
        buffer: '',
        flushing: false,
      };
      this.queuedInput.set(queueKey, entry);
    }

    entry.buffer += data;
    if (entry.buffer.length > DashboardPanel.INPUT_MAX_BUFFER_SIZE) {
      entry.buffer = entry.buffer.slice(-DashboardPanel.INPUT_MAX_BUFFER_SIZE);
    }

    this.scheduleQueuedInputFlush(queueKey);
  }

  private scheduleQueuedInputFlush(queueKey: string): void {
    const entry = this.queuedInput.get(queueKey);
    if (!entry || entry.flushing || entry.timer) {
      return;
    }

    entry.timer = setTimeout(() => {
      const current = this.queuedInput.get(queueKey);
      if (!current) {
        return;
      }
      current.timer = undefined;
      void this.flushQueuedInput(queueKey);
    }, DashboardPanel.INPUT_FLUSH_DELAY_MS);
  }

  private async flushQueuedInput(queueKey: string): Promise<void> {
    const entry = this.queuedInput.get(queueKey);
    if (!entry || entry.flushing || entry.buffer.length === 0) {
      return;
    }

    const payload = entry.buffer;
    entry.buffer = '';
    entry.flushing = true;

    try {
      const tmux = TmuxManager.getInstance();
      await tmux.sendKeys(entry.sessionName, payload, false);
    } catch (error) {
      console.error(`[DashboardPanel] Failed to flush input queue for ${queueKey}:`, error);
    } finally {
      const current = this.queuedInput.get(queueKey);
      if (!current) {
        return;
      }
      current.flushing = false;
      if (current.buffer.length > 0) {
        this.scheduleQueuedInputFlush(queueKey);
      }
    }
  }

  private clearQueuedInput(queueKey: string): void {
    const entry = this.queuedInput.get(queueKey);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    this.queuedInput.delete(queueKey);
  }

  /**
   * Send data to a terminal by client ID
   * Looks up the tmux session from clientSessions and sends keys directly
   */
  private async sendToTerminalByClientId(clientId: string, data: string): Promise<void> {
    // First check embedded terminal sessions (tmux)
    const session = this.clientSessions.get(clientId);
    if (session) {
      this.queueTmuxInput(`pty:${clientId}`, session.sessionName, data);
      return;
    }

    // Fall back to legacy VS Code terminal tracking
    const terminal = this.terminalClientIds.get(clientId);
    if (!terminal) {
      return;
    }

    const pid = await terminal.processId;
    if (!pid) {
      return;
    }

    // Try tmux first for headless control
    const tmuxSession = this.terminalWatcher.getTmuxSession(pid);
    if (tmuxSession) {
      const tmux = TmuxManager.getInstance();
      // Don't add newline - let the caller control that
      await tmux.sendKeys(tmuxSession, data, false);
    } else {
      // Fall back to VS Code sendText
      terminal.sendText(data, false);
    }
  }

  /**
   * Resize an embedded tmux session by client ID
   */
  private async resizeTerminalByClientId(clientId: string, cols?: number, rows?: number): Promise<void> {
    const hasSize = typeof cols === 'number' &&
      typeof rows === 'number' &&
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      cols > 0 &&
      rows > 0;
    if (!hasSize) {
      return;
    }

    const session = this.clientSessions.get(clientId);
    if (!session) {
      return;
    }

    const tmux = TmuxManager.getInstance();
    await tmux.resizeSession(session.sessionName, cols, rows);
    this.tmuxBridge.updateSize(clientId, cols, rows);
  }

  /**
   * Close a terminal by client ID
   * Handles embedded tmux sessions and legacy VS Code terminals
   */
  private async closeTerminalByClientId(clientId: string): Promise<void> {
    const tmux = TmuxManager.getInstance();

    // First check embedded terminal sessions
    const session = this.clientSessions.get(clientId);
    if (session) {
      // Stop the stream
      await this.tmuxBridge.stopStream(clientId);

      // Kill the tmux session
      await tmux.killSession(session.sessionName);

      // Clean up tracking
      this.clearQueuedInput(`pty:${clientId}`);
      this.clientSessions.delete(clientId);

      // Notify webview
      this.panel.webview.postMessage({
        type: 'pty:exit',
        id: clientId,
        code: 0,
      });
      return;
    }

    // Fall back to legacy VS Code terminal tracking
    const terminal = this.terminalClientIds.get(clientId);
    if (!terminal) {
      return;
    }

    const pid = await terminal.processId;
    if (pid) {
      const tmuxSession = this.terminalWatcher.getTmuxSession(pid);
      if (tmuxSession) {
        await tmux.killSession(tmuxSession);
      }
    }

    terminal.dispose();
    this.terminalClientIds.delete(clientId);

    // Notify webview
    this.panel.webview.postMessage({
      type: 'pty:exit',
      id: clientId,
      code: 0,
    });
  }

  /**
   * Detach an embedded tmux session by client ID (stop stream only)
   */
  private async detachTerminalByClientId(clientId: string): Promise<void> {
    const session = this.clientSessions.get(clientId);
    if (!session) {
      return;
    }

    await this.tmuxBridge.stopStream(clientId);
    this.clearQueuedInput(`pty:${clientId}`);
    this.clientSessions.delete(clientId);
  }

  // ==========================================
  // Card Embedded Terminal Backend Methods
  // ==========================================

  // Track card terminal sessions: clientId -> { sessionName, projectPath, terminalId }
  private cardClientSessions: Map<string, { sessionName: string; projectPath: string; terminalId: number }> = new Map();
  // Track card terminal names so MCP can consistently target tabs by name across detach/reattach cycles.
  private cardTerminalNameIndex: Map<string, Map<string, number>> = new Map();

  private normalizeProjectKey(projectPath: string): string {
    try {
      return path.resolve(projectPath);
    } catch {
      return projectPath;
    }
  }

  private rememberCardTerminalAlias(projectPath: string, terminalName: string | undefined, terminalId?: number): void {
    if (!terminalName || typeof terminalId !== 'number' || !Number.isFinite(terminalId)) {
      return;
    }

    const normalizedName = terminalName.trim().toLowerCase();
    if (!normalizedName) {
      return;
    }

    const projectKey = this.normalizeProjectKey(projectPath);
    let aliases = this.cardTerminalNameIndex.get(projectKey);
    if (!aliases) {
      aliases = new Map<string, number>();
      this.cardTerminalNameIndex.set(projectKey, aliases);
    }

    aliases.set(normalizedName, terminalId);
  }

  public resolveCardTerminalId(projectPath: string, terminalName: string): number | undefined {
    const normalizedName = terminalName.trim().toLowerCase();
    if (!normalizedName) {
      return undefined;
    }

    const projectKey = this.normalizeProjectKey(projectPath);
    const aliases = this.cardTerminalNameIndex.get(projectKey);
    const indexed = aliases?.get(normalizedName);
    if (typeof indexed === 'number' && Number.isFinite(indexed)) {
      return indexed;
    }

    // Fallback to tmux session metadata in case this terminal existed before index warmup.
    const tmux = TmuxManager.getInstance();
    const fallback = tmux
      .getAllSessions()
      .find((session) => {
        if (typeof session.cwd !== 'string' || session.cwd.length === 0) {
          return false;
        }
        const sameProject = this.normalizeProjectKey(session.cwd) === projectKey;
        if (!sameProject) {
          return false;
        }
        return (session.terminalName || '').trim().toLowerCase() === normalizedName;
      });

    return fallback?.terminalId;
  }

  /**
   * Create an embedded terminal for a card (uses same tmux infrastructure as floating windows)
   */
  private async createCardTerminal(
    projectPath: string,
    clientId: string,
    cols?: number,
    rows?: number,
    terminalId?: number,
    terminalName?: string
  ): Promise<void> {
    try {
      const tmux = TmuxManager.getInstance();
      const tmuxAvailable = await tmux.isAvailable();

      console.log(`[DashboardPanel] Creating card terminal for clientId: ${clientId}, projectPath: ${projectPath}`);

      if (!tmuxAvailable) {
        this.panel.webview.postMessage({
          type: 'card:pty:error',
          error: 'tmux is required for embedded terminals. Install with: brew install tmux',
          clientId,
        });
        return;
      }

      let sessionName: string | undefined;
      let sessionTerminalId: number | undefined;
      let isReconnecting = false;

      // Check if reconnecting to existing session
      if (typeof terminalId === 'number') {
        const tmuxInfo = tmux.getSessionByTerminalId(terminalId);
        if (tmuxInfo?.sessionName) {
          sessionName = tmuxInfo.sessionName;
          sessionTerminalId = tmuxInfo.terminalId;
          isReconnecting = true;
          console.log(`[DashboardPanel] Card reconnecting to existing session: ${sessionName}`);
        } else {
          const info = this.terminalWatcher.getTerminal(terminalId);
          if (info?.tmuxSession) {
            sessionName = info.tmuxSession;
            sessionTerminalId = info.id;
            isReconnecting = true;
            console.log(`[DashboardPanel] Card reconnecting to session from watcher: ${sessionName}`);
          }
        }
      }

      // Create new session if not reconnecting
      if (!sessionName) {
        sessionTerminalId = Date.now();
        const requestedName =
          typeof terminalName === 'string' && terminalName.trim()
            ? terminalName.trim()
            : projectPath.split('/').pop() || 'Terminal';
        console.log(`[DashboardPanel] Creating card tmux session with terminalId: ${sessionTerminalId}`);
        sessionName = await tmux.createSession(sessionTerminalId, requestedName, projectPath);
        console.log(`[DashboardPanel] Card tmux session created: ${sessionName}`);
      }

      // Resize if dimensions provided
      const hasSize = typeof cols === 'number' &&
        typeof rows === 'number' &&
        Number.isFinite(cols) &&
        Number.isFinite(rows) &&
        cols > 0 &&
        rows > 0;
      if (hasSize) {
        await tmux.resizeSession(sessionName, cols, rows);
      }

      // Track this session
      this.cardClientSessions.set(clientId, {
        sessionName,
        projectPath,
        terminalId: sessionTerminalId || Date.now(),
      });

      const canonicalTerminalId = sessionTerminalId ?? terminalId;
      const aliasName =
        typeof terminalName === 'string' && terminalName.trim()
          ? terminalName.trim()
          : typeof canonicalTerminalId === 'number'
            ? tmux.getSessionByTerminalId(canonicalTerminalId)?.terminalName
            : undefined;
      this.rememberCardTerminalAlias(projectPath, aliasName, canonicalTerminalId);

      const reportedTerminalId = canonicalTerminalId;
      const reportedTerminalName =
        (typeof reportedTerminalId === 'number'
          ? tmux.getSessionByTerminalId(reportedTerminalId)?.terminalName
          : undefined) || aliasName || (projectPath.split('/').pop() || 'Terminal');

      // Notify webview that card PTY is ready
      this.panel.webview.postMessage({
        type: 'card:pty:created',
        id: clientId,
        clientId,
        pid: reportedTerminalId,
        terminalName: reportedTerminalName,
        tmuxSession: sessionName,
        backend: 'tmux',
        reconnect: isReconnecting,
        projectPath,
      });

      // Give tmux a moment, then start streaming
      await new Promise(resolve => setTimeout(resolve, 50));

      console.log(`[DashboardPanel] Starting card stream for clientId: ${clientId}, session: ${sessionName}`);

      // Start streaming tmux output to webview with an initial snapshot so
      // new and reconnected card terminals always render prompt/cwd immediately.
      await this.tmuxBridge.startStream(clientId, sessionName, {
        onData: (payload) => {
          if (!payload || typeof payload.text !== 'string') return;
          this.panel.webview.postMessage({
            type: 'card:pty:data',
            id: clientId,
            data: payload.text,
            full: payload.full,
            reconnect: isReconnecting,
            projectPath,
          });
        },
        onExit: () => {
          this.panel.webview.postMessage({
            type: 'card:pty:exit',
            id: clientId,
            code: 0,
            projectPath,
          });
          this.clearQueuedInput(`card:${clientId}`);
          this.cardClientSessions.delete(clientId);
        },
        onError: (error) => {
          console.error(`[DashboardPanel] Card tmux stream error for ${clientId}:`, error);
        },
      }, { cols, rows }, false);

      console.log(`[DashboardPanel] Card stream started for clientId: ${clientId}`);

    } catch (error) {
      console.error('Error creating card terminal:', error);
      this.panel.webview.postMessage({
        type: 'card:pty:error',
        error: error instanceof Error ? error.message : 'Failed to create card terminal',
        clientId,
      });
    }
  }

  /**
   * Send data to a card terminal
   */
  private async sendToCardTerminal(clientId: string, projectPath: string, data: string): Promise<void> {
    const session = this.cardClientSessions.get(clientId);
    if (!session) {
      return;
    }

    this.queueTmuxInput(`card:${clientId}`, session.sessionName, data);
  }

  /**
   * Resize a card terminal
   */
  private async resizeCardTerminal(clientId: string, projectPath: string, cols?: number, rows?: number): Promise<void> {
    const hasSize = typeof cols === 'number' &&
      typeof rows === 'number' &&
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      cols > 0 &&
      rows > 0;
    if (!hasSize) {
      return;
    }

    const session = this.cardClientSessions.get(clientId);
    if (!session) {
      return;
    }

    const tmux = TmuxManager.getInstance();
    await tmux.resizeSession(session.sessionName, cols, rows);
    this.tmuxBridge.updateSize(clientId, cols, rows);
  }

  /**
   * Detach a card terminal (stop streaming but keep session alive)
   */
  private async detachCardTerminal(clientId: string, projectPath: string): Promise<void> {
    const session = this.cardClientSessions.get(clientId);
    if (!session) {
      return;
    }

    await this.tmuxBridge.stopStream(clientId);
    this.clearQueuedInput(`card:${clientId}`);
    this.cardClientSessions.delete(clientId);
    // Note: We don't kill the tmux session - it stays alive for reconnection
  }

  /**
   * Kill a card terminal completely (stop streaming AND kill tmux session)
   */
  private async killCardTerminal(clientId: string, projectPath: string): Promise<void> {
    const session = this.cardClientSessions.get(clientId);
    if (!session) {
      return;
    }

    const tmux = TmuxManager.getInstance();
    await this.tmuxBridge.stopStream(clientId);
    await tmux.killSession(session.sessionName).catch(() => {});
    this.clearQueuedInput(`card:${clientId}`);
    this.cardClientSessions.delete(clientId);
    console.log(`[DashboardPanel] Killed card terminal session: ${session.sessionName}`);
  }

  /**
   * Send a message to the webview to create an embedded terminal in a card (called by MCP)
   */
  public sendCreateEmbeddedTerminalMessage(projectPath: string, name?: string): void {
    console.log('[DashboardPanel] sendCreateEmbeddedTerminalMessage called:', projectPath, name);
    console.log('[DashboardPanel] Panel visible:', this.panel.visible);
    console.log('[DashboardPanel] Sending mcp:createEmbeddedTerminal message to webview');
    this.panel.webview.postMessage({
      type: 'mcp:createEmbeddedTerminal',
      projectPath,
      name,
    });
    console.log('[DashboardPanel] Message posted to webview');
  }

  /**
   * Open a project's card terminal visually (expand the card and show terminal)
   * This is the main method for programmatically opening card terminals
   */
  public async openCardTerminal(
    projectPath: string,
    options?: {
      terminalName?: string;
      terminalId?: number;
      createNewTerminal?: boolean;
    }
  ): Promise<{ success: boolean; clientId?: string; error?: string }> {
    console.log('[DashboardPanel] openCardTerminal called:', projectPath, options);

    // First, make sure the panel is visible and focused
    this.panel.reveal(vscode.ViewColumn.One);

    // Record existing clientIds so we can detect NEW ones
    const existingClientIds = new Set(this.getFloatingWindowTerminals().map((terminal) => terminal.clientId));
    console.log('[DashboardPanel] Existing clientIds:', Array.from(existingClientIds));

    // Send message to expand the card and create terminal
    this.panel.webview.postMessage({
      type: 'mcp:openCardTerminal',
      projectPath,
      terminalName: options?.terminalName,
      terminalId: options?.terminalId,
      createNewTerminal: options?.createNewTerminal,
    });

    // Wait for a NEW card terminal to be created.
    // 8s avoids false timeouts when webview/card rendering is still settling.
    const maxWait = 8000;
    const pollInterval = 200;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      waited += pollInterval;

      // Check if a NEW collaborative terminal was created for this project
      const newTerminal = this.getFloatingWindowTerminals().find(
        (terminal) => terminal.projectPath === projectPath && !existingClientIds.has(terminal.clientId)
      );

      if (newTerminal) {
        console.log('[DashboardPanel] NEW collaborative terminal created:', newTerminal.clientId);
        return { success: true, clientId: newTerminal.clientId };
      }
    }

    // Timeout - check if there's ANY terminal for this project (maybe it was already open visually)
    const projectTerminals = this.getFloatingWindowTerminals().filter(
      (terminal) => terminal.projectPath === projectPath
    );
    let anyTerminal: ReturnType<DashboardPanel['getFloatingWindowTerminals']>[number] | undefined;
    if (typeof options?.terminalId === 'number') {
      anyTerminal = projectTerminals.find(
        (terminal) => terminal.terminalId === options.terminalId
      );
    }

    if (!anyTerminal) {
      anyTerminal = projectTerminals[0];
    }

    if (anyTerminal) {
      console.log('[DashboardPanel] Found existing terminal after timeout:', anyTerminal.clientId);
      return { success: true, clientId: anyTerminal.clientId };
    }

    // Timeout - terminal wasn't created
    console.log('[DashboardPanel] Timeout waiting for card terminal');
    return { success: false, error: 'Timeout waiting for card terminal to be created. Make sure the project exists in the dashboard.' };
  }

  /**
   * Get list of active card terminals (for MCP)
   */
  public getCardTerminals(): Array<{ clientId: string; sessionName: string; projectPath: string; terminalId: number }> {
    return Array.from(this.cardClientSessions.entries()).map(([clientId, session]) => ({
      clientId,
      ...session,
    }));
  }

  /**
   * Read output from a card terminal's tmux session (for MCP)
   */
  public async readCardTerminalOutput(clientId: string, lines: number = 100): Promise<string | null> {
    const session = this.cardClientSessions.get(clientId);
    if (!session) {
      return null;
    }
    const tmux = TmuxManager.getInstance();
    return await tmux.readBuffer(session.sessionName, lines);
  }

  /**
   * Send text to a card terminal (for MCP)
   */
  public async sendToCardTerminalByClientId(clientId: string, text: string): Promise<boolean> {
    const session = this.cardClientSessions.get(clientId);
    if (!session) {
      return false;
    }
    const tmux = TmuxManager.getInstance();
    await tmux.sendKeys(session.sessionName, text);
    return true;
  }

  // ==========================================
  // End of Card Embedded Terminal Backend Methods
  // ==========================================

  /**
   * Refresh all data and send to webview (debounced to prevent rapid calls)
   */
  private async refreshData(): Promise<void> {
    // Debounce: if a refresh is already scheduled, skip
    if (this.refreshDebounceTimer) {
      return;
    }

    // If currently refreshing, schedule another refresh after completion
    if (this.isRefreshing) {
      this.refreshDebounceTimer = setTimeout(() => {
        this.refreshDebounceTimer = undefined;
        this.refreshData();
      }, 200);
      return;
    }

    this.isRefreshing = true;
    try {
      const mirrorMode = this.isMirrorMode();
      let projects: ProjectInfo[];

      if (mirrorMode) {
        const mirrored = await this.fetchMirrorProjects();
        projects = mirrored ?? [];

        if (!mirrored) {
          // Fallback to local discovery if host state couldn't be fetched.
          projects = await this.agentDiscovery.discoverProjects();
        }
      } else {
        projects = await this.agentDiscovery.discoverProjects();
      }

      this.panel.webview.postMessage({
        type: 'dashboard:mode',
        mirrorMode,
        hostLabel: this.mirrorHostLabel,
      });

      this.panel.webview.postMessage({
        type: 'projectsUpdate',
        projects,
        mirrorMode,
        hostLabel: this.mirrorHostLabel,
      });
    } finally {
      this.isRefreshing = false;
      // Add a small delay before allowing next refresh (debounce)
      this.refreshDebounceTimer = setTimeout(() => {
        this.refreshDebounceTimer = undefined;
      }, 200);
    }
  }

  private scheduleEventRefresh(delayMs: number = 250): void {
    if (!this.panel.visible) {
      return;
    }

    if (this.eventRefreshTimer) {
      return;
    }

    this.eventRefreshTimer = setTimeout(() => {
      this.eventRefreshTimer = undefined;
      void this.refreshData();
    }, delayMs);
  }

  /**
   * Send command to a terminal
   */
  private async sendCommand(terminalId: number, text: string): Promise<void> {
    const terminals = vscode.window.terminals;
    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === terminalId) {
        terminal.sendText(text);
        break;
      }
    }
  }

  /**
   * Start an AI agent in a project
   */
  private async startAgent(agentType: string, projectPath: string): Promise<void> {
    const { AgentLauncher } = await import('../services/agentLauncher');
    const launcher = AgentLauncher.getInstance();
    await launcher.startAgent(agentType, projectPath);
    await this.refreshData();
  }

  /**
   * Stop an agent by closing its terminal
   */
  private async stopAgent(terminalId: number): Promise<void> {
    const terminals = vscode.window.terminals;
    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === terminalId) {
        terminal.dispose();
        break;
      }
    }
    await this.refreshData();
  }

  /**
   * Show/focus a terminal
   */
  private async showTerminal(terminalId: number): Promise<void> {
    const terminals = vscode.window.terminals;
    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === terminalId) {
        terminal.show();
        break;
      }
    }
  }

  /**
   * Focus the real VS Code terminal for full terminal experience with autocompletion
   */
  private async focusRealTerminal(terminalId: number): Promise<void> {
    const terminals = vscode.window.terminals;
    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === terminalId) {
        // Show the terminal in VS Code
        terminal.show(false); // false = don't preserve focus, actually focus the terminal

        // Move focus to the terminal panel
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
        break;
      }
    }
  }

  /**
   * Open terminal in the editor area (as a tab) for better integration with dashboard
   */
  private async openTerminalInEditor(terminalId: number): Promise<void> {
    const terminals = vscode.window.terminals;
    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === terminalId) {
        // First show and focus this terminal
        terminal.show(false);

        // Then move it to the editor area
        await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
        break;
      }
    }
  }

  /**
   * Open all project terminals in editor tabs
   */
  private async openProjectTerminalsInEditor(project: any): Promise<void> {
    if (!project.terminals || project.terminals.length === 0) {
      vscode.window.showInformationMessage('No terminals in this project');
      return;
    }

    const terminals = vscode.window.terminals;

    // Find and open each terminal from this project
    for (const projTerminal of project.terminals) {
      for (const terminal of terminals) {
        const pid = await terminal.processId;
        if (pid === projTerminal.processId) {
          terminal.show(false);
          await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
          break;
        }
      }
    }

    // Focus the first terminal
    const firstTerminal = project.terminals[0];
    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === firstTerminal.processId) {
        terminal.show(false);
        break;
      }
    }
  }

  /**
   * Add a new project to monitor
   */
  private async addProject(): Promise<void> {
    try {
      const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri,
        openLabel: 'Add Project',
        title: 'Add Project Folder',
      });

      if (!folderUri || !folderUri[0]) {
        return;
      }

      const folderPath = folderUri[0].fsPath;
      if (!folderPath) {
        return;
      }

      const tracked = this.agentDiscovery.getTrackedProjects();
      if (tracked.some(project => project.path === folderPath)) {
        vscode.window.showInformationMessage(`Project already added: ${folderPath}`);
        return;
      }

      const projectName = path.basename(folderPath);
      this.agentDiscovery.addProject(folderPath, projectName);
      await this.refreshData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[DashboardPanel] addProject failed:', error);
      vscode.window.showErrorMessage(`Failed to add project: ${message}`);
    }
  }

  /**
   * Send terminal output to webview
   */
  private async sendTerminalOutput(terminalId: number): Promise<void> {
    const output = await this.terminalWatcher.getOutput(terminalId);
    this.panel.webview.postMessage({
      type: 'terminalOutput',
      terminalId,
      output: output || '',
    });
  }

  /**
   * Remove a project from tracking and kill all its tmux sessions
   */
  private async removeProject(projectPath: string): Promise<void> {
    const tmux = TmuxManager.getInstance();

    // Kill all floating window sessions for this project
    for (const [clientId, session] of this.clientSessions) {
      if (session.projectPath === projectPath) {
        await this.tmuxBridge.stopStream(clientId);
        await tmux.killSession(session.sessionName).catch(() => {});
        this.clearQueuedInput(`pty:${clientId}`);
        this.clientSessions.delete(clientId);
      }
    }

    // Kill all card embedded sessions for this project
    for (const [clientId, session] of this.cardClientSessions) {
      if (session.projectPath === projectPath) {
        await this.tmuxBridge.stopStream(clientId);
        await tmux.killSession(session.sessionName).catch(() => {});
        this.clearQueuedInput(`card:${clientId}`);
        this.cardClientSessions.delete(clientId);
      }
    }

    this.agentDiscovery.removeProject(projectPath);
    this.agentDiscovery.clearProjectActivity(projectPath);
    await this.refreshData();
  }

  /**
   * Update the webview content
   */
  private update(): void {
    this.panel.webview.html = this.getHtmlForWebview();
    this.refreshData();
  }

  /**
   * Get the HTML content for the webview
   */
  private getHtmlForWebview(): string {
    const webview = this.panel.webview;

    // Get URIs for webview resources
    const xtermCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'xterm.css')
    );
    const terminalJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'terminal.js')
    );

    // Use a nonce to only allow specific scripts to run
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} data: blob:;">
  <title>Xerebro</title>
  <link rel="stylesheet" href="${xtermCssUri}">
  <style>
    :root {
      --bg-primary: #1e1e1e;
      --bg-secondary: #252526;
      --bg-tertiary: #2d2d2d;
      --bg-card: #2d2d30;
      --border-color: #3c3c3c;
      --text-primary: #cccccc;
      --text-secondary: #969696;
      --text-muted: #6e6e6e;
      --accent-blue: #0078d4;
      --accent-green: #22c55e;
      --accent-orange: #ff6b00;
      --accent-purple: #a855f7;
      --accent-yellow: #eab308;
      --accent-cyan: #0ea5e9;
      --accent-red: #f85149;
      --terminal-bg: #0d1117;
      --scrollbar-bg: #2a2a2a;
      --scrollbar-thumb: #4a4a4a;
      --window-bg: #1e1e1e;
      --window-header: #323233;
      --window-border: #454545;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      padding: 16px;
      min-height: 100vh;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-color);
    }

    .header h1 {
      font-size: 18px;
      font-weight: 600;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .mode-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid #2e6f40;
      background: rgba(34, 197, 94, 0.14);
      color: #7fe7a2;
      letter-spacing: 0.2px;
    }

    .mode-badge.mirror {
      border-color: #9d7b22;
      background: rgba(234, 179, 8, 0.12);
      color: #f3d26b;
    }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    .btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: background-color 0.15s;
    }

    .btn:hover {
      background: var(--bg-secondary);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
    }

    .btn-primary:hover {
      background: #006cbd;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }

    /* Project Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
      position: relative;
    }

    .card-attention {
      position: absolute;
      top: 12px;
      right: 34px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-red);
      opacity: 0;
      transition: opacity 0.15s;
    }

    .card.attention .card-attention {
      opacity: 1;
    }

    .card.highlight-card {
      border-color: var(--accent-blue);
      box-shadow: 0 0 10px var(--accent-blue);
    }

    .card:hover {
      border-color: var(--accent-blue);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      transform: translateY(-2px);
    }

    /* Drag and drop styles */
    .card.dragging {
      opacity: 0.5;
      cursor: move;
      transform: scale(0.95);
    }

    .card.drag-over {
      border-color: var(--accent-green) !important;
      box-shadow: 0 0 0 2px var(--accent-green);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
    }

    .card-title {
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }

    .card-actions {
      display: flex;
      gap: 4px;
      margin-left: 8px;
    }

    .card-btn {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      transition: all 0.15s;
    }

    .card-btn:hover {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    .card-btn.close:hover {
      background: var(--accent-red);
      color: white;
    }

    .card-body {
      cursor: pointer;
    }

    .agent-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 8px 12px;
      background: var(--bg-secondary);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
      flex-shrink: 0;
    }

    .status-dot.active {
      animation: pulse 2s infinite;
    }

    .status-dot.status-running { background: var(--accent-green); }
    .status-dot.status-waiting { background: var(--accent-orange); }
    .status-dot.status-idle { background: var(--text-muted); }
    .status-dot.status-processing { background: var(--accent-blue); animation: pulse 1.5s infinite; }
    .status-dot.status-waiting_input { background: var(--accent-orange); animation: pulse 1s infinite; }
    .status-dot.status-completed { background: var(--accent-green); }
    .status-dot.status-error { background: #ff5555; }
    .status-dot.status-context_warning { background: #ffaa00; animation: pulse 2s infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.1); }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .terminal-count {
      margin-left: auto;
      font-size: 10px;
      color: var(--text-muted);
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: 10px;
    }

    .terminal-preview {
      height: 148px;
      background: var(--terminal-bg);
      padding: 5px 9px 7px;
      margin: 8px 12px 12px;
      font-family: 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
      font-size: 6px;
      line-height: 1.15;
      letter-spacing: 0.2px;
      overflow: hidden;
      color: var(--text-secondary);
      white-space: pre;
      word-break: normal;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }

    .add-card {
      background: var(--bg-secondary);
      border: 2px dashed var(--border-color);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 30px 20px;
      cursor: pointer;
      transition: border-color 0.2s, background-color 0.2s;
      min-height: 180px;
    }

    .add-card:hover {
      border-color: var(--accent-blue);
      background: var(--bg-tertiary);
    }

    .add-card.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .add-card-icon {
      font-size: 28px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .add-card-text {
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* Embedded terminal mode for cards */
    .card[data-terminal-mode="embedded"] {
      min-height: 360px;
      grid-row: span 2;
    }

    .card.mcp-focus[data-terminal-mode="embedded"] {
      grid-column: 1 / -1;
      min-height: clamp(440px, 72vh, 860px);
      grid-row: span 3;
    }

    .card-terminal-container {
      height: 260px;
      display: none;
      flex-direction: column;
      background: var(--terminal-bg);
      margin: 0 12px 12px;
      border-radius: 4px;
      overflow: hidden;
    }

    .card[data-terminal-mode="embedded"] .card-terminal-container {
      display: flex;
    }

    .card.mcp-focus[data-terminal-mode="embedded"] .card-terminal-container {
      height: min(64vh, 720px);
    }

    .card[data-terminal-mode="embedded"] .terminal-preview {
      display: none;
    }

    .card-terminal-tabs {
      display: flex;
      background: #1a1a1a;
      border-bottom: 1px solid #333;
      min-height: 28px;
      overflow-x: auto;
    }

    .card-terminal-tab {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      font-size: 10px;
      color: var(--text-secondary);
      cursor: pointer;
      border-right: 1px solid #333;
      white-space: nowrap;
      transition: all 0.15s;
    }

    .card-terminal-tab:hover {
      background: #252525;
      color: var(--text-primary);
    }

    .card-terminal-tab.active {
      background: var(--terminal-bg);
      color: var(--text-primary);
    }

    .card-terminal-tab .close-tab {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      opacity: 0;
      transition: all 0.15s;
    }

    .card-terminal-tab:hover .close-tab,
    .card-terminal-tab.active .close-tab {
      opacity: 1;
    }

    .card-terminal-tab .close-tab:hover {
      background: var(--accent-red);
      color: white;
    }

    .card-terminal-tab.new-tab {
      color: var(--text-muted);
      padding: 4px 8px;
    }

    .card-terminal-tab.new-tab:hover {
      color: var(--accent-green);
    }

    .card-xterm-wrapper {
      flex: 1;
      padding: 4px;
      overflow: hidden;
    }

    .card-xterm-wrapper .xterm {
      height: 100%;
    }

    .card-btn.expand {
      font-size: 14px;
    }

    .card-btn.expand:hover {
      background: var(--accent-blue);
      color: white;
    }

    .card[data-terminal-mode="embedded"] .card-btn.expand {
      transform: rotate(180deg);
    }

    /* Floating workspace */
    .workspace {
      position: relative;
      min-height: calc(100vh - 84px);
    }

    .window-layer {
      position: absolute;
      inset: 0;
      z-index: 20;
      pointer-events: none;
    }

    .window-dock {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: 16px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      z-index: 30;
      pointer-events: auto;
    }

    .dock-item {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      transition: background-color 0.15s, color 0.15s;
      position: relative;
    }

    .dock-item:hover {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    .dock-attention {
      position: absolute;
      top: 2px;
      right: 4px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent-red);
      opacity: 0;
      transition: opacity 0.15s;
    }

    .dock-item.attention .dock-attention {
      opacity: 1;
    }

    /* Floating window */
    .window {
      background: var(--window-bg);
      border-radius: 8px;
      width: 620px;
      max-width: calc(100% - 24px);
      height: 420px;
      max-height: calc(100% - 24px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--window-border);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255,255,255,0.05);
      position: absolute;
      pointer-events: auto;
      resize: both;
      min-width: 360px;
      min-height: 240px;
    }

    .window.minimized {
      display: none;
    }

    .window.maximized {
      left: 8px !important;
      top: 8px !important;
      width: calc(100% - 16px) !important;
      height: calc(100% - 16px) !important;
    }

    /* macOS-style window header */
    .window-header {
      display: flex;
      align-items: center;
      padding: 0 12px;
      height: 38px;
      background: var(--window-header);
      border-bottom: 1px solid var(--border-color);
      user-select: none;
      cursor: grab;
      justify-content: space-between;
      gap: 8px;
    }

    .window.dragging .window-header {
      cursor: grabbing;
    }

    .window-title {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .window-title-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }

    .window-attention {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent-red);
      opacity: 0;
      transition: opacity 0.15s;
      flex-shrink: 0;
    }

    .window.attention .window-attention {
      opacity: 1;
    }

    .window-close {
      width: 22px;
      height: 22px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      transition: all 0.15s;
    }

    .window-close:hover {
      background: var(--accent-red);
      color: white;
    }

    /* Terminal session tabs */
    .terminal-tabs {
      display: flex;
      background: #1a1a1a;
      border-bottom: 1px solid #333;
      overflow-x: auto;
      min-height: 32px;
    }

    .terminal-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 11px;
      color: var(--text-secondary);
      cursor: pointer;
      border-right: 1px solid #333;
      white-space: nowrap;
      transition: all 0.15s;
    }

    .terminal-tab:hover {
      background: #252525;
      color: var(--text-primary);
    }

    .terminal-tab.active {
      background: var(--terminal-bg);
      color: var(--text-primary);
    }

    .terminal-tab .close-tab {
      width: 14px;
      height: 14px;
      border-radius: 3px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      opacity: 0;
      transition: all 0.15s;
    }

    .terminal-tab:hover .close-tab,
    .terminal-tab.active .close-tab {
      opacity: 1;
    }

    .terminal-tab .close-tab:hover {
      background: var(--accent-red);
      color: white;
    }

    .terminal-tab.new-tab {
      color: var(--text-muted);
      padding: 6px 10px;
    }

    .terminal-tab.new-tab:hover {
      color: var(--accent-green);
    }

    .terminal-tab .agent-indicator {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    /* Terminal content */
    .terminal-area {
      flex: 1;
      background: var(--terminal-bg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .terminal-container {
      flex: 1;
      padding: 4px;
      overflow: hidden;
    }

    .terminal-container .xterm {
      height: 100%;
    }

    .terminal-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      font-size: 13px;
    }

    /* Status bar */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: #161b22;
      border-top: 1px solid #30363d;
      font-size: 10px;
      color: var(--text-muted);
    }

    .status-dot-small {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent-green);
      flex-shrink: 0;
    }

    .status-dot-small.disconnected {
      background: var(--accent-red);
    }

    .status-dot-small.waiting {
      background: var(--accent-yellow);
    }

    .status-dot-small.waiting_input {
      background: var(--accent-yellow);
      animation: pulse 1s infinite;
    }

    .status-dot-small.idle {
      background: var(--text-muted);
    }

    .status-dot-small.running {
      background: var(--accent-green);
    }

    .status-dot-small.processing {
      background: var(--accent-blue);
      animation: pulse 1.5s infinite;
    }

    .status-dot-small.completed {
      background: var(--accent-green);
    }

    .status-dot-small.error {
      background: var(--accent-red);
    }

    .status-dot-small.context_warning {
      background: #ffaa00;
      animation: pulse 2s infinite;
    }

    .status-dot-small.disconnected {
      background: var(--accent-red);
    }

    .webview-notifications {
      position: fixed;
      right: 16px;
      bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 45;
      pointer-events: none;
      max-width: 320px;
    }

    .webview-toast {
      background: rgba(22, 27, 34, 0.96);
      border: 1px solid var(--border-color);
      border-left: 4px solid var(--accent-blue);
      border-radius: 6px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
      color: var(--text-primary);
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.3;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.16s ease, transform 0.16s ease;
      pointer-events: auto;
    }

    .webview-toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    .webview-toast.waiting_input {
      border-left-color: var(--accent-yellow);
    }

    .webview-toast.completed {
      border-left-color: var(--accent-green);
    }

    .webview-toast.error {
      border-left-color: var(--accent-red);
    }

    .webview-toast.context_warning {
      border-left-color: #ffaa00;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: var(--scrollbar-bg);
    }

    ::-webkit-scrollbar-thumb {
      background: var(--scrollbar-thumb);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: #5a5a5a;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">
      <h1>Xerebro</h1>
      <span class="mode-badge" id="modeBadge">Primary</span>
    </div>
    <div class="header-actions">
      <button class="btn btn-primary" id="addProjectBtn">+ Add Project</button>
      <button class="btn" id="refreshBtn">Refresh</button>
    </div>
  </div>

  <div class="workspace">
    <div class="grid" id="projectGrid">
      <div class="add-card" id="addCard">
        <div class="add-card-icon">+</div>
        <div class="add-card-text">Add Project</div>
      </div>
    </div>
    <div class="window-layer" id="windowLayer"></div>
  </div>

  <div class="window-dock" id="windowDock"></div>
  <div class="webview-notifications" id="webviewNotifications"></div>

  <script src="${terminalJsUri}" nonce="${nonce}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const { Terminal, FitAddon } = XtermBundle;

    let projects = [];

    const projectGrid = document.getElementById('projectGrid');
    const addCard = document.getElementById('addCard');
    const windowLayer = document.getElementById('windowLayer');
    const windowDock = document.getElementById('windowDock');
    const webviewNotifications = document.getElementById('webviewNotifications');
    const addProjectBtn = document.getElementById('addProjectBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const modeBadge = document.getElementById('modeBadge');

    const windows = new Map();
    const projectWindows = new Map();
    const ptyToWindow = new Map();
    const pendingPty = new Map();
    const pendingPtyData = new Map();
    const projectCardByPath = new Map();

    // Embedded card terminal state tracking
    const cardTerminals = new Map(); // projectPath -> CardTerminalState
    const cardPendingPty = new Map(); // clientId -> { projectPath }
    const ptyToCard = new Map(); // ptyId -> projectPath
    const pendingMcpCardOpens = new Map(); // projectPath -> MCP open options

    // Drag and drop state for project cards
    let draggedProjectPath = null;
    let draggedCard = null;
    let dragPlaceholder = null;

    const attentionProjects = new Set();
    const projectLivePreviewAt = new Map();
    const projectLivePreviewText = new Map();
    const projectPreviewLines = new Map();
    const projectNotificationAt = new Map();

    const attentionIdleMs = 1200;
    const attentionCooldownMs = 2000;
    const outputTailLimit = 500;
    const connectTimeoutMs = 12000;
    const maxConnectAttempts = 3;
    const previewLineCount = 20;
    const previewCaptureMultiplier = 3;
    const previewCaptureMax = 200;
    const livePreviewHoldMs = 1500;
    const previewThrottleMs = 500; // Increased from 120ms to reduce flickering
    const previewUpdateDebounceMs = 800; // Wait for terminal to be idle before updating preview
    const activitySignalThrottleMs = 220;
    const cardActivitySignalThrottleMs = 280;
    const terminalWriteChunkSize = 8192;
    const terminalWriteYieldMs = 0;
    const notificationThrottleMs = 3000;
    const previewFontSizing = {
      min: 5,
      max: 8,
      base: 6,
      charWidth: 0,
      fontFamily: '',
      fontSize: 6
    };

    let audioContext = null;
    let mirrorMode = false;
    let mirrorHostLabel = '';
    let lastMirrorNoticeAt = 0;

    let windowCounter = 0;
    let clientCounter = 0;
    let zCounter = 25;
    let cascadeOffset = 0;
    let activeWindowId = null;

    const dragState = {
      windowId: null,
      startX: 0,
      startY: 0,
      startLeft: 0,
      startTop: 0
    };

    function applyDashboardMode() {
      if (modeBadge) {
        if (mirrorMode) {
          modeBadge.classList.add('mirror');
          modeBadge.textContent = mirrorHostLabel ? ('Mirror: ' + mirrorHostLabel) : 'Mirror';
          modeBadge.title = mirrorHostLabel
            ? ('Read-only mirror of host window (' + mirrorHostLabel + ')')
            : 'Read-only mirror of host window';
        } else {
          modeBadge.classList.remove('mirror');
          modeBadge.textContent = 'Primary';
          modeBadge.title = 'Primary dashboard window';
        }
      }

      if (addProjectBtn) {
        addProjectBtn.disabled = mirrorMode;
        addProjectBtn.title = mirrorMode
          ? 'Read-only mirror mode. Add projects in the host dashboard window.'
          : 'Add project';
      }

      if (addCard) {
        addCard.classList.toggle('disabled', mirrorMode);
        addCard.title = mirrorMode
          ? 'Read-only mirror mode. Add projects in the host dashboard window.'
          : 'Add Project';
      }
    }

    function showMirrorModeNotice() {
      if (!mirrorMode) return;
      const now = Date.now();
      if (now - lastMirrorNoticeAt < 2200) return;
      lastMirrorNoticeAt = now;

      if (!webviewNotifications) return;
      const toast = document.createElement('div');
      toast.className = 'webview-toast waiting_input';
      const hostSuffix = mirrorHostLabel ? (' (' + mirrorHostLabel + ')') : '';
      toast.textContent = 'Read-only mirror mode. Control from host dashboard' + hostSuffix;
      webviewNotifications.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('show'));
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 180);
      }, 2600);
    }

    let lastAddProjectAt = 0;
    function requestAddProject() {
      if (mirrorMode) {
        showMirrorModeNotice();
        return;
      }
      const now = Date.now();
      if (now - lastAddProjectAt < 250) {
        return;
      }
      lastAddProjectAt = now;
      vscode.postMessage({ command: 'addProject' });
    }

    // Event Listeners
    if (addProjectBtn) {
      addProjectBtn.addEventListener('click', requestAddProject);
      addProjectBtn.addEventListener('pointerup', (event) => {
        if (event.button !== 0) return;
        requestAddProject();
      });
    }

    if (addCard) {
      addCard.addEventListener('click', requestAddProject);
      addCard.addEventListener('pointerup', (event) => {
        if (event.button !== 0) return;
        requestAddProject();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
      });
    }

    applyDashboardMode();

    document.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.window')) return;
      if (target.closest('.window-dock')) return;
      if (!activeWindowId) return;
      minimizeWindow(activeWindowId);
    });

    const swallowDrag = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    ['dragenter', 'dragover', 'dragleave'].forEach((type) => {
      document.addEventListener(type, swallowDrag, true);
      window.addEventListener(type, swallowDrag, true);
    });
    document.addEventListener('drop', (event) => {
      handleFileDrop(event);
    }, true);
    window.addEventListener('drop', (event) => {
      handleFileDrop(event);
    }, true);

    document.addEventListener('pointerdown', () => {
      initAudio();
    }, { once: true });

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'projectsUpdate':
          if (typeof message.mirrorMode === 'boolean') {
            mirrorMode = message.mirrorMode;
          }
          if (typeof message.hostLabel === 'string') {
            mirrorHostLabel = message.hostLabel;
          }
          applyDashboardMode();
          projects = message.projects || [];
          renderProjects();
          reconcileWindows();
          break;

        case 'dashboard:mode':
          if (typeof message.mirrorMode === 'boolean') {
            mirrorMode = message.mirrorMode;
          }
          if (typeof message.hostLabel === 'string') {
            mirrorHostLabel = message.hostLabel;
          }
          applyDashboardMode();
          break;

        case 'terminalOutput':
          updateProjectPreview(message.terminalId, message.output);
          break;

        case 'pty:created':
          handlePtyCreated(message);
          break;

        case 'pty:data':
          handlePtyData(message);
          break;

        case 'pty:exit':
          handlePtyExit(message);
          break;

        case 'pty:error':
          handlePtyError(message);
          break;

        // Card embedded terminal messages
        case 'card:pty:created':
          handleCardPtyCreated(message);
          break;

        case 'card:pty:data':
          handleCardPtyData(message);
          break;

        case 'card:pty:exit':
          handleCardPtyExit(message);
          break;

        case 'card:pty:error':
          handleCardPtyError(message);
          break;

        case 'mcp:createEmbeddedTerminal':
          expandCardTerminalByMcp(message.projectPath, message.name);
          break;

        case 'mcp:openCardTerminal':
          handleMcpOpenCardTerminal(message.projectPath, {
            terminalName: message.terminalName,
            terminalId: message.terminalId,
            createNewTerminal: message.createNewTerminal,
          });
          break;

        case 'mcp:scrollToCard':
          scrollToCard(message.projectPath);
          break;

        case 'projectsOrderUpdate':
          // Project order was updated, re-render projects
          projects = message.projects || [];
          renderProjects();
          break;
      }
    });

    // Handle window resize
    window.addEventListener('resize', () => {
      windows.forEach((windowState) => {
        if (!windowState.minimized) {
          fitWindowTerminal(windowState);
        }
      });
      refreshPreviewFonts();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragState.windowId) return;
      const windowState = windows.get(dragState.windowId);
      if (!windowState || windowState.minimized) return;

      const layerRect = getLayerRect();
      const width = windowState.element.offsetWidth;
      const height = windowState.element.offsetHeight;

      let left = dragState.startLeft + (e.clientX - dragState.startX);
      let top = dragState.startTop + (e.clientY - dragState.startY);

      left = clamp(left, 0, layerRect.width - width);
      top = clamp(top, 0, layerRect.height - height);

      windowState.element.style.left = left + 'px';
      windowState.element.style.top = top + 'px';
    });

    window.addEventListener('mouseup', () => {
      if (!dragState.windowId) return;
      const windowState = windows.get(dragState.windowId);
      if (windowState) {
        windowState.element.classList.remove('dragging');
      }
      dragState.windowId = null;
      document.body.style.userSelect = '';
    });

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function getLayerRect() {
      const rect = windowLayer.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width || window.innerWidth,
        height: rect.height || window.innerHeight
      };
    }

    function nextWindowId() {
      windowCounter += 1;
      return 'window-' + windowCounter;
    }

    function nextClientId() {
      clientCounter += 1;
      return 'client-' + clientCounter + '-' + Date.now();
    }

    function handleFileDrop(event) {
      if (!event) return;
      event.preventDefault();
      event.stopPropagation();

      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return;
      }

      const filePaths = extractDroppedFilePaths(dataTransfer);
      if (filePaths.length === 0) {
        return;
      }

      const targetWindow = resolveDropTarget(event);
      if (!targetWindow) {
        return;
      }

      sendDropToWindow(targetWindow, filePaths);
    }

    function extractDroppedFilePaths(dataTransfer) {
      const uniquePaths = new Set();

      if (dataTransfer.files && dataTransfer.files.length > 0) {
        for (const file of Array.from(dataTransfer.files)) {
          const candidate = normalizeDroppedPath(file.path || '');
          if (candidate) {
            uniquePaths.add(candidate);
            continue;
          }

          if (file.name) {
            uniquePaths.add(file.name);
          }
        }
      }

      const uriList = dataTransfer.getData('text/uri-list');
      if (uriList) {
        for (const rawLine of uriList.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) {
            continue;
          }

          const candidate = normalizeDroppedPath(uriToFilePath(line) || line);
          if (candidate) {
            uniquePaths.add(candidate);
          }
        }
      }

      const plainText = dataTransfer.getData('text/plain');
      if (plainText) {
        for (const piece of plainText.split(/\s+/)) {
          const candidate = normalizeDroppedPath(uriToFilePath(piece) || piece);
          if (candidate) {
            uniquePaths.add(candidate);
          }
        }
      }

      return Array.from(uniquePaths);
    }

    function uriToFilePath(uriText) {
      if (!uriText || !/^file:/i.test(uriText)) {
        return '';
      }

      try {
        const parsed = new URL(uriText);
        if (parsed.protocol !== 'file:') {
          return '';
        }

        let pathname = decodeURIComponent(parsed.pathname || '');
        if (/^\\/[A-Za-z]:\\//.test(pathname)) {
          pathname = pathname.slice(1);
        }

        if (parsed.host) {
          return normalizeDroppedPath('//'+ parsed.host + pathname);
        }

        return normalizeDroppedPath(pathname);
      } catch {
        return '';
      }
    }

    function normalizeDroppedPath(value) {
      if (!value) {
        return '';
      }

      let normalized = String(value).trim();
      if (!normalized) {
        return '';
      }

      if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1).trim();
      }

      normalized = normalized.replace(/^file:\\/\\//i, '');
      return normalized;
    }

    function resolveDropTarget(event) {
      const windowEl = event.target.closest('.window');
      if (windowEl && windowEl.dataset.windowId) {
        return windows.get(windowEl.dataset.windowId);
      }

      const cardEl = event.target.closest('.card');
      if (cardEl && cardEl.dataset.projectPath) {
        return ensureWindowForProject(cardEl.dataset.projectPath);
      }

      if (activeWindowId) {
        return windows.get(activeWindowId);
      }

      return null;
    }

    function ensureWindowForProject(projectPath) {
      const project = projects.find((item) => item.path === projectPath);
      if (!project) return null;
      return openWindow(project);
    }

    function formatPathForShell(filePath) {
      if (!filePath) return '';
      const escaped = filePath.replace(/'/g, "'\\''");
      return "'" + escaped + "'";
    }

    function sendDropToWindow(windowState, filePaths) {
      if (!windowState || !filePaths || filePaths.length === 0) return;

      if (!windowState.pendingDrops) {
        windowState.pendingDrops = [];
      }

      if (!windowState.currentPtyId || !windowState.isReady) {
        windowState.pendingDrops.push(...filePaths);
        return;
      }

      const text = filePaths.map(formatPathForShell).filter(Boolean).join(' ');
      if (!text) return;

      vscode.postMessage({
        command: 'pty:write',
        id: windowState.currentPtyId,
        data: text + ' '
      });
    }

    function flushPendingDrops(windowState) {
      if (!windowState || !windowState.pendingDrops || windowState.pendingDrops.length === 0) {
        return;
      }
      const pending = windowState.pendingDrops.splice(0);
      sendDropToWindow(windowState, pending);
    }

    function initAudio() {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (audioContext || !AudioContextCtor) {
        return;
      }
      audioContext = new AudioContextCtor();
    }

    function playBeep() {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        return;
      }

      if (!audioContext) {
        audioContext = new AudioContextCtor();
      }

      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }

      const now = audioContext.currentTime;
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();

      osc.type = 'sine';
      osc.frequency.value = 880;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

      osc.connect(gain);
      gain.connect(audioContext.destination);

      osc.start(now);
      osc.stop(now + 0.26);
    }

    function stripAnsi(text) {
      return text
        .replace(/\\x1b\\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\\x1b\\][^\\x07]*\\x07/g, '');
    }

    // ANSI color mappings for card preview
    const ANSI_COLORS = {
      // Foreground colors
      30: '#484f58', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922',
      34: '#58a6ff', 35: '#bc8cff', 36: '#39c5cf', 37: '#b1bac4',
      90: '#6e7681', 91: '#ffa198', 92: '#56d364', 93: '#e3b341',
      94: '#79c0ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#f0f6fc',
      // Background colors
      40: '#484f58', 41: '#ff7b72', 42: '#3fb950', 43: '#d29922',
      44: '#58a6ff', 45: '#bc8cff', 46: '#39c5cf', 47: '#b1bac4',
      100: '#6e7681', 101: '#ffa198', 102: '#56d364', 103: '#e3b341',
      104: '#79c0ff', 105: '#d2a8ff', 106: '#56d4dd', 107: '#f0f6fc',
    };

    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // ESC character (ASCII 27) for ANSI sequence detection
    const ESC = String.fromCharCode(27);

    function hasAnsiCodes(text) {
      return text && text.indexOf(ESC + '[') !== -1;
    }

    function ansiToHtml(text) {
      if (!text) return '';

      let result = '';
      let currentFgColor = null;
      let currentBgColor = null;
      let currentBold = false;
      let currentDim = false;
      let currentItalic = false;
      let currentUnderline = false;
      let currentText = '';
      let i = 0;

      function flushText() {
        if (!currentText) return;
        const escaped = escapeHtml(currentText);
        let style = '';
        if (currentFgColor) style += 'color:' + currentFgColor + ';';
        if (currentBgColor) style += 'background-color:' + currentBgColor + ';';
        if (currentBold) style += 'font-weight:bold;';
        if (currentDim) style += 'opacity:0.7;';
        if (currentItalic) style += 'font-style:italic;';
        if (currentUnderline) style += 'text-decoration:underline;';

        if (style) {
          result += '<span style="' + style + '">' + escaped + '</span>';
        } else {
          result += escaped;
        }
        currentText = '';
      }

      while (i < text.length) {
        // Check for ESC sequence
        if (text.charCodeAt(i) === 27 && text[i + 1] === '[') {
          // Flush any pending text before changing style
          flushText();
          // Find the end of the ANSI sequence (ends with 'm' for color codes)
          let j = i + 2;
          while (j < text.length && text[j] !== 'm' && j - i < 30) {
            j++;
          }
          if (text[j] === 'm') {
            // Parse the ANSI codes
            const codeStr = text.slice(i + 2, j);
            const codes = codeStr ? codeStr.split(';').map(function(c) { return parseInt(c, 10) || 0; }) : [0];
            for (let k = 0; k < codes.length; k++) {
              const code = codes[k];
              if (code === 0) {
                currentFgColor = null;
                currentBgColor = null;
                currentBold = false;
                currentDim = false;
                currentItalic = false;
                currentUnderline = false;
              }
              else if (code === 1) { currentBold = true; }
              else if (code === 2) { currentDim = true; }
              else if (code === 3) { currentItalic = true; }
              else if (code === 4) { currentUnderline = true; }
              else if (code === 22) { currentBold = false; currentDim = false; }
              else if (code === 23) { currentItalic = false; currentUnderline = false; }
              else if (code >= 30 && code <= 37) { currentFgColor = ANSI_COLORS[code]; }
              else if (code >= 40 && code <= 47) { currentBgColor = ANSI_COLORS[code]; }
              else if (code >= 90 && code <= 97) { currentFgColor = ANSI_COLORS[code]; }
              else if (code >= 100 && code <= 107) { currentBgColor = ANSI_COLORS[code]; }
              else if (code === 39) { currentFgColor = null; }
              else if (code === 49) { currentBgColor = null; }
            }
            i = j + 1;
            continue;
          }
        }

        // Regular character - accumulate
        currentText += text[i];
        i++;
      }

      // Flush remaining text
      flushText();

      return result;
    }

    function sanitizeInput(text) {
      if (!text) return '';
      const stripped = stripAnsi(text);
      return stripped.replace(/[^\\x08\\x09\\x0a\\x0d\\x20-\\x7e\\x7f]/g, '');
    }

    function applyBackspaces(text) {
      const output = [];
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\\x08' || ch === '\\x7f') {
          output.pop();
          continue;
        }
        if (ch === '\\x0d') {
          let j = output.length - 1;
          while (j >= 0 && output[j] !== '\\x0a') {
            j -= 1;
          }
          output.length = j + 1;
          continue;
        }
        output.push(ch);
      }
      return output.join('');
    }

    function updateOutputTail(current, rawChunk) {
      const merged = applyBackspaces(current + rawChunk);
      const cleaned = merged.replace(/[^\\x09\\x0a\\x20-\\x7e]/g, '');
      if (cleaned.length <= outputTailLimit) {
        return cleaned;
      }
      return cleaned.slice(cleaned.length - outputTailLimit);
    }

    // Preserve ANSI codes for colored preview
    function updateOutputTailRaw(current, rawChunk) {
      const merged = current + rawChunk;
      // Keep ANSI sequences but limit total size
      if (merged.length <= outputTailLimit * 2) {
        return merged;
      }
      return merged.slice(merged.length - outputTailLimit * 2);
    }

    function getPreviewTextRaw(outputTailRaw) {
      if (!outputTailRaw) return '';
      const lines = outputTailRaw.replace(/\\r/g, '\\n').split('\\n');
      const sliced = lines.slice(-previewLineCount);
      return sliced.join('\\n');
    }

    function getTerminalSnapshot(term, maxLines) {
      if (!term || !term.buffer || !term.buffer.active) {
        return '';
      }

      const buffer = term.buffer.active;
      const totalLines = buffer.length || 0;
      if (!totalLines) {
        return '';
      }

      const lineCount = Math.max(1, maxLines || previewLineCount);
      const start = Math.max(0, totalLines - lineCount);
      const lines = [];

      for (let i = start; i < totalLines; i += 1) {
        const line = buffer.getLine(i);
        if (line) {
          lines.push(line.translateToString(true));
        } else {
          lines.push('');
        }
      }

      return lines.join('\\n');
    }

    function updatePreviewFromTerminal(windowState) {
      if (!windowState || !windowState.term) return;

      const now = Date.now();
      if (now - windowState.lastPreviewAt < previewThrottleMs) {
        return;
      }

      windowState.lastPreviewAt = now;
      const captureLines = getPreviewCaptureLineCount(windowState.project.path);
      const snapshot = getTerminalSnapshot(windowState.term, captureLines);
      if (snapshot) {
        setLivePreview(windowState.project.path, snapshot);
      }
    }

    function noteInput(windowState, data) {
      if (!windowState) return;

      const clean = sanitizeInput(data || '');
      if (!clean) return;

      windowState.outputTail = updateOutputTail(windowState.outputTail, clean);
      reportActivity(windowState, 'running');
      if (windowState.term) {
        updatePreviewFromTerminal(windowState);
        return;
      }
      const previewText = getPreviewText(windowState.outputTail);
      setLivePreview(windowState.project.path, previewText);
    }

    function outputIndicatesProcessing(text) {
      return [
        /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
        /Thinking\\.\\.\\./i,
        /Processing\\.\\.\\./i,
        /Working on/i,
        /Reading\\s+\\S+/i,
        /Writing\\s+\\S+/i,
        /Searching\\s+\\S*/i,
        /Analyzing/i,
        /Compiling/i,
        /Building/i,
        /Calling\\s+\\w+/i,
        /Using\\s+\\w+\\s+tool/i,
        /Executing/i,
        /━+.*\\d+%/,
      ].some((pattern) => pattern.test(text));
    }

    function outputIndicatesSelectionPrompt(text) {
      const lastFewLines = text.split('\\n').slice(-12).join('\\n');
      return [
        /Select.*:/i,
        /Choose.*:/i,
        /Pick.*:/i,
        /Options:/i,
        /\\[.*\\(Recommended\\)\\]/i,
        /❯\\s*\\[/,
        /^\\s*>\\s*\\[/m,
      ].some((pattern) => pattern.test(lastFewLines));
    }

    function outputIndicatesWaitingInput(text) {
      const lastFewLines = text.split('\\n').slice(-12).join('\\n');
      return [
        /\\?\\s*$/m,
        /\\[Y\\/n\\]|\\[y\\/N\\]/i,
        /\\(y\\/n\\)/i,
        /Enter\\s+(?:your|a|the)\\s+\\w+:/i,
        /Input\\s+\\w*:/i,
        /What would you like/i,
        /How should I/i,
        /Should I\\s+\\w+\\?/i,
        /Do you want\\s+/i,
        /Would you like\\s+/i,
        /Which\\s+\\w+\\s+(?:would|should|do)/i,
        /Please\\s+(?:select|choose|pick|enter)/i,
        /Press.*to continue/i,
        /Confirm/i,
        /Proceed\\?/i,
        /Continue\\?/i,
        /Approve.*\\?/i,
        /Accept.*\\?/i,
        /waiting for (?:input|response)/i,
        /awaiting (?:input|response)/i,
        /ready for (?:input|your)/i,
      ].some((pattern) => pattern.test(lastFewLines));
    }

    function outputIndicatesCompleted(text) {
      const lastFewLines = text.split('\\n').slice(-12).join('\\n');
      return [
        /✓\\s+(?:Task|Done|Complete|Finished)/i,
        /✔/,
        /Task\\s+completed/i,
        /Successfully\\s+(?:created|updated|fixed|completed)/i,
        /All\\s+\\d+\\s+\\w+\\s+(?:fixed|updated|created|completed)/i,
        /Finished\\s+(?:processing|running|executing)/i,
        /Done[.!]?$/im,
        /Completed[.!]?$/im,
      ].some((pattern) => pattern.test(lastFewLines));
    }

    function outputIndicatesError(text) {
      const lastLines = text.split('\\n').slice(-20);
      const nonEmpty = lastLines
        .map((line) => line.replace(/\\r/g, '').trimEnd())
        .filter((line) => line.trim().length > 0);
      if (nonEmpty.length === 0) {
        return false;
      }

      const errorPatterns = [
        /Error:\\s+\\S+/i,
        /Failed\\s+to\\s+/i,
        /Failed:/i,
        /✗\\s+/,
        /❌/,
        /FATAL/i,
        /Exception:\\s+/i,
        /Traceback/i,
        /panic:/i,
        /Command\\s+failed/i,
      ];

      const tailBlock = nonEmpty.slice(-6).join('\\n');
      if (outputIndicatesBenignStartupWarning(tailBlock)) {
        return false;
      }

      const last = nonEmpty[nonEmpty.length - 1];
      const previous = nonEmpty[nonEmpty.length - 2] || '';

      if (errorPatterns.some((pattern) => pattern.test(last))) {
        return !outputIndicatesBenignStartupWarning(last);
      }

      if (looksLikePrompt(last) && errorPatterns.some((pattern) => pattern.test(previous))) {
        return !outputIndicatesBenignStartupWarning(previous);
      }

      return false;
    }

    function outputIndicatesBenignStartupWarning(text) {
      if (!text) {
        return false;
      }

      return [
        /MCP\\s+client\\s+for\\s+['"]?\\w+['"]?\\s+failed\\s+to\\s+start/i,
        /failed\\s+to\\s+start\\s+MCP\\s+client/i,
        /MCP\\s+server\\s+.*\\s+is\\s+not\\s+configured/i,
      ].some((pattern) => pattern.test(text));
    }

    function outputIndicatesContextWarning(text) {
      const match = text.match(/(\\d+)%\\s*(?:context|used)|(\\d+)k\\/(\\d+)k\\s*tokens?\\s*\\((\\d+)%\\)/i);
      if (!match) return false;
      const percentage = parseInt(match[1] || match[4] || '0', 10);
      return Number.isFinite(percentage) && percentage > 80;
    }

    function getLastNonEmptyLine(text) {
      const lines = (text || '').replace(/\\r/g, '\\n').split('\\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (line) {
          return lines[i];
        }
      }
      return '';
    }

    function classifyActivitySignal(text) {
      const recent = (text || '').slice(-1800);
      if (!recent.trim()) {
        return { activity: 'idle', detail: null };
      }

      if (outputIndicatesContextWarning(recent)) {
        return { activity: 'context_warning', detail: null };
      }

      if (outputIndicatesError(recent)) {
        return { activity: 'error', detail: null };
      }

      if (outputIndicatesWaitingInput(recent)) {
        const detail = outputIndicatesSelectionPrompt(recent) ? 'selection' : 'input';
        return { activity: 'waiting_input', detail };
      }

      if (outputIndicatesCompleted(recent)) {
        return { activity: 'completed', detail: null };
      }

      if (outputIndicatesProcessing(recent)) {
        return { activity: 'processing', detail: null };
      }

      const lastLine = getLastNonEmptyLine(recent);
      if (looksLikePrompt(lastLine)) {
        return { activity: 'idle', detail: null };
      }

      return { activity: 'running', detail: null };
    }

    function looksLikePrompt(line) {
      const trimmed = line.replace(/\\s+$/, '');
      if (!trimmed) return false;
      if (trimmed.length > 80) return false;
      return /[$#%>]\\s*$/.test(trimmed);
    }

    function setWindowStatus(windowState, state, label) {
      if (!windowState || !windowState.statusDot || !windowState.statusText) return;
      windowState.statusDot.classList.remove(
        'disconnected',
        'running',
        'waiting',
        'idle',
        'processing',
        'waiting_input',
        'completed',
        'error',
        'context_warning'
      );
      windowState.statusDot.classList.add(state);
      windowState.statusText.textContent = label;
    }

    function getActivityLabel(activity, detail) {
      if (activity === 'waiting_input') {
        return detail === 'selection' ? 'Selection required' : 'Needs input';
      }
      if (activity === 'processing') return 'Processing...';
      if (activity === 'completed') return 'Completed';
      if (activity === 'error') return 'Error detected';
      if (activity === 'context_warning') return 'Context warning';
      if (activity === 'running') return 'Running';
      if (activity === 'waiting') return 'Waiting for input';
      return 'Idle';
    }

    function isAttentionActivity(activity) {
      return activity === 'waiting_input' || activity === 'error' || activity === 'context_warning';
    }

    function isNotifiableActivity(activity) {
      return isAttentionActivity(activity) || activity === 'completed';
    }

    function shouldThrottleProjectNotification(projectPath, activity) {
      const key = projectPath + ':' + activity;
      const now = Date.now();
      const last = projectNotificationAt.get(key) || 0;
      if (now - last < notificationThrottleMs) {
        return true;
      }
      projectNotificationAt.set(key, now);
      return false;
    }

    function showWebviewNotification(projectName, activity, detail) {
      if (!webviewNotifications) {
        return;
      }

      let message = 'Status updated';
      if (activity === 'waiting_input') {
        message = detail === 'selection' ? 'Selection required' : 'Needs your input';
      } else if (activity === 'completed') {
        message = 'Task completed';
      } else if (activity === 'error') {
        message = 'Error detected';
      } else if (activity === 'context_warning') {
        message = 'Context is getting full';
      } else if (activity === 'processing') {
        message = 'Processing...';
      }

      const toast = document.createElement('div');
      toast.className = 'webview-toast ' + activity;
      toast.textContent = '[' + projectName + '] ' + message;
      webviewNotifications.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.add('show');
      });

      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
          toast.remove();
        }, 180);
      }, 3000);
    }

    function reportActivity(windowState, activity, detail) {
      if (!windowState || !windowState.project) return;
      const normalizedActivity = activity === 'waiting' ? 'waiting_input' : activity;
      const now = Date.now();
      if (windowState.activity === normalizedActivity) {
        return;
      }

      const previousActivity = windowState.activity;
      windowState.activity = normalizedActivity;
      windowState.lastActivitySentAt = now;
      setWindowStatus(windowState, normalizedActivity, getActivityLabel(normalizedActivity, detail));

      vscode.postMessage({
        command: 'projectActivity',
        projectPath: windowState.project.path,
        activity: normalizedActivity
      });

      if (isNotifiableActivity(normalizedActivity) && previousActivity !== normalizedActivity) {
        maybeNotify(windowState, normalizedActivity, detail);
      }
    }

    function setProjectAttention(projectPath, enabled) {
      if (enabled) {
        attentionProjects.add(projectPath);
      } else {
        attentionProjects.delete(projectPath);
      }

      const card = projectCardByPath.get(projectPath);
      if (card) {
        card.classList.toggle('attention', enabled);
      }
    }

    function getProjectNameByPath(projectPath) {
      const project = projects.find((p) => p.path === projectPath);
      if (project && project.name) {
        return project.name;
      }
      if (!projectPath) {
        return 'Project';
      }
      const segments = projectPath.split('/');
      return segments[segments.length - 1] || projectPath;
    }

    function reportCardActivity(cardState, activity, detail) {
      if (!cardState || !cardState.projectPath) {
        return;
      }

      const normalizedActivity = activity === 'waiting' ? 'waiting_input' : activity;
      const now = Date.now();
      if (cardState.activity === normalizedActivity) {
        return;
      }

      const previousActivity = cardState.activity;
      cardState.activity = normalizedActivity;
      cardState.lastActivitySentAt = now;

      if (normalizedActivity === 'running' || normalizedActivity === 'idle' || normalizedActivity === 'processing') {
        setProjectAttention(cardState.projectPath, false);
      } else if (isAttentionActivity(normalizedActivity)) {
        setProjectAttention(cardState.projectPath, true);
      }

      vscode.postMessage({
        command: 'projectActivity',
        projectPath: cardState.projectPath,
        activity: normalizedActivity
      });

      if (isNotifiableActivity(normalizedActivity) && previousActivity !== normalizedActivity) {
        if (shouldThrottleProjectNotification(cardState.projectPath, normalizedActivity)) {
          return;
        }
        showWebviewNotification(getProjectNameByPath(cardState.projectPath), normalizedActivity, detail);
        playBeep();
      }
    }

    function setWindowAttention(windowState) {
      if (!windowState || windowState.needsAttention) return;

      windowState.needsAttention = true;
      windowState.element.classList.add('attention');
      if (windowState.dockItem) {
        windowState.dockItem.classList.add('attention');
      }
      setProjectAttention(windowState.project.path, true);
    }

    function clearWindowAttention(windowState) {
      if (!windowState || !windowState.needsAttention) return;

      windowState.needsAttention = false;
      windowState.element.classList.remove('attention');
      if (windowState.dockItem) {
        windowState.dockItem.classList.remove('attention');
      }
      setProjectAttention(windowState.project.path, false);
    }

    function maybeNotify(windowState, activity, detail) {
      if (!windowState || !windowState.project || !isNotifiableActivity(activity)) return;

      const attentionNeeded = isAttentionActivity(activity);
      if (!windowState.minimized && windowState.id === activeWindowId) {
        return;
      }

      const now = Date.now();
      if (now - windowState.lastAttentionAt < attentionCooldownMs) {
        return;
      }
      if (shouldThrottleProjectNotification(windowState.project.path, activity)) {
        return;
      }

      windowState.lastAttentionAt = now;
      if (attentionNeeded) {
        setWindowAttention(windowState);
      }

      showWebviewNotification(windowState.project.name, activity, detail);
      playBeep();
    }

    function scheduleIdleAttention(windowState) {
      if (!windowState) return;

      if (windowState.idleTimer) {
        clearTimeout(windowState.idleTimer);
      }

      windowState.idleTimer = setTimeout(() => {
        windowState.idleTimer = null;
        if (!windowState.outputTail) {
          return;
        }

        const signal = classifyActivitySignal(windowState.outputTail);
        if (signal.activity === 'idle') {
          reportActivity(windowState, 'idle', signal.detail);
        }
      }, attentionIdleMs);
    }

    function schedulePreviewUpdate(windowState) {
      if (!windowState || !windowState.term) return;

      // Clear existing timer
      if (windowState.previewUpdateTimer) {
        clearTimeout(windowState.previewUpdateTimer);
      }

      // Schedule new preview update after debounce delay
      windowState.previewUpdateTimer = setTimeout(() => {
        windowState.previewUpdateTimer = null;

        // Read directly from xterm.js buffer - no ANSI parsing needed!
        const captureLines = getPreviewCaptureLineCount(windowState.project.path);
        const snapshot = getTerminalSnapshot(windowState.term, captureLines);
        if (snapshot) {
          setLivePreview(windowState.project.path, snapshot);
        }
      }, previewUpdateDebounceMs);
    }

    function noteOutput(windowState, data) {
      if (!windowState) return;

      const now = Date.now();
      windowState.lastOutputAt = now;
      const rawData = data || '';
      const strippedText = stripAnsi(rawData);
      const session = getActiveSession(windowState);
      if (strippedText) {
        windowState.outputTail = updateOutputTail(windowState.outputTail, strippedText);
        // Store raw output with ANSI codes for colored preview
        if (!windowState.outputTailRaw) windowState.outputTailRaw = '';
        windowState.outputTailRaw = updateOutputTailRaw(windowState.outputTailRaw, rawData);
        if (session) {
          session.outputTail = windowState.outputTail;
          session.outputTailRaw = windowState.outputTailRaw;
          session.lastOutputAt = windowState.lastOutputAt;
        }

        // Use debounced preview update to reduce flickering
        schedulePreviewUpdate(windowState);

        const shouldAnalyzeActivity =
          !windowState.lastActivityCheckAt ||
          now - windowState.lastActivityCheckAt >= activitySignalThrottleMs ||
          /[\r\n]/.test(rawData);

        if (shouldAnalyzeActivity) {
          windowState.lastActivityCheckAt = now;
          const signal = classifyActivitySignal(windowState.outputTail);
          reportActivity(windowState, signal.activity, signal.detail);
        }
      }

      scheduleIdleAttention(windowState);
    }

    function getPreviewText(outputTail) {
      if (!outputTail) return '';
      const lines = outputTail.replace(/\\r/g, '\\n').split('\\n');
      const sliced = lines.slice(-previewLineCount);
      return sliced.join('\\n');
    }

    function measurePreviewCharWidth(preview) {
      if (!preview) return previewFontSizing.charWidth || 0;
      const styles = getComputedStyle(preview);
      const fontFamily = styles.fontFamily || 'monospace';
      const fontSize = parseFloat(styles.fontSize) || previewFontSizing.base;

      if (
        previewFontSizing.charWidth &&
        previewFontSizing.fontFamily === fontFamily &&
        previewFontSizing.fontSize === fontSize
      ) {
        return previewFontSizing.charWidth;
      }

      const probe = document.createElement('span');
      probe.textContent = 'MMMMMMMMMM';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.style.fontFamily = fontFamily;
      probe.style.fontSize = fontSize + 'px';
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width / 10;
      probe.remove();

      previewFontSizing.charWidth = width || previewFontSizing.charWidth || 6;
      previewFontSizing.fontFamily = fontFamily;
      previewFontSizing.fontSize = fontSize;
      return previewFontSizing.charWidth;
    }

    function fitPreviewText(preview, text) {
      if (!preview) return;
      const content = text || preview.textContent || '';
      if (!content) {
        preview.style.fontSize = '';
        return;
      }

      const lines = content.split('\\n');
      const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
      if (!longestLine) {
        preview.style.fontSize = '';
        return;
      }

      const styles = getComputedStyle(preview);
      const paddingLeft = parseFloat(styles.paddingLeft) || 0;
      const paddingRight = parseFloat(styles.paddingRight) || 0;
      const availableWidth = preview.clientWidth - paddingLeft - paddingRight;

      if (availableWidth <= 0) {
        return;
      }

      const charWidth = measurePreviewCharWidth(preview);
      if (!charWidth) {
        return;
      }

      const baseFont = previewFontSizing.fontSize || previewFontSizing.base;
      const targetFont = Math.floor((availableWidth * baseFont) / (longestLine * charWidth));
      const clamped = Math.max(previewFontSizing.min, Math.min(previewFontSizing.max, targetFont));
      preview.style.fontSize = clamped + 'px';
    }

    function updatePreviewLineCount(projectPath, preview) {
      if (!projectPath || !preview) return previewLineCount;
      const styles = getComputedStyle(preview);
      const paddingTop = parseFloat(styles.paddingTop) || 0;
      const paddingBottom = parseFloat(styles.paddingBottom) || 0;
      let lineHeight = parseFloat(styles.lineHeight);
      if (!lineHeight || Number.isNaN(lineHeight)) {
        const fontSize = parseFloat(styles.fontSize) || previewFontSizing.base;
        lineHeight = fontSize * 1.15;
      }
      const availableHeight = preview.clientHeight - paddingTop - paddingBottom;
      const lines = Math.max(1, Math.floor(availableHeight / lineHeight));
      projectPreviewLines.set(projectPath, lines);
      return lines;
    }

    function getPreviewLineCount(projectPath) {
      const cached = projectPreviewLines.get(projectPath);
      if (cached) {
        return cached;
      }
      const card = projectCardByPath.get(projectPath) ||
        projectGrid.querySelector('.card[data-project-path="' + CSS.escape(projectPath) + '"]');
      if (!card) {
        return previewLineCount;
      }
      const preview = card.querySelector('.terminal-preview');
      if (!preview) {
        return previewLineCount;
      }
      return updatePreviewLineCount(projectPath, preview);
    }

    function getPreviewCaptureLineCount(projectPath) {
      const visibleLines = getPreviewLineCount(projectPath);
      const target = Math.max(previewLineCount, visibleLines * previewCaptureMultiplier);
      return Math.min(previewCaptureMax, target);
    }

    function setLivePreview(projectPath, output) {
      projectLivePreviewAt.set(projectPath, Date.now());
      projectLivePreviewText.set(projectPath, output || '');
      updateProjectPreviewByPath(projectPath, output);
    }

    function shouldIgnoreExternalPreview(projectPath) {
      const lastLive = projectLivePreviewAt.get(projectPath);
      if (!lastLive) return false;
      return Date.now() - lastLive < livePreviewHoldMs;
    }

    function updateProjectPreviewByPath(projectPath, output) {
      const card = projectCardByPath.get(projectPath) ||
        projectGrid.querySelector('.card[data-project-path="' + CSS.escape(projectPath) + '"]');
      if (!card) return;
      if (!projectCardByPath.has(projectPath)) {
        projectCardByPath.set(projectPath, card);
      }
      const preview = card.querySelector('.terminal-preview');
      if (preview) {
        const nextText = output || '$ _';
        if (hasAnsiCodes(nextText)) {
          preview.innerHTML = ansiToHtml(nextText);
        } else {
          preview.textContent = nextText;
        }
        fitPreviewText(preview, stripAnsi(nextText));
        updatePreviewLineCount(projectPath, preview);
      }
    }

    function refreshPreviewFonts() {
      const previews = projectGrid.querySelectorAll('.terminal-preview');
      previews.forEach((preview) => {
        fitPreviewText(preview);
        const card = preview.closest('.card');
        if (card && card.dataset.projectPath) {
          updatePreviewLineCount(card.dataset.projectPath, preview);
        }
      });
    }

    function clearConnectTimer(windowState) {
      if (windowState.connectTimer) {
        clearTimeout(windowState.connectTimer);
        windowState.connectTimer = null;
      }
    }

    function startConnectTimer(windowState, cwd) {
      clearConnectTimer(windowState);
      windowState.connectTimer = setTimeout(() => {
      if (windowState.isReady) return;
      if (windowState.connectAttempts >= maxConnectAttempts) {
        setWindowStatus(windowState, 'disconnected', 'Connection timed out');
        return;
      }
      windowState.connectAttempts += 1;
      setWindowStatus(windowState, 'disconnected', 'Retrying...');
      requestPtyConnect(windowState, cwd);
    }, connectTimeoutMs);
    }

    function requestPtyConnect(windowState, cwd) {
      const session = windowState.sessions[windowState.activeSessionIndex];
      if (!session) return;

      if (session.clientId) {
        pendingPty.delete(session.clientId);
        session.clientId = null;
      }

      const clientId = nextClientId();
      session.clientId = clientId;
      pendingPty.set(clientId, { windowId: windowState.id, sessionId: session.id });

      vscode.postMessage({
        command: 'pty:create',
        cwd: cwd,
        cols: windowState.term ? windowState.term.cols : 80,
        rows: windowState.term ? windowState.term.rows : 24,
        clientId: clientId,
        terminalId: session.terminalId || null,
        terminalName: session.name || null
      });

      startConnectTimer(windowState, cwd);
    }

    function attemptReconnect(windowState, errorText) {
      if (!windowState || windowState.isReady) return;

      clearConnectTimer(windowState);

      if (windowState.connectAttempts >= maxConnectAttempts) {
        setWindowStatus(windowState, 'disconnected', errorText);
        return;
      }

      windowState.connectAttempts += 1;
      setWindowStatus(windowState, 'disconnected', 'Retrying...');
      requestPtyConnect(windowState, windowState.project.path);
    }

    function renderProjects() {
      const existingCards = projectGrid.querySelectorAll('.card');
      existingCards.forEach(card => card.remove());
      projectCardByPath.clear();
      const activePaths = new Set(projects.map(project => project.path));
      Array.from(projectLivePreviewText.keys()).forEach((path) => {
        if (!activePaths.has(path)) {
          projectLivePreviewText.delete(path);
          projectLivePreviewAt.delete(path);
        }
      });
      Array.from(cardTerminals.keys()).forEach((path) => {
        if (!activePaths.has(path)) {
          const stale = cardTerminals.get(path);
          if (stale) {
            disposeCardTerminalRuntime(stale);
          }
          cardTerminals.delete(path);
        }
      });
      Array.from(pendingMcpCardOpens.keys()).forEach((path) => {
        if (!activePaths.has(path)) {
          pendingMcpCardOpens.delete(path);
        }
      });

      projects.forEach(project => {
        const card = createProjectCard(project);
        projectCardByPath.set(project.path, card);
        // Auto-set attention for states that need user action
        const needsAttention = project.activity === 'waiting_input' ||
                               project.activity === 'error' ||
                               project.activity === 'context_warning';
        if (needsAttention) {
          attentionProjects.add(project.path);
        }
        if (attentionProjects.has(project.path)) {
          card.classList.add('attention');
        }
        projectGrid.insertBefore(card, addCard);
        const preview = card.querySelector('.terminal-preview');
        if (preview) {
          fitPreviewText(preview);
        }
      });

      restoreExpandedCardTerminals();
      processPendingMcpCardOpens();
    }

    function reconcileWindows() {
      const activePaths = new Set(projects.map(project => project.path));
      Array.from(projectWindows.entries()).forEach(([projectPath, windowId]) => {
        if (!activePaths.has(projectPath)) {
          closeWindow(windowId);
          return;
        }
        const project = projects.find(p => p.path === projectPath);
        const windowState = windows.get(windowId);
        if (project && windowState) {
          windowState.project = project;
          windowState.titleEl.textContent = project.name;
        }
      });
    }

    // Drag and drop handlers for project cards
    function handleDragStart(e, projectPath) {
      if (mirrorMode) {
        e.preventDefault();
        showMirrorModeNotice();
        return;
      }
      draggedProjectPath = projectPath;
      draggedCard = e.currentTarget;
      e.currentTarget.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', projectPath);

      // Create a placeholder
      dragPlaceholder = document.createElement('div');
      dragPlaceholder.className = 'card drag-placeholder';
      dragPlaceholder.style.height = e.currentTarget.offsetHeight + 'px';
      dragPlaceholder.style.border = '2px dashed var(--accent-blue)';
      dragPlaceholder.style.borderRadius = '8px';
      dragPlaceholder.style.background = 'transparent';
    }

    function handleDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      draggedProjectPath = null;
      draggedCard = null;

      // Remove placeholder
      if (dragPlaceholder && dragPlaceholder.parentNode) {
        dragPlaceholder.parentNode.removeChild(dragPlaceholder);
      }
      dragPlaceholder = null;

      // Remove all drag-over classes
      document.querySelectorAll('.drag-over, .drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
      });
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const card = e.currentTarget;
      if (card === draggedCard) return;

      // Remove previous indicators
      document.querySelectorAll('.drag-over').forEach(el => {
        if (el !== card) el.classList.remove('drag-over');
      });

      // Add visual feedback
      card.classList.add('drag-over');

      // Insert placeholder to show where card will be dropped
      const rect = card.getBoundingClientRect();
      const midPoint = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midPoint;

      if (insertBefore) {
        card.parentNode.insertBefore(dragPlaceholder, card);
      } else {
        if (card.nextSibling) {
          card.parentNode.insertBefore(dragPlaceholder, card.nextSibling);
        } else {
          card.parentNode.appendChild(dragPlaceholder);
        }
      }
    }

    function handleDragLeave(e) {
      // Only remove if we're actually leaving the card (not just entering a child)
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX >= rect.right ||
          e.clientY < rect.top || e.clientY >= rect.bottom) {
        e.currentTarget.classList.remove('drag-over');
      }
    }

    function handleDrop(e, targetProjectPath) {
      e.preventDefault();
      e.stopPropagation();

      const card = e.currentTarget;
      card.classList.remove('drag-over');

      if (!draggedProjectPath || draggedProjectPath === targetProjectPath) {
        // Cleanup placeholder
        if (dragPlaceholder && dragPlaceholder.parentNode) {
          dragPlaceholder.parentNode.removeChild(dragPlaceholder);
        }
        dragPlaceholder = null;
        return;
      }

      // Build new order based on placeholder position
      const allCards = Array.from(projectGrid.querySelectorAll('.card:not(.drag-placeholder)'));
      const currentOrder = allCards.map(c => c.dataset.projectPath);

      // Insert dragged card at placeholder position
      const placeholderIndex = Array.from(projectGrid.children).indexOf(dragPlaceholder);
      const fromIndex = currentOrder.indexOf(draggedProjectPath);

      if (fromIndex === -1) {
        // Cleanup placeholder
        if (dragPlaceholder && dragPlaceholder.parentNode) {
          dragPlaceholder.parentNode.removeChild(dragPlaceholder);
        }
        dragPlaceholder = null;
        return;
      }

      // Remove from old position
      currentOrder.splice(fromIndex, 1);

      // Calculate new index (accounting for the removal)
      const newIndex = placeholderIndex > fromIndex ? placeholderIndex - 1 : placeholderIndex;
      currentOrder.splice(newIndex, 0, draggedProjectPath);

      // Send new order to extension
      console.log('[Dashboard] Sending new project order:', currentOrder);
      vscode.postMessage({ command: 'reorderProjects', order: currentOrder });

      // Cleanup placeholder will happen in handleDragEnd
    }

    function createProjectCard(project) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.projectPath = project.path;
      card.draggable = !mirrorMode;
      const cardState = cardTerminals.get(project.path);

      // Add drag event listeners
      card.addEventListener('dragstart', (e) => handleDragStart(e, project.path));
      card.addEventListener('dragend', handleDragEnd);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('dragleave', handleDragLeave);
      card.addEventListener('drop', (e) => handleDrop(e, project.path));

      // Make entire card clickable to open window (except for interactive elements)
      card.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        // Don't open if clicking on buttons or during drag
        if (target.tagName === 'BUTTON' || target.closest('button')) {
          return;
        }
        // Keep terminal interactions in-place. Clicking inside embedded/card terminals should
        // never trigger "open window" because that steals focus from xterm input.
        if (
          target.closest('.card-terminal-container') ||
          target.closest('.card-terminal-tabs') ||
          target.closest('.card-xterm-wrapper') ||
          target.closest('.xterm')
        ) {
          return;
        }
        // When a card is already expanded in embedded mode, don't auto-open floating windows.
        if (card.dataset.terminalMode === 'embedded') {
          return;
        }
        if (mirrorMode) {
          showMirrorModeNotice();
          return;
        }
        openWindow(project);
      });

      const attentionDot = document.createElement('span');
      attentionDot.className = 'card-attention';
      card.appendChild(attentionDot);

      const activeAgent = project.agents.find(a => a.isActive);
      const hasTerminals = project.terminals && project.terminals.length > 0;
      const activeTerminal = hasTerminals && project.terminals.find(t => t.isActive);
      const isRunning = Boolean(activeAgent || activeTerminal || hasTerminals);
      let activity = project.activity;
      if (!activity) {
        activity = isRunning ? 'running' : 'idle';
      }
      // Map activity to user-friendly labels
      const activityLabels = {
        'idle': 'Ready',
        'running': 'Active',
        'waiting': 'Waiting',
        'processing': 'Thinking...',
        'waiting_input': 'Needs Input',
        'completed': 'Completed',
        'error': 'Error',
        'context_warning': 'Low Context'
      };
      const activityLabel = activityLabels[activity] || 'Ready';
      const badgeLabel = activeAgent ? (activeAgent.name + ' - ' + activityLabel) : activityLabel;
      const isActive = activity === 'running' || activity === 'processing';
      const needsAttention = activity === 'waiting_input' || activity === 'error' || activity === 'context_warning';
      let terminalCount = project.terminals ? project.terminals.length : 0;
      if (cardState && Array.isArray(cardState.sessions) && cardState.sessions.length > terminalCount) {
        terminalCount = cardState.sessions.length;
      }
      const openWindowId = projectWindows.get(project.path);
      if (openWindowId && windows.has(openWindowId)) {
        const windowState = windows.get(openWindowId);
        if (windowState && windowState.sessions && windowState.sessions.length) {
          terminalCount = windowState.sessions.length;
        }
      }

      // Card header with close button
      const cardHeader = document.createElement('div');
      cardHeader.className = 'card-header';

      const cardTitle = document.createElement('span');
      cardTitle.className = 'card-title';
      cardTitle.textContent = project.name;

      const cardActions = document.createElement('div');
      cardActions.className = 'card-actions';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'card-btn close';
      closeBtn.textContent = 'x';
      closeBtn.title = 'Remove project';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        collapseCardTerminal(project.path);
        closeWindowByProject(project.path);
        vscode.postMessage({ command: 'removeProject', projectPath: project.path });
      });

      cardActions.appendChild(closeBtn);
      cardHeader.appendChild(cardTitle);
      cardHeader.appendChild(cardActions);
      card.appendChild(cardHeader);

      // Card body (clickable area)
      const cardBody = document.createElement('div');
      cardBody.className = 'card-body';

      // Agent status
      const agentStatus = document.createElement('div');
      agentStatus.className = 'agent-status';

      const dot = document.createElement('span');
      dot.className = 'status-dot status-' + activity + (isActive ? ' active' : '');

      const statusLabel = document.createElement('span');
      statusLabel.textContent = badgeLabel;

      const termCount = document.createElement('span');
      termCount.className = 'terminal-count';
      termCount.textContent = terminalCount + ' terminal' + (terminalCount !== 1 ? 's' : '');

      agentStatus.appendChild(dot);
      agentStatus.appendChild(statusLabel);
      agentStatus.appendChild(termCount);
      cardBody.appendChild(agentStatus);

      // Terminal preview
      const preview = document.createElement('div');
      preview.className = 'terminal-preview';
      const firstTerminal = project.terminals && project.terminals[0];
      const activeCardSession = cardState && Array.isArray(cardState.sessions) && cardState.sessions.length > 0
        ? cardState.sessions[Math.min(cardState.activeSessionIndex || 0, cardState.sessions.length - 1)]
        : null;
      const livePreview = projectLivePreviewText.get(project.path);
      const previewText = livePreview || (activeCardSession && activeCardSession.outputTail) || (firstTerminal && firstTerminal.lastOutput) || '$ _';
      if (hasAnsiCodes(previewText)) {
        preview.innerHTML = ansiToHtml(previewText);
      } else {
        preview.textContent = previewText;
      }
      fitPreviewText(preview, stripAnsi(previewText));
      updatePreviewLineCount(project.path, preview);
      cardBody.appendChild(preview);

      // Embedded terminal container (hidden by default)
      const terminalContainer = document.createElement('div');
      terminalContainer.className = 'card-terminal-container';
      terminalContainer.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (mirrorMode) {
          showMirrorModeNotice();
          return;
        }
        const active = cardTerminals.get(project.path);
        if (active && active.term) {
          active.term.focus();
        }
      });
      terminalContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mirrorMode) {
          showMirrorModeNotice();
          return;
        }
        const active = cardTerminals.get(project.path);
        if (active && active.term) {
          active.term.focus();
        }
      });

      const terminalTabs = document.createElement('div');
      terminalTabs.className = 'card-terminal-tabs';

      const xtermWrapper = document.createElement('div');
      xtermWrapper.className = 'card-xterm-wrapper';

      terminalContainer.appendChild(terminalTabs);
      terminalContainer.appendChild(xtermWrapper);
      cardBody.appendChild(terminalContainer);

      card.appendChild(cardBody);

      return card;
    }

    // ==========================================
    // Embedded Card Terminal Functions
    // ==========================================

    function toggleCardTerminal(projectPath) {
      const cardState = cardTerminals.get(projectPath);
      if (cardState && cardState.isExpanded) {
        collapseCardTerminal(projectPath);
      } else {
        expandCardTerminal(projectPath);
      }
    }

    function disposeCardTerminalRuntime(cardState) {
      if (!cardState) return;

      // Detach PTY but keep tmux session alive for reconnection.
      if (cardState.ptyId) {
        vscode.postMessage({ command: 'card:pty:detach', id: cardState.ptyId, projectPath: cardState.projectPath });
        ptyToCard.delete(cardState.ptyId);
        cardState.ptyId = null;
      }

      if (cardState.clientId) {
        cardPendingPty.delete(cardState.clientId);
        cardState.clientId = null;
      }

      // Dispose xterm runtime and keep a preview snapshot.
      if (cardState.term) {
        const snapshot = getTerminalSnapshot(cardState.term, previewLineCount);
        if (snapshot) {
          setLivePreview(cardState.projectPath, snapshot);
        }
        cardState.term.dispose();
        cardState.term = null;
      }

      if (cardState.resizeObserver) {
        cardState.resizeObserver.disconnect();
        cardState.resizeObserver = null;
      }

      cardState.fitAddon = null;
      cardState.isReady = false;
      cardState.restoringSnapshot = false;
      cardState.pendingSnapshotData = '';
    }

    function restoreExpandedCardTerminals() {
      cardTerminals.forEach((cardState, projectPath) => {
        if (!cardState || !cardState.isExpanded) {
          return;
        }

        const card = projectCardByPath.get(projectPath);
        if (!card) {
          return;
        }

        const project = projects.find((p) => p.path === projectPath);
        if (project) {
          cardState.project = project;
        }

        card.dataset.terminalMode = 'embedded';
        disposeCardTerminalRuntime(cardState);
        renderCardTerminalTabs(cardState);
        initializeCardTerminal(cardState);
      });
    }

    function processPendingMcpCardOpens() {
      if (pendingMcpCardOpens.size === 0) {
        return;
      }

      pendingMcpCardOpens.forEach((options, projectPath) => {
        if (!projectCardByPath.has(projectPath)) {
          return;
        }
        pendingMcpCardOpens.delete(projectPath);
        handleMcpOpenCardTerminal(projectPath, options || {});
      });
    }

    function expandCardTerminal(projectPath) {
      console.log('[Dashboard] expandCardTerminal called:', projectPath);
      console.log('[Dashboard] projectCardByPath keys:', Array.from(projectCardByPath.keys()));
      const card = projectCardByPath.get(projectPath);
      if (!card) {
        console.log('[Dashboard] Card not found for path:', projectPath);
        return;
      }
      console.log('[Dashboard] Found card, expanding...');
      console.log('[Dashboard] Card element:', card.tagName, card.className);

      const project = projects.find(p => p.path === projectPath);
      if (!project) {
        console.log('[Dashboard] Project not found in projects array');
        return;
      }
      console.log('[Dashboard] Project found:', project.name);

      // Set card to embedded mode
      card.dataset.terminalMode = 'embedded';
      console.log('[Dashboard] Set terminalMode to embedded, current value:', card.dataset.terminalMode);

      // Force style recalculation
      const computedStyle = window.getComputedStyle(card);
      console.log('[Dashboard] Card min-height after mode change:', computedStyle.minHeight);
      console.log('[Dashboard] Card gridRow after mode change:', computedStyle.gridRow);

      // Create or get card terminal state
      let cardState = cardTerminals.get(projectPath);
      const wasExpanded = !!cardState?.isExpanded;
      if (!cardState) {
        cardState = {
          projectPath: projectPath,
          project: project,
          term: null,
          fitAddon: null,
          ptyId: null,
          clientId: null,
          isExpanded: false,
          isReady: false,
          restoringSnapshot: false,
          pendingSnapshotData: '',
          sessions: [],
          activeSessionIndex: 0,
          outputTail: '',
          lastOutputAt: 0,
          activity: project.activity || 'idle',
          lastActivitySentAt: 0,
          lastActivityCheckAt: 0
        };
        cardTerminals.set(projectPath, cardState);
      }

      cardState.isExpanded = true;
      cardState.project = project;
      if (!cardState.activity) {
        cardState.activity = project.activity || 'idle';
      }
      if (typeof cardState.restoringSnapshot !== 'boolean') {
        cardState.restoringSnapshot = false;
      }
      if (typeof cardState.pendingSnapshotData !== 'string') {
        cardState.pendingSnapshotData = '';
      }
      if (typeof cardState.lastActivityCheckAt !== 'number') {
        cardState.lastActivityCheckAt = 0;
      }

      // Only initialize from project data when we do not already have local card sessions.
      // Re-initializing on every MCP open/switch drops terminal identity and breaks session reuse.
      if (!Array.isArray(cardState.sessions) || cardState.sessions.length === 0) {
        initializeCardSessions(cardState, project);
      }
      renderCardTerminalTabs(cardState);
      if (!wasExpanded || !cardState.term) {
        initializeCardTerminal(cardState);
      }
    }

    function collapseCardTerminal(projectPath) {
      const card = projectCardByPath.get(projectPath);
      if (card) {
        delete card.dataset.terminalMode;
        card.classList.remove('mcp-focus');
      }

      const cardState = cardTerminals.get(projectPath);
      if (!cardState) return;

      cardState.isExpanded = false;
      disposeCardTerminalRuntime(cardState);
    }

    function isGenericSessionName(name) {
      const normalized = (name || '').trim().toLowerCase();
      if (!normalized) return true;
      return (
        normalized === 'zsh' ||
        normalized === 'bash' ||
        normalized === 'sh' ||
        normalized === 'fish' ||
        normalized === 'pwsh' ||
        normalized === 'powershell' ||
        normalized === 'cmd' ||
        normalized === 'tmux' ||
        normalized === 'terminal'
      );
    }

    function pickInitialProjectTerminals(projectTerminals, maxTabs = 4) {
      if (!Array.isArray(projectTerminals) || projectTerminals.length === 0) {
        return [];
      }

      const sorted = [...projectTerminals].sort((a, b) => {
        const left = typeof a.processId === 'number' ? a.processId : 0;
        const right = typeof b.processId === 'number' ? b.processId : 0;
        return right - left;
      });

      const named = sorted.filter((terminal) => !isGenericSessionName(terminal.name));
      const generic = sorted.filter((terminal) => isGenericSessionName(terminal.name));
      const selected = [...named];

      for (const terminal of generic) {
        if (selected.length >= maxTabs) break;
        selected.push(terminal);
      }

      if (selected.length === 0 && sorted.length > 0) {
        selected.push(sorted[0]);
      }

      return selected.slice(0, maxTabs);
    }

    function initializeCardSessions(cardState, project) {
      cardState.sessions = [];

      if (project.terminals && project.terminals.length > 0) {
        const initialTerminals = pickInitialProjectTerminals(project.terminals, 4);
        initialTerminals.forEach((t, idx) => {
          const rawPreview = t.lastOutput || '';
          cardState.sessions.push({
            id: t.processId || Date.now() + idx,
            name: t.name,
            ptyId: null,
            agentType: t.agentType,
            clientId: null,
            terminalId: t.processId || null,
            pendingInput: '',
            outputTail: stripAnsi(rawPreview),
            lastOutputAt: t.lastOutputAt || 0
          });
        });
      }

      if (cardState.sessions.length === 0) {
        cardState.sessions.push({
          id: Date.now(),
          name: 'Terminal 1',
          ptyId: null,
          agentType: null,
          clientId: null,
          terminalId: null,
          pendingInput: '',
          outputTail: '',
          lastOutputAt: 0
        });
      }

      cardState.activeSessionIndex = 0;
    }

    function renderCardTerminalTabs(cardState) {
      const card = projectCardByPath.get(cardState.projectPath);
      if (!card) return;

      const tabsContainer = card.querySelector('.card-terminal-tabs');
      if (!tabsContainer) return;

      tabsContainer.textContent = '';

      const colors = {
        claude: '#ff6b00',
        zai: '#0ea5e9',
        opencode: '#22c55e',
        cline: '#a855f7',
        aider: '#eab308'
      };

      cardState.sessions.forEach((session, idx) => {
        const tab = document.createElement('div');
        tab.className = 'card-terminal-tab' + (idx === cardState.activeSessionIndex ? ' active' : '');

        if (session.agentType && session.agentType !== 'generic') {
          const indicator = document.createElement('span');
          indicator.className = 'agent-indicator';
          indicator.style.background = colors[session.agentType] || '#969696';
          indicator.style.width = '6px';
          indicator.style.height = '6px';
          indicator.style.borderRadius = '50%';
          indicator.style.display = 'inline-block';
          tab.appendChild(indicator);
        }

        const label = document.createElement('span');
        label.textContent = session.name || 'Terminal ' + (idx + 1);
        tab.appendChild(label);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'close-tab';
        closeBtn.textContent = 'x';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeCardTerminalSession(cardState, idx);
        });
        tab.appendChild(closeBtn);

        tab.addEventListener('click', (e) => {
          e.stopPropagation();
          switchCardSession(cardState, idx);
        });
        tabsContainer.appendChild(tab);
      });

      const newTab = document.createElement('div');
      newTab.className = 'card-terminal-tab new-tab';
      newTab.textContent = '+';
      newTab.title = 'New terminal';
      newTab.addEventListener('click', (e) => {
        e.stopPropagation();
        createNewCardSession(cardState);
      });
      tabsContainer.appendChild(newTab);
    }

    function initializeCardTerminal(cardState) {
      console.log('[Dashboard] initializeCardTerminal called for:', cardState.projectPath);
      const card = projectCardByPath.get(cardState.projectPath);
      if (!card) {
        console.log('[Dashboard] initializeCardTerminal: card not found');
        return;
      }

      const xtermWrapper = card.querySelector('.card-xterm-wrapper');
      if (!xtermWrapper) {
        console.log('[Dashboard] initializeCardTerminal: xterm wrapper not found');
        return;
      }
      console.log('[Dashboard] initializeCardTerminal: xterm wrapper found');

      // Clear previous terminal
      xtermWrapper.textContent = '';

      const session = cardState.sessions[cardState.activeSessionIndex];
      if (!session) {
        console.log('[Dashboard] initializeCardTerminal: no active session');
        return;
      }
      console.log('[Dashboard] initializeCardTerminal: using session:', session.name);

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 50000,
        fontSize: 12,
        fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
        convertEol: true,
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          cursorAccent: '#0d1117',
          selectionBackground: '#3b5998',
          black: '#484f58',
          red: '#ff7b72',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39c5cf',
          white: '#b1bac4',
          brightBlack: '#6e7681',
          brightRed: '#ffa198',
          brightGreen: '#56d364',
          brightYellow: '#e3b341',
          brightBlue: '#79c0ff',
          brightMagenta: '#d2a8ff',
          brightCyan: '#56d4dd',
          brightWhite: '#f0f6fc',
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(xtermWrapper);
      xtermWrapper.onmousedown = (event) => {
        event.stopPropagation();
        term.focus();
      };
      xtermWrapper.onclick = (event) => {
        event.stopPropagation();
        term.focus();
      };
      xtermWrapper.onwheel = (event) => {
        event.stopPropagation();
        const target = event.target;
        const onViewport = target instanceof HTMLElement && !!target.closest('.xterm-viewport');
        if (!onViewport && event.deltaY !== 0) {
          const lineDelta = event.deltaMode === 1 ? event.deltaY : event.deltaY / 16;
          const lines = Math.trunc(lineDelta);
          if (lines !== 0) {
            term.scrollLines(lines);
            event.preventDefault();
          }
        }
      };

      // Delay fitting until DOM stabilized
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddon.fit();
          term.focus();
          requestCardPtyConnect(cardState);
        });
      });

      term.onData(data => {
        cardState.lastUserInputAt = Date.now();
        setProjectAttention(cardState.projectPath, false);
        reportCardActivity(cardState, 'running');
        if (!cardState.ptyId || !cardState.isReady) {
          // Buffer keystrokes while the tab/session is still attaching so rapid
          // tab switches don't silently drop user input.
          if (session) {
            const nextInput = (session.pendingInput || '') + data;
            session.pendingInput = nextInput.length > 8000 ? nextInput.slice(-8000) : nextInput;
          }
          return;
        }
        vscode.postMessage({
          command: 'card:pty:write',
          id: cardState.ptyId,
          projectPath: cardState.projectPath,
          data: data
        });
      });

      term.onResize(size => {
        if (cardState.ptyId && cardState.isReady) {
          vscode.postMessage({
            command: 'card:pty:resize',
            id: cardState.ptyId,
            projectPath: cardState.projectPath,
            cols: size.cols,
            rows: size.rows
          });
        }
      });

      cardState.term = term;
      cardState.fitAddon = fitAddon;
      cardState.isReady = false;
      cardState.restoringSnapshot = false;
      cardState.pendingSnapshotData = '';

      // Set up resize observer for the card terminal container
      const resizeObserver = new ResizeObserver(() => {
        if (cardState.isExpanded && cardState.fitAddon) {
          cardState.fitAddon.fit();
        }
      });
      resizeObserver.observe(xtermWrapper);
      cardState.resizeObserver = resizeObserver;
    }

    function requestCardPtyConnect(cardState) {
      const session = cardState.sessions[cardState.activeSessionIndex];
      if (!session) return;

      if (cardState.clientId) {
        cardPendingPty.delete(cardState.clientId);
        cardState.clientId = null;
      }

      const clientId = 'card-' + nextClientId();
      cardState.clientId = clientId;
      session.clientId = clientId;
      cardPendingPty.set(clientId, { projectPath: cardState.projectPath, sessionId: session.id });

      vscode.postMessage({
        command: 'card:pty:create',
        projectPath: cardState.projectPath,
        cwd: cardState.projectPath,
        cols: cardState.term ? cardState.term.cols : 80,
        rows: cardState.term ? cardState.term.rows : 24,
        clientId: clientId,
        terminalId: session.terminalId || null,
        terminalName: session.name || null
      });
    }

    function handleCardPtyCreated(message) {
      const pending = cardPendingPty.get(message.clientId);
      if (!pending) {
        if (message.id) {
          vscode.postMessage({ command: 'card:pty:detach', id: message.id, projectPath: message.projectPath });
        }
        return;
      }

      const cardState = cardTerminals.get(pending.projectPath);
      if (!cardState || !cardState.isExpanded) {
        vscode.postMessage({ command: 'card:pty:detach', id: message.id, projectPath: pending.projectPath });
        cardPendingPty.delete(message.clientId);
        return;
      }

      const session = cardState.sessions.find(s => s.id === pending.sessionId);
      if (!session) {
        vscode.postMessage({ command: 'card:pty:detach', id: message.id, projectPath: pending.projectPath });
        cardPendingPty.delete(message.clientId);
        return;
      }

      session.ptyId = message.id;
      session.clientId = null;
      if (typeof message.pid === 'number') {
        session.terminalId = message.pid;
      }
      if (typeof message.terminalName === 'string' && message.terminalName.trim()) {
        session.name = message.terminalName.trim();
      }

      cardState.ptyId = message.id;
      cardState.clientId = null;
      cardState.isReady = true;
      renderCardTerminalTabs(cardState);

      ptyToCard.set(message.id, cardState.projectPath);
      cardPendingPty.delete(message.clientId);

      if (cardState.term) {
        cardState.term.focus();
      }

      // Send pending resize
      if (cardState.term) {
        vscode.postMessage({
          command: 'card:pty:resize',
          id: cardState.ptyId,
          projectPath: cardState.projectPath,
          cols: cardState.term.cols,
          rows: cardState.term.rows
        });
      }

      const pendingInput = typeof session.pendingInput === 'string' ? session.pendingInput : '';
      if (pendingInput.length > 0) {
        session.pendingInput = '';
        vscode.postMessage({
          command: 'card:pty:write',
          id: cardState.ptyId,
          projectPath: cardState.projectPath,
          data: pendingInput
        });
      }
    }

    function handleCardPtyData(message) {
      const projectPath = ptyToCard.get(message.id);
      if (!projectPath) return;

      const cardState = cardTerminals.get(projectPath);
      if (!cardState || !cardState.term || !cardState.isExpanded) return;

      if (message.full) {
        cardState.restoringSnapshot = true;
        cardState.pendingSnapshotData = '';
        cardState.term.reset();
        cardState.outputTail = '';
        cardState.lastOutputAt = Date.now();
        cardState.outputTail = updateOutputTail(cardState.outputTail, stripAnsi(message.data));
        writeTerminalChunked(cardState.term, message.data, () => {
          flushCardSnapshotBuffer(cardState);
        });
        return;
      }

      if (cardState.restoringSnapshot) {
        const next = (cardState.pendingSnapshotData || '') + (message.data || '');
        cardState.pendingSnapshotData = next.length > 256000 ? next.slice(-256000) : next;
        return;
      }

      cardState.term.write(message.data);
      cardState.lastOutputAt = Date.now();
      cardState.outputTail = updateOutputTail(cardState.outputTail, stripAnsi(message.data));

      const now = Date.now();
      const shouldAnalyze =
        !cardState.lastActivityCheckAt ||
        now - cardState.lastActivityCheckAt >= cardActivitySignalThrottleMs ||
        /[\r\n]/.test(message.data || '');
      if (shouldAnalyze) {
        cardState.lastActivityCheckAt = now;
        const signal = classifyActivitySignal(cardState.outputTail);
        reportCardActivity(cardState, signal.activity, signal.detail);
      }
    }

    function handleCardPtyExit(message) {
      const projectPath = ptyToCard.get(message.id);
      if (!projectPath) return;

      const cardState = cardTerminals.get(projectPath);
      if (cardState) {
        if (cardState.ptyId === message.id) {
          cardState.ptyId = null;
          cardState.isReady = false;
          cardState.restoringSnapshot = false;
          cardState.pendingSnapshotData = '';
        }
        cardState.sessions.forEach((session) => {
          if (session.ptyId === message.id) {
            session.ptyId = null;
          }
        });
        reportCardActivity(cardState, 'idle');
      }
      ptyToCard.delete(message.id);
    }

    function handleCardPtyError(message) {
      const pending = cardPendingPty.get(message.clientId);
      if (!pending) return;

      const cardState = cardTerminals.get(pending.projectPath);
      if (cardState) {
        cardState.isReady = false;
        cardState.clientId = null;
        cardState.restoringSnapshot = false;
        cardState.pendingSnapshotData = '';
        const session = cardState.sessions.find(s => s.clientId === message.clientId);
        if (session) {
          session.clientId = null;
        }
        reportCardActivity(cardState, 'error', 'connection');
      }
      cardPendingPty.delete(message.clientId);
    }

    function switchCardSession(cardState, idx) {
      if (idx === cardState.activeSessionIndex) return;

      // Detach current session
      if (cardState.ptyId) {
        vscode.postMessage({ command: 'card:pty:detach', id: cardState.ptyId, projectPath: cardState.projectPath });
        ptyToCard.delete(cardState.ptyId);
        cardState.ptyId = null;
      }

      cardState.activeSessionIndex = idx;
      renderCardTerminalTabs(cardState);
      initializeCardTerminal(cardState);
    }

    function createNewCardSession(cardState) {
      // Detach current session before switching to a new one
      if (cardState.ptyId) {
        vscode.postMessage({ command: 'card:pty:detach', id: cardState.ptyId, projectPath: cardState.projectPath });
        ptyToCard.delete(cardState.ptyId);
        cardState.ptyId = null;
      }

      if (cardState.clientId) {
        cardPendingPty.delete(cardState.clientId);
        cardState.clientId = null;
      }

      const session = {
        id: Date.now(),
        name: 'Terminal ' + (cardState.sessions.length + 1),
        ptyId: null,
        agentType: null,
        clientId: null,
        terminalId: null,
        pendingInput: '',
        outputTail: '',
        lastOutputAt: 0
      };
      cardState.sessions.push(session);
      cardState.activeSessionIndex = cardState.sessions.length - 1;
      renderCardTerminalTabs(cardState);
      initializeCardTerminal(cardState);
    }

    function closeCardTerminalSession(cardState, idx) {
      const session = cardState.sessions[idx];
      const wasActiveSession = (idx === cardState.activeSessionIndex);

      if (session.ptyId) {
        // Kill the tmux session completely when user explicitly closes
        vscode.postMessage({ command: 'card:pty:kill', id: session.ptyId, projectPath: cardState.projectPath });
        ptyToCard.delete(session.ptyId);
      }

      if (session.clientId) {
        cardPendingPty.delete(session.clientId);
        session.clientId = null;
      }

      if (cardState.ptyId === session.ptyId) {
        cardState.ptyId = null;
      }

      cardState.sessions.splice(idx, 1);

      if (cardState.sessions.length === 0) {
        createNewCardSession(cardState);
        return;
      }

      if (idx < cardState.activeSessionIndex) {
        cardState.activeSessionIndex--;
        renderCardTerminalTabs(cardState);
      } else if (wasActiveSession) {
        if (cardState.activeSessionIndex >= cardState.sessions.length) {
          cardState.activeSessionIndex = cardState.sessions.length - 1;
        }
        renderCardTerminalTabs(cardState);
        initializeCardTerminal(cardState);
      } else {
        renderCardTerminalTabs(cardState);
      }
    }

    // Expand card terminal via MCP command
    function expandCardTerminalByMcp(projectPath, terminalName) {
      console.log('[Dashboard] expandCardTerminalByMcp called:', projectPath, terminalName);
      vscode.postMessage({ command: 'debug:log', message: 'expandCardTerminalByMcp called for: ' + projectPath });

      // Check if card exists
      const cardExists = projectCardByPath.has(projectPath);
      vscode.postMessage({ command: 'debug:log', message: 'Card exists: ' + cardExists + ', keys: ' + Array.from(projectCardByPath.keys()).join(', ') });

      expandCardTerminal(projectPath);

      const cardState = cardTerminals.get(projectPath);
      vscode.postMessage({ command: 'debug:log', message: 'Card state after expand: ' + (cardState ? 'exists, expanded=' + cardState.isExpanded : 'null') });

      if (cardState && terminalName) {
        // Rename the first session if a name was provided
        if (cardState.sessions.length > 0) {
          cardState.sessions[0].name = terminalName;
          renderCardTerminalTabs(cardState);
        }
      }
    }

    function createWindowSessionForMcp(windowState, terminalName, terminalId) {
      const session = {
        id: Date.now(),
        name: terminalName || ('Terminal ' + (windowState.sessions.length + 1)),
        ptyId: null,
        agentType: null,
        clientId: null,
        terminalId: terminalId !== null ? terminalId : null,
        pendingInput: '',
        outputTail: '',
        outputTailRaw: '',
        lastOutputAt: 0
      };
      windowState.sessions.push(session);
      windowState.activeSessionIndex = windowState.sessions.length - 1;
      renderTerminalTabs(windowState);
      initializeTerminal(windowState, windowState.project.path);
    }

    // Handle MCP request to open a collaborative terminal in the same floating window UI
    // as manual card clicks (instead of the compact in-card expansion mode).
    function handleMcpOpenCardTerminal(projectPath, options) {
      console.log('[Dashboard] handleMcpOpenCardTerminal called:', projectPath, options);
      vscode.postMessage({ command: 'debug:log', message: '[MCP] handleMcpOpenCardTerminal: ' + projectPath });

      const project = projects.find((candidate) => candidate.path === projectPath);
      if (!project) {
        console.log('[Dashboard] Project not found for path:', projectPath);
        vscode.postMessage({ command: 'debug:log', message: '[MCP] ERROR: Project not found for: ' + projectPath });
        const alreadyPending = pendingMcpCardOpens.has(projectPath);
        pendingMcpCardOpens.set(projectPath, {
          terminalName: options && typeof options.terminalName === 'string' ? options.terminalName : undefined,
          terminalId: options && typeof options.terminalId === 'number' ? options.terminalId : undefined,
          createNewTerminal: !!(options && options.createNewTerminal),
        });
        if (!alreadyPending) {
          vscode.postMessage({ command: 'refresh' });
        }
        return;
      }
      pendingMcpCardOpens.delete(projectPath);

      // Keep a single visual mode: close any expanded card-embedded terminal first.
      collapseCardTerminal(projectPath);
      projectCardByPath.forEach((candidate) => candidate.classList.remove('mcp-focus'));

      const windowState = openWindow(project);
      if (!windowState) {
        return;
      }

      restoreWindow(windowState.id);
      bringToFront(windowState.id);

      const createNewTerminal = !!(options && options.createNewTerminal);
      const terminalId = options && typeof options.terminalId === 'number' ? options.terminalId : null;
      const terminalName = options && typeof options.terminalName === 'string' ? options.terminalName.trim() : '';

      if (createNewTerminal) {
        createNewSession(windowState);
        if (terminalName) {
          const activeSession = getActiveSession(windowState);
          if (activeSession) {
            activeSession.name = terminalName;
            renderTerminalTabs(windowState);
          }
        }
        return;
      }

      if (terminalId !== null) {
        const targetIndex = windowState.sessions.findIndex((session) => session.terminalId === terminalId);
        if (targetIndex >= 0) {
          switchToSession(windowState, targetIndex);
        } else {
          createWindowSessionForMcp(windowState, terminalName, terminalId);
        }
        return;
      }

      if (terminalName) {
        const normalized = terminalName.toLowerCase();
        const targetIndex = windowState.sessions.findIndex(
          (session) => (session.name || '').toLowerCase() === normalized
        );
        if (targetIndex >= 0) {
          switchToSession(windowState, targetIndex);
        } else {
          createWindowSessionForMcp(windowState, terminalName, null);
        }
      }
    }

    // Scroll to a project card
    function scrollToCard(projectPath, block = 'center') {
      const card = projectCardByPath.get(projectPath);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: block });
        // Add a brief highlight effect
        card.classList.add('highlight-card');
        setTimeout(() => card.classList.remove('highlight-card'), 1000);
      }
    }

    // ==========================================
    // End of Embedded Card Terminal Functions
    // ==========================================

    function openWindow(project) {
      const existingId = projectWindows.get(project.path);
      if (existingId && windows.has(existingId)) {
        const existingWindow = windows.get(existingId);
        restoreWindow(existingId);
        bringToFront(existingId);
        if (existingWindow && existingWindow.term) {
          existingWindow.term.focus();
        }
        return existingWindow || null;
      }

      const windowState = createWindow(project);
      windows.set(windowState.id, windowState);
      projectWindows.set(project.path, windowState.id);
      bringToFront(windowState.id);

      initializeSessions(windowState, project);
      renderTerminalTabs(windowState);
      initializeTerminal(windowState, project.path);

      setTimeout(() => {
        fitWindowTerminal(windowState);
      }, 100);

      return windowState;
    }

    function createWindow(project) {
      const id = nextWindowId();

      const windowEl = document.createElement('div');
      windowEl.className = 'window';
      windowEl.dataset.windowId = id;
      windowEl.style.zIndex = String(++zCounter);

      const header = document.createElement('div');
      header.className = 'window-header';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'window-title-wrap';

      const attentionDot = document.createElement('span');
      attentionDot.className = 'window-attention';

      const title = document.createElement('div');
      title.className = 'window-title';
      title.textContent = project.name;

      const closeBtn = document.createElement('button');
      closeBtn.className = 'window-close';
      closeBtn.textContent = 'x';
      closeBtn.title = 'Hide window';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        minimizeWindow(id);
      });

      titleWrap.appendChild(attentionDot);
      titleWrap.appendChild(title);
      header.appendChild(titleWrap);
      header.appendChild(closeBtn);

      const tabs = document.createElement('div');
      tabs.className = 'terminal-tabs';

      const terminalArea = document.createElement('div');
      terminalArea.className = 'terminal-area';

      const terminalContainer = document.createElement('div');
      terminalContainer.className = 'terminal-container';

      const loading = document.createElement('div');
      loading.className = 'terminal-loading';
      loading.textContent = 'Initializing terminal...';
      terminalContainer.appendChild(loading);

      terminalArea.appendChild(terminalContainer);

      const statusBar = document.createElement('div');
      statusBar.className = 'status-bar';

      const statusDot = document.createElement('span');
      statusDot.className = 'status-dot-small disconnected';

      const statusText = document.createElement('span');
      statusText.textContent = 'Connecting...';

      statusBar.appendChild(statusDot);
      statusBar.appendChild(statusText);

      windowEl.appendChild(header);
      windowEl.appendChild(tabs);
      windowEl.appendChild(terminalArea);
      windowEl.appendChild(statusBar);

      windowEl.addEventListener('mousedown', () => bringToFront(id));
      header.addEventListener('mousedown', (e) => startDrag(e, id));
      terminalContainer.addEventListener('mousedown', () => bringToFront(id));
      terminalContainer.addEventListener('click', () => {
        const windowState = windows.get(id);
        if (windowState && windowState.term) {
          windowState.term.focus();
        }
      });

      windowLayer.appendChild(windowEl);

      const windowState = {
        id,
        project,
        element: windowEl,
        header,
        titleEl: title,
        tabs,
        terminalContainer,
        statusDot,
        statusText,
        sessions: [],
        activeSessionIndex: 0,
        term: null,
        fitAddon: null,
        currentPtyId: null,
        isReady: false,
        minimized: false,
        dockItem: null,
        isMaximized: false,
        resizeObserver: null,
        connectTimer: null,
        connectAttempts: 0,
        pendingDrops: [],
        needsAttention: false,
        lastUserInputAt: 0,
        lastOutputAt: 0,
        outputTail: '',
        idleTimer: null,
        lastAttentionAt: 0,
        lastPreviewAt: 0,
        activity: project.activity || 'idle',
        suppressFit: false,
        lastActivitySentAt: 0,
        pendingResize: null,
        lastSentSize: null,
        previewUpdateTimer: null,
        restoringSnapshot: false,
        pendingSnapshotData: ''
      };

      positionWindow(windowState);
      const resizeObserver = new ResizeObserver(() => {
        if (!windowState.minimized && !windowState.suppressFit) {
          fitWindowTerminal(windowState);
        }
      });
      resizeObserver.observe(windowEl);
      windowState.resizeObserver = resizeObserver;

      return windowState;
    }

    function positionWindow(windowState) {
      const layerRect = getLayerRect();
      const width = Math.min(620, layerRect.width - 24);
      const height = Math.min(420, layerRect.height - 24);

      const left = clamp(40 + cascadeOffset, 0, layerRect.width - width);
      const top = clamp(60 + cascadeOffset, 0, layerRect.height - height);

      windowState.element.style.width = width + 'px';
      windowState.element.style.height = height + 'px';
      windowState.element.style.left = left + 'px';
      windowState.element.style.top = top + 'px';

      cascadeOffset = (cascadeOffset + 32) % 160;
    }

    function bringToFront(windowId) {
      const windowState = windows.get(windowId);
      if (!windowState) return;
      windowState.element.style.zIndex = String(++zCounter);
      activeWindowId = windowId;
      clearWindowAttention(windowState);
    }

    function startDrag(event, windowId) {
      if (event.button !== 0) return;
      const windowState = windows.get(windowId);
      if (!windowState || windowState.minimized || windowState.isMaximized) return;

      bringToFront(windowId);

      const layerRect = getLayerRect();
      const rect = windowState.element.getBoundingClientRect();

      dragState.windowId = windowId;
      dragState.startX = event.clientX;
      dragState.startY = event.clientY;
      dragState.startLeft = rect.left - layerRect.left;
      dragState.startTop = rect.top - layerRect.top;

      windowState.element.classList.add('dragging');
      document.body.style.userSelect = 'none';
      event.preventDefault();
    }

    function minimizeWindow(windowId) {
      const windowState = windows.get(windowId);
      if (!windowState || windowState.minimized) return;

      windowState.minimized = true;
      windowState.element.classList.add('minimized');
      if (activeWindowId === windowId) {
        activeWindowId = null;
      }

      const dockItem = document.createElement('button');
      dockItem.className = 'dock-item';
      dockItem.textContent = windowState.project.name;
      const dockDot = document.createElement('span');
      dockDot.className = 'dock-attention';
      dockItem.appendChild(dockDot);
      if (windowState.needsAttention) {
        dockItem.classList.add('attention');
      }
      dockItem.addEventListener('click', () => restoreWindow(windowId));

      windowState.dockItem = dockItem;
      windowDock.appendChild(dockItem);
    }

    function restoreWindow(windowId) {
      const windowState = windows.get(windowId);
      if (!windowState) return;

      if (windowState.minimized) {
        windowState.minimized = false;
        windowState.element.classList.remove('minimized');
        if (windowState.dockItem) {
          windowState.dockItem.remove();
          windowState.dockItem = null;
        }
      }

      bringToFront(windowId);
      requestAnimationFrame(() => {
        fitWindowTerminal(windowState);
        if (windowState.term) {
          windowState.term.focus();
        }
      });
    }

    function toggleMaximizeWindow(windowId) {
      const windowState = windows.get(windowId);
      if (!windowState) return;

      windowState.isMaximized = !windowState.isMaximized;
      windowState.element.classList.toggle('maximized', windowState.isMaximized);

      bringToFront(windowId);
      requestAnimationFrame(() => fitWindowTerminal(windowState));
    }

    function closeWindowByProject(projectPath) {
      const windowId = projectWindows.get(projectPath);
      if (windowId) {
        closeWindow(windowId);
      }
    }

    function closeWindow(windowId) {
      const windowState = windows.get(windowId);
      if (!windowState) return;

      if (windowState.resizeObserver) {
        windowState.resizeObserver.disconnect();
        windowState.resizeObserver = null;
      }

      if (windowState.idleTimer) {
        clearTimeout(windowState.idleTimer);
        windowState.idleTimer = null;
      }

      if (windowState.previewUpdateTimer) {
        clearTimeout(windowState.previewUpdateTimer);
        windowState.previewUpdateTimer = null;
      }

      clearConnectTimer(windowState);

      clearWindowAttention(windowState);
      projectLivePreviewAt.delete(windowState.project.path);
      projectLivePreviewText.delete(windowState.project.path);
      if (windowState.pendingDrops) {
        windowState.pendingDrops.length = 0;
      }

      // Kill all terminal sessions when window is closed to prevent tmux session leaks
      windowState.sessions.forEach((session) => {
        if (session.ptyId) {
          vscode.postMessage({ command: 'pty:kill', id: session.ptyId });
          ptyToWindow.delete(session.ptyId);
        }
      });

      if (windowState.currentPtyId && !windowState.sessions.some(s => s.ptyId === windowState.currentPtyId)) {
        vscode.postMessage({ command: 'pty:kill', id: windowState.currentPtyId });
        ptyToWindow.delete(windowState.currentPtyId);
      }

      if (windowState.term) {
        windowState.term.dispose();
      }

      if (windowState.dockItem) {
        windowState.dockItem.remove();
      }

      windowState.element.remove();

      windows.delete(windowId);
      if (projectWindows.get(windowState.project.path) === windowId) {
        projectWindows.delete(windowState.project.path);
      }

      Array.from(pendingPty.entries()).forEach(([clientId, pending]) => {
        if (pending.windowId === windowId) {
          pendingPty.delete(clientId);
        }
      });

      if (activeWindowId === windowId) {
        activeWindowId = null;
      }
    }

    function initializeSessions(windowState, project) {
      windowState.sessions = [];

      if (project.terminals && project.terminals.length > 0) {
        const initialTerminals = pickInitialProjectTerminals(project.terminals, 4);
        initialTerminals.forEach((t, idx) => {
          const rawPreview = t.lastOutput || '';
          windowState.sessions.push({
            id: t.processId || Date.now() + idx,
            name: t.name,
            ptyId: null,
            agentType: t.agentType,
            clientId: null,
            terminalId: t.processId || null,
            pendingInput: '',
            outputTail: stripAnsi(rawPreview),
            outputTailRaw: rawPreview,
            lastOutputAt: t.lastOutputAt || 0
          });
        });
      }

      if (windowState.sessions.length === 0) {
        windowState.sessions.push({
          id: Date.now(),
          name: 'Terminal 1',
          ptyId: null,
          agentType: null,
          clientId: null,
          terminalId: null,
          pendingInput: '',
          outputTail: '',
          outputTailRaw: '',
          lastOutputAt: 0
        });
      }

      windowState.activeSessionIndex = 0;
    }

    function renderTerminalTabs(windowState) {
      const terminalTabs = windowState.tabs;
      terminalTabs.textContent = '';

      const colors = {
        claude: '#ff6b00',
        zai: '#0ea5e9',
        opencode: '#22c55e',
        cline: '#a855f7',
        aider: '#eab308'
      };

      windowState.sessions.forEach((session, idx) => {
        const tab = document.createElement('div');
        tab.className = 'terminal-tab' + (idx === windowState.activeSessionIndex ? ' active' : '');

        if (session.agentType && session.agentType !== 'generic') {
          const indicator = document.createElement('span');
          indicator.className = 'agent-indicator';
          indicator.style.background = colors[session.agentType] || '#969696';
          tab.appendChild(indicator);
        }

        const label = document.createElement('span');
        label.textContent = session.name || 'Terminal ' + (idx + 1);
        tab.appendChild(label);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'close-tab';
        closeBtn.textContent = 'x';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTerminalSession(windowState, idx);
        });
        tab.appendChild(closeBtn);

        tab.addEventListener('click', () => switchToSession(windowState, idx));
        terminalTabs.appendChild(tab);
      });

      const newTab = document.createElement('div');
      newTab.className = 'terminal-tab new-tab';
      newTab.textContent = '+';
      newTab.title = 'New terminal';
      newTab.addEventListener('click', () => createNewSession(windowState));
      terminalTabs.appendChild(newTab);
    }

    function getActiveSession(windowState) {
      if (!windowState || !windowState.sessions || windowState.sessions.length === 0) return null;
      return windowState.sessions[windowState.activeSessionIndex] || null;
    }

    function persistSessionOutput(windowState) {
      const session = getActiveSession(windowState);
      if (!session) return;
      session.outputTail = windowState.outputTail || '';
      session.outputTailRaw = windowState.outputTailRaw || '';
      session.lastOutputAt = windowState.lastOutputAt || 0;
    }

    function restoreSessionOutput(windowState) {
      const session = getActiveSession(windowState);
      windowState.outputTail = session?.outputTail || '';
      windowState.outputTailRaw = session?.outputTailRaw || '';
      windowState.lastOutputAt = session?.lastOutputAt || 0;
    }

    function createNewSession(windowState) {
      const session = {
        id: Date.now(),
        name: 'Terminal ' + (windowState.sessions.length + 1),
        ptyId: null,
        agentType: null,
        clientId: null,
        terminalId: null,
        pendingInput: '',
        outputTail: '',
        outputTailRaw: '',
        lastOutputAt: 0
      };
      windowState.sessions.push(session);
      windowState.activeSessionIndex = windowState.sessions.length - 1;
      renderTerminalTabs(windowState);
      initializeTerminal(windowState, windowState.project.path);
    }

    function switchToSession(windowState, idx) {
      if (idx === windowState.activeSessionIndex) return;

      persistSessionOutput(windowState);
      disposeTerminal(windowState, true);

      windowState.activeSessionIndex = idx;
      renderTerminalTabs(windowState);
      initializeTerminal(windowState, windowState.project.path);
    }

    function closeTerminalSession(windowState, idx) {
      const session = windowState.sessions[idx];
      const wasActiveSession = (idx === windowState.activeSessionIndex);

      if (session.ptyId) {
        vscode.postMessage({ command: 'pty:kill', id: session.ptyId });
        ptyToWindow.delete(session.ptyId);
      }

      if (session.clientId) {
        pendingPty.delete(session.clientId);
        session.clientId = null;
      }

      if (windowState.currentPtyId === session.ptyId) {
        windowState.currentPtyId = null;
      }

      persistSessionOutput(windowState);
      windowState.sessions.splice(idx, 1);

      if (windowState.sessions.length === 0) {
        createNewSession(windowState);
        return;
      }

      // Adjust activeSessionIndex if needed
      if (idx < windowState.activeSessionIndex) {
        // Closed a tab before the active one - just shift the index down
        windowState.activeSessionIndex--;
        renderTerminalTabs(windowState);
      } else if (wasActiveSession) {
        // Closed the active tab - need to switch to another session
        if (windowState.activeSessionIndex >= windowState.sessions.length) {
          windowState.activeSessionIndex = windowState.sessions.length - 1;
        }
        disposeTerminal(windowState, true);
        renderTerminalTabs(windowState);
        initializeTerminal(windowState, windowState.project.path);
      } else {
        // Closed a tab after the active one - just re-render tabs
        renderTerminalTabs(windowState);
      }
    }

    function clearTerminalContainer(windowState) {
      while (windowState.terminalContainer.firstChild) {
        windowState.terminalContainer.removeChild(windowState.terminalContainer.firstChild);
      }
    }

    function disposeTerminal(windowState, detachOnly = false) {
      if (windowState.idleTimer) {
        clearTimeout(windowState.idleTimer);
        windowState.idleTimer = null;
      }
      clearConnectTimer(windowState);

      const activeSession = windowState.sessions[windowState.activeSessionIndex];
      if (activeSession && activeSession.clientId) {
        pendingPty.delete(activeSession.clientId);
        activeSession.clientId = null;
      }

      if (windowState.currentPtyId) {
        vscode.postMessage({ command: detachOnly ? 'pty:detach' : 'pty:kill', id: windowState.currentPtyId });
        ptyToWindow.delete(windowState.currentPtyId);
        windowState.currentPtyId = null;
      }

      if (windowState.term) {
        windowState.term.dispose();
        windowState.term = null;
      }

      windowState.fitAddon = null;
      windowState.pendingResize = null;
      windowState.lastSentSize = null;
      windowState.isReady = false;
      windowState.restoringSnapshot = false;
      windowState.pendingSnapshotData = '';
      setWindowStatus(windowState, 'disconnected', 'Disconnected');
    }

    function initializeTerminal(windowState, cwd) {
      // Only dispose if there's an active PTY to detach
      // This avoids redundant disposal when switching sessions
      if (windowState.currentPtyId) {
        disposeTerminal(windowState, true);
      }
      clearTerminalContainer(windowState);

      // Suppress fit operations during terminal initialization to prevent
      // rendering issues when the DOM hasn't stabilized yet
      windowState.suppressFit = true;

      restoreSessionOutput(windowState);
      windowState.lastUserInputAt = 0;
      windowState.lastAttentionAt = 0;
      windowState.connectAttempts = 0;
      windowState.restoringSnapshot = false;
      windowState.pendingSnapshotData = '';

      const session = windowState.sessions[windowState.activeSessionIndex];
      if (!session) {
        windowState.suppressFit = false;
        return;
      }

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 50000,
        fontSize: 13,
        fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
        convertEol: true,
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          cursorAccent: '#0d1117',
          selectionBackground: '#3b5998',
          black: '#484f58',
          red: '#ff7b72',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39c5cf',
          white: '#b1bac4',
          brightBlack: '#6e7681',
          brightRed: '#ffa198',
          brightGreen: '#56d364',
          brightYellow: '#e3b341',
          brightBlue: '#79c0ff',
          brightMagenta: '#d2a8ff',
          brightCyan: '#56d4dd',
          brightWhite: '#f0f6fc',
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      windowState.terminalContainer.textContent = '';
      term.open(windowState.terminalContainer);
      windowState.terminalContainer.onwheel = (event) => {
        event.stopPropagation();
        const target = event.target;
        const onViewport = target instanceof HTMLElement && !!target.closest('.xterm-viewport');
        if (!onViewport && event.deltaY !== 0) {
          const lineDelta = event.deltaMode === 1 ? event.deltaY : event.deltaY / 16;
          const lines = Math.trunc(lineDelta);
          if (lines !== 0) {
            term.scrollLines(lines);
            event.preventDefault();
          }
        }
      };

      // Delay fitting until after the DOM has fully stabilized
      // Double RAF ensures the browser has completed layout and paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddon.fit();
          term.focus();
          sendResize(windowState, term.cols, term.rows);
          requestPtyConnect(windowState, cwd);

          // Re-enable fit operations after initial fit is complete
          windowState.suppressFit = false;
        });
      });

      term.onData(data => {
        noteInput(windowState, data);
        windowState.lastUserInputAt = Date.now();
        clearWindowAttention(windowState);
        if (!windowState.currentPtyId || !windowState.isReady) {
          const nextInput = (session.pendingInput || '') + data;
          session.pendingInput = nextInput.length > 8000 ? nextInput.slice(-8000) : nextInput;
          return;
        }
        vscode.postMessage({
          command: 'pty:write',
          id: windowState.currentPtyId,
          data: data
        });
      });

      term.onResize(size => {
        sendResize(windowState, size.cols, size.rows);
      });

      // Remove onRender callback to reduce flickering
      // Preview updates are already handled via noteOutput() when data is written

      windowState.term = term;
      windowState.fitAddon = fitAddon;
      updatePreviewFromTerminal(windowState);

      setWindowStatus(windowState, 'disconnected', 'Connecting...');
      windowState.isReady = false;
    }

    function sendResize(windowState, cols, rows) {
      const safeCols = Math.max(1, Math.floor(cols || 0));
      const safeRows = Math.max(1, Math.floor(rows || 0));
      if (!safeCols || !safeRows) {
        return;
      }

      windowState.pendingResize = { cols: safeCols, rows: safeRows };

      if (!windowState.currentPtyId) {
        return;
      }

      const last = windowState.lastSentSize;
      if (last && last.cols === safeCols && last.rows === safeRows) {
        return;
      }

      windowState.lastSentSize = { cols: safeCols, rows: safeRows };
      vscode.postMessage({
        command: 'pty:resize',
        id: windowState.currentPtyId,
        cols: safeCols,
        rows: safeRows
      });
    }

    function fitWindowTerminal(windowState) {
      if (!windowState.term || !windowState.fitAddon || windowState.suppressFit) return;

      windowState.fitAddon.fit();
      sendResize(windowState, windowState.term.cols, windowState.term.rows);
    }

    function writeTerminalChunked(term, text, onDone) {
      if (!term || !text) {
        if (typeof onDone === 'function') onDone();
        return;
      }

      if (text.length <= terminalWriteChunkSize) {
        term.write(text, () => {
          if (typeof onDone === 'function') onDone();
        });
        return;
      }

      let offset = 0;
      const writeNext = () => {
        if (!term) {
          if (typeof onDone === 'function') onDone();
          return;
        }

        const chunk = text.slice(offset, offset + terminalWriteChunkSize);
        offset += chunk.length;
        term.write(chunk, () => {
          if (offset >= text.length) {
            if (typeof onDone === 'function') onDone();
            return;
          }
          setTimeout(writeNext, terminalWriteYieldMs);
        });
      };

      writeNext();
    }

    function flushWindowSnapshotBuffer(windowState) {
      if (!windowState || !windowState.term) {
        return;
      }

      const buffered = typeof windowState.pendingSnapshotData === 'string'
        ? windowState.pendingSnapshotData
        : '';
      windowState.pendingSnapshotData = '';
      windowState.restoringSnapshot = false;

      if (buffered) {
        windowState.term.write(buffered);
        noteOutput(windowState, buffered);
      }

      windowState.term.scrollToBottom();
      if (windowState.id === activeWindowId) {
        windowState.term.focus();
      }
    }

    function flushCardSnapshotBuffer(cardState) {
      if (!cardState || !cardState.term) {
        return;
      }

      const buffered = typeof cardState.pendingSnapshotData === 'string'
        ? cardState.pendingSnapshotData
        : '';
      cardState.pendingSnapshotData = '';
      cardState.restoringSnapshot = false;

      if (buffered) {
        cardState.term.write(buffered);
        cardState.lastOutputAt = Date.now();
        cardState.outputTail = updateOutputTail(cardState.outputTail, stripAnsi(buffered));
      }

      cardState.term.scrollToBottom();
      if (cardState.isExpanded) {
        cardState.term.focus();
      }
    }

    function handlePtyCreated(message) {
      if (!message.clientId) {
        return;
      }

      const pending = pendingPty.get(message.clientId);
      if (!pending) {
        if (message.id) {
          vscode.postMessage({ command: 'pty:kill', id: message.id });
        }
        return;
      }

      const windowState = windows.get(pending.windowId);
      if (!windowState) {
        vscode.postMessage({ command: 'pty:kill', id: message.id });
        pendingPty.delete(message.clientId);
        return;
      }

      const session = windowState.sessions.find(s => s.id === pending.sessionId);
      if (!session) {
        vscode.postMessage({ command: 'pty:kill', id: message.id });
        pendingPty.delete(message.clientId);
        return;
      }

      const activeSession = windowState.sessions[windowState.activeSessionIndex];
      if (!activeSession || activeSession.id !== pending.sessionId) {
        vscode.postMessage({ command: 'pty:kill', id: message.id });
        pendingPty.delete(message.clientId);
        session.clientId = null;
        return;
      }

      // Clean up any pending data for the OLD ptyId of this session (prevents stale data)
      const oldPtyId = session.ptyId;
      if (oldPtyId && oldPtyId !== message.id) {
        pendingPtyData.delete(oldPtyId);
        ptyToWindow.delete(oldPtyId);
      }

      session.ptyId = message.id;
      session.clientId = null;
      session.isReconnect = message.reconnect; // Track reconnect state for handlePtyData
      if (typeof message.pid === 'number') {
        session.terminalId = message.pid;
      }
      if (typeof message.terminalName === 'string' && message.terminalName.trim()) {
        session.name = message.terminalName.trim();
      }
      renderTerminalTabs(windowState);
      windowState.currentPtyId = message.id;
      windowState.isReady = true;
      windowState.connectAttempts = 0;
      windowState.isReconnect = message.reconnect; // Track reconnect state
      clearConnectTimer(windowState);
      setWindowStatus(windowState, 'idle', 'Connected');
      if (windowState.term) {
        windowState.term.focus();
      }
      reportActivity(windowState, 'running');

      ptyToWindow.set(message.id, windowState.id);
      pendingPty.delete(message.clientId);
      if (pendingPtyData.has(message.id)) {
        const buffered = pendingPtyData.get(message.id);
        pendingPtyData.delete(message.id);
        if (buffered) {
          handlePtyData(buffered);
        }
      }
      if (windowState.pendingResize) {
        sendResize(windowState, windowState.pendingResize.cols, windowState.pendingResize.rows);
      } else {
        fitWindowTerminal(windowState);
      }

      const pendingInput = typeof session.pendingInput === 'string' ? session.pendingInput : '';
      if (pendingInput.length > 0) {
        session.pendingInput = '';
        vscode.postMessage({
          command: 'pty:write',
          id: windowState.currentPtyId,
          data: pendingInput
        });
      }

      flushPendingDrops(windowState);
    }

    function handlePtyData(message) {
      const windowId = ptyToWindow.get(message.id);
      const windowState = windows.get(windowId);
      if (!windowState || !windowState.term) {
        pendingPtyData.set(message.id, message);
        return;
      }

      if (message.full) {
        windowState.restoringSnapshot = true;
        windowState.pendingSnapshotData = '';
        windowState.term.reset();
        windowState.outputTail = '';
        windowState.outputTailRaw = '';
        windowState.isReconnect = false;
        noteOutput(windowState, message.data);
        writeTerminalChunked(windowState.term, message.data, () => {
          flushWindowSnapshotBuffer(windowState);
        });
        return;
      }

      if (windowState.restoringSnapshot) {
        const next = (windowState.pendingSnapshotData || '') + (message.data || '');
        windowState.pendingSnapshotData = next.length > 256000 ? next.slice(-256000) : next;
        return;
      }

      if (windowState && windowState.term) {
        windowState.term.write(message.data);
        noteOutput(windowState, message.data);
      }
    }

    function handlePtyExit(message) {
      const windowId = ptyToWindow.get(message.id);
      const windowState = windows.get(windowId);
      if (windowState) {
        clearConnectTimer(windowState);
        if (windowState.currentPtyId === message.id) {
          windowState.currentPtyId = null;
          windowState.isReady = false;
          windowState.restoringSnapshot = false;
          windowState.pendingSnapshotData = '';
          setWindowStatus(windowState, 'disconnected', 'Disconnected');
        }
        windowState.sessions.forEach((session) => {
          if (session.ptyId === message.id) {
            session.ptyId = null;
          }
        });
        reportActivity(windowState, 'idle');
      }
      ptyToWindow.delete(message.id);
    }

    function handlePtyError(message) {
      if (!message.clientId) {
        return;
      }

      const pending = pendingPty.get(message.clientId);
      if (!pending) {
        return;
      }

      const windowState = windows.get(pending.windowId);
      if (!windowState) {
        pendingPty.delete(message.clientId);
        return;
      }

      const session = windowState.sessions.find(s => s.id === pending.sessionId);
      if (session) {
        session.clientId = null;
      }

      windowState.isReady = false;
      windowState.restoringSnapshot = false;
      windowState.pendingSnapshotData = '';
      setWindowStatus(windowState, 'disconnected', 'Disconnected');
      reportActivity(windowState, 'error', 'connection');
      pendingPty.delete(message.clientId);
      attemptReconnect(windowState, 'Error: ' + message.error);
    }

    function updateProjectPreview(terminalId, output) {
      const project = projects.find(p => p.terminals && p.terminals.some(t => t.processId === terminalId));
      if (!project) return;

      if (shouldIgnoreExternalPreview(project.path)) {
        return;
      }

      const captureLines = getPreviewCaptureLineCount(project.path);
      const lines = (output || '').split('\\n').slice(-captureLines).join('\\n');
      updateProjectPreviewByPath(project.path, lines);
    }

    // Initial refresh
    vscode.postMessage({ command: 'refresh' });
  </script>
</body>
</html>`;
  }

  /**
   * Generate a nonce for CSP
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  // ==========================================
  // Public MCP API Methods for Terminal Control
  // ==========================================

  /**
   * Get all active floating window and card embedded terminals
   * Used by vscode_card_terminals_list MCP tool
   */
  public getFloatingWindowTerminals(): Array<{
    clientId: string;
    sessionName: string;
    projectPath: string;
    terminalId: number;
  }> {
    const terminals: Array<{
      clientId: string;
      sessionName: string;
      projectPath: string;
      terminalId: number;
    }> = [];

    // Get floating window terminals
    for (const [clientId, session] of this.clientSessions) {
      terminals.push({
        clientId,
        sessionName: session.sessionName,
        projectPath: session.projectPath,
        terminalId: session.terminalId,
      });
    }

    // Get card embedded terminals
    for (const [clientId, session] of this.cardClientSessions) {
      terminals.push({
        clientId,
        sessionName: session.sessionName,
        projectPath: session.projectPath,
        terminalId: session.terminalId,
      });
    }

    return terminals;
  }

  /**
   * Read output from a floating window or card terminal
   * Used by vscode_card_terminal_read MCP tool
   */
  public async readFloatingWindowOutput(clientId: string, lines: number = 100): Promise<string | null> {
    // Check floating windows first
    let session = this.clientSessions.get(clientId);

    // Then check card terminals
    if (!session) {
      session = this.cardClientSessions.get(clientId);
    }

    if (!session) {
      return null;
    }

    const tmux = TmuxManager.getInstance();
    return await tmux.readBuffer(session.sessionName, lines);
  }

  /**
   * Send text to a floating window or card terminal
   * Used by vscode_card_terminal_send MCP tool
   */
  public async sendToFloatingWindow(clientId: string, text: string, addNewLine: boolean = true): Promise<boolean> {
    // Check floating windows first
    let session = this.clientSessions.get(clientId);

    // Then check card terminals
    if (!session) {
      session = this.cardClientSessions.get(clientId);
    }

    if (!session) {
      return false;
    }

    const tmux = TmuxManager.getInstance();

    // Two-step approach for reliable submission:
    // 1. Send text without Enter (so it types the text)
    // 2. Send Enter separately (so it submits)
    // This works reliably for both regular shells and Claude Code terminals
    if (addNewLine && text.length > 0) {
      // Step 1: Send text without newline
      const textSent = await tmux.sendKeys(session.sessionName, text, false);
      if (!textSent) {
        return false;
      }
      // Small delay to ensure text is received before Enter
      await new Promise(resolve => setTimeout(resolve, 50));
      // Step 2: Send Enter to submit
      return await tmux.sendKeys(session.sessionName, '', true);
    } else if (addNewLine) {
      // Just send Enter (empty text with newline)
      return await tmux.sendKeys(session.sessionName, '', true);
    } else {
      // Just send text without Enter
      return await tmux.sendKeys(session.sessionName, text, false);
    }
  }

  /**
   * Dispose the panel
   */
  public dispose(): void {
    DashboardPanel.currentPanel = undefined;

    // Clear any pending refresh debounce timer
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = undefined;
    }

    if (this.eventRefreshTimer) {
      clearTimeout(this.eventRefreshTimer);
      this.eventRefreshTimer = undefined;
    }

    // Stop all tmux streams and clean up embedded terminal sessions
    // Note: dispose() is async but we fire-and-forget here since we can't await in dispose()
    // The streams will clean up in the background
    this.tmuxBridge.dispose().catch((err) => {
      console.error('[DashboardPanel] Error disposing tmux bridge:', err);
    });

    // Clean up all embedded terminal tmux sessions (floating windows + card terminals)
    const tmux = TmuxManager.getInstance();

    // Clean up floating window sessions
    for (const [clientId, session] of this.clientSessions) {
      tmux.killSession(session.sessionName).catch(() => {
        // Ignore errors during cleanup
      });
      this.clearQueuedInput(`pty:${clientId}`);
    }
    this.clientSessions.clear();

    // Clean up card embedded terminal sessions
    for (const [clientId, session] of this.cardClientSessions) {
      tmux.killSession(session.sessionName).catch(() => {
        // Ignore errors during cleanup
      });
      this.clearQueuedInput(`card:${clientId}`);
    }
    this.cardClientSessions.clear();
    this.cardTerminalNameIndex.clear();

    // Clean up tracked terminal associations
    // Note: We don't dispose the terminals themselves as they may still be useful
    // The user can close them manually if needed
    this.terminalClientIds.clear();

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
