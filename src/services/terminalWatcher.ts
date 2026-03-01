import * as vscode from 'vscode';
import { TmuxManager, TerminalState } from './tmuxManager';

// Re-export TerminalState for use by other modules
export { TerminalState } from './tmuxManager';

/**
 * Agent detection patterns
 */
export const AGENT_PATTERNS = {
  claude: {
    commands: ['claude', 'cc', 'claude-code'],
    processes: ['claude', 'anthropic'],
    color: '#ff6b00',
    name: 'Claude Code',
  },
  zai: {
    commands: ['zai', 'zed-ai', 'z ai'],
    processes: ['zai', 'zed'],
    color: '#0ea5e9',
    name: 'Zed AI',
  },
  opencode: {
    commands: ['opencode', 'oc'],
    processes: ['opencode'],
    color: '#22c55e',
    name: 'OpenCode',
  },
  cline: {
    commands: ['cline'],
    processes: ['cline'],
    color: '#a855f7',
    name: 'Cline',
  },
  aider: {
    commands: ['aider'],
    processes: ['aider'],
    color: '#eab308',
    name: 'Aider',
  },
} as const;

export type AgentType = keyof typeof AGENT_PATTERNS | 'generic';

/**
 * Represents a command sent to a terminal (the "conversation" history)
 */
export interface TerminalCommand {
  id: string;
  command: string;
  timestamp: number;
  source: 'mcp' | 'user' | 'unknown'; // who sent the command
  output?: string; // captured output (if available)
  exitCode?: number;
  duration?: number; // milliseconds
  status: 'pending' | 'completed' | 'error';
}

export interface TerminalInfo {
  id: number; // process ID
  name: string;
  terminal: vscode.Terminal;
  agentType: AgentType;
  isActive: boolean;
  lastOutput: string;
  lastOutputAt: number; // timestamp of last output
  cwd?: string;
  tmuxSession?: string; // tmux session name if backed by tmux
  state: TerminalState; // running, idle, waiting_for_input, unknown
  currentCommand?: string; // the current process running in the terminal
  projectPath?: string; // associated project path
  createdByMcp: boolean; // whether this terminal was created via MCP (AI)
  commandHistory: TerminalCommand[]; // history of commands sent to this terminal
}

/**
 * Watches terminal activity and captures output
 */
export class TerminalWatcher {
  private static instance: TerminalWatcher;
  private terminals = new Map<number, TerminalInfo>();
  private outputBuffers = new Map<number, string>();
  private terminalPidCache = new WeakMap<vscode.Terminal, number>();
  private pendingPidLookups = new WeakMap<vscode.Terminal, Promise<number | undefined>>();
  private terminalProjects = new Map<number, string>(); // pid -> projectPath
  private pendingMcpFlags = new Set<number>(); // PIDs to mark as MCP-created when registered
  private pendingTmuxSessions = new Map<number, string>(); // PIDs to set tmux session when registered
  private disposables: vscode.Disposable[] = [];
  private bufferCaptureEnabled = false;

  private static readonly MAX_BUFFER_SIZE = 50000;
  private static readonly MAX_PREVIEW_LINES = 10;

  private constructor() {
    this.initialize();
  }

  public static getInstance(): TerminalWatcher {
    if (!TerminalWatcher.instance) {
      TerminalWatcher.instance = new TerminalWatcher();
    }
    return TerminalWatcher.instance;
  }

  private initialize(): void {
    // Initialize output capture using proposed API
    this.initOutputCapture();

    // Track existing terminals
    vscode.window.terminals.forEach((terminal) => {
      this.registerTerminal(terminal);
    });

    // Track new terminals
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this.registerTerminal(terminal);
      })
    );

    // Cleanup closed terminals
    this.disposables.push(
      vscode.window.onDidCloseTerminal(async (terminal) => {
        const pid = await terminal.processId;
        if (pid) {
          this.terminals.delete(pid);
          this.outputBuffers.delete(pid);
        }
        this.terminalPidCache.delete(terminal);
        this.pendingPidLookups.delete(terminal);
      })
    );

    // Track terminal focus changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        // Update active state for all terminals
        this.terminals.forEach((info) => {
          info.isActive = info.terminal === terminal;
        });
      })
    );
  }

  /**
   * Initialize terminal output capture using proposed API
   */
  private initOutputCapture(): void {
    const enabledProposals = vscode.extensions
      .getExtension('iprado.vscode-mcp-server')
      ?.packageJSON?.enabledApiProposals as string[] | undefined;

    if (!enabledProposals || !enabledProposals.includes('terminalDataWriteEvent')) {
      return;
    }

    let onDidWriteTerminalData: vscode.Event<{ terminal: vscode.Terminal; data: string }> | undefined;
    try {
      const windowAny = vscode.window as typeof vscode.window & {
        onDidWriteTerminalData?: vscode.Event<{ terminal: vscode.Terminal; data: string }>;
      };
      onDidWriteTerminalData = windowAny.onDidWriteTerminalData;
    } catch {
      return;
    }

    if (!onDidWriteTerminalData) {
      return;
    }

    try {
      this.disposables.push(
        onDidWriteTerminalData((event) => {
          const terminal = event.terminal;
          const cachedPid = this.terminalPidCache.get(terminal);
          if (cachedPid) {
            this.recordTerminalOutput(cachedPid, event.data);
            return;
          }

          void this.resolveTerminalPid(terminal).then((pid) => {
            if (!pid) {
              return;
            }
            this.recordTerminalOutput(pid, event.data);
          });
        })
      );

      this.bufferCaptureEnabled = true;
    } catch {
      this.bufferCaptureEnabled = false;
    }
  }

  private async resolveTerminalPid(terminal: vscode.Terminal): Promise<number | undefined> {
    const cached = this.terminalPidCache.get(terminal);
    if (cached) {
      return cached;
    }

    const pending = this.pendingPidLookups.get(terminal);
    if (pending) {
      return pending;
    }

    const lookup = terminal.processId
      .then((pid) => {
        if (pid) {
          this.terminalPidCache.set(terminal, pid);
        }
        return pid;
      })
      .finally(() => {
        this.pendingPidLookups.delete(terminal);
      });

    this.pendingPidLookups.set(terminal, lookup);
    return lookup;
  }

  private recordTerminalOutput(pid: number, chunk: string): void {
    if (!chunk) {
      return;
    }

    const existing = this.outputBuffers.get(pid) || '';
    const merged = existing + chunk;
    const trimmed =
      merged.length > TerminalWatcher.MAX_BUFFER_SIZE
        ? merged.slice(-TerminalWatcher.MAX_BUFFER_SIZE)
        : merged;
    this.outputBuffers.set(pid, trimmed);

    const info = this.terminals.get(pid);
    if (!info) {
      return;
    }

    info.lastOutput = this.updatePreviewLines(info.lastOutput, chunk, TerminalWatcher.MAX_PREVIEW_LINES);
    info.lastOutputAt = Date.now();
    this.detectAgentFromOutput(pid, chunk);
  }

  private updatePreviewLines(previous: string, delta: string, lines: number): string {
    const combined = previous ? `${previous}${delta}` : delta;
    return this.getLastLines(combined, lines);
  }

  /**
   * Register a terminal for watching
   */
  private async registerTerminal(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    if (!pid) return;
    this.terminalPidCache.set(terminal, pid);

    const cwd = this.getTerminalCwd(terminal);

    const info: TerminalInfo = {
      id: pid,
      name: terminal.name,
      terminal,
      agentType: this.detectAgentFromName(terminal.name),
      isActive: terminal === vscode.window.activeTerminal,
      lastOutput: '',
      lastOutputAt: 0,
      cwd,
      state: 'unknown',
      createdByMcp: false, // default, can be set later
      commandHistory: [],
    };

    this.terminals.set(pid, info);
    this.outputBuffers.set(pid, '');

    // Apply any pending flags that were set before terminal registered
    if (this.pendingMcpFlags.has(pid)) {
      info.createdByMcp = true;
      this.pendingMcpFlags.delete(pid);
    }
    if (this.pendingTmuxSessions.has(pid)) {
      info.tmuxSession = this.pendingTmuxSessions.get(pid);
      this.pendingTmuxSessions.delete(pid);
    }
  }

  private getTerminalCwd(terminal: vscode.Terminal): string | undefined {
    const options = terminal.creationOptions as
      | vscode.TerminalOptions
      | vscode.ExtensionTerminalOptions
      | undefined;

    if (!options || !('cwd' in options)) {
      return undefined;
    }

    const cwd = options.cwd as string | vscode.Uri | undefined;
    if (!cwd) {
      return undefined;
    }

    if (typeof cwd === 'string') {
      return cwd;
    }

    const uri = cwd as vscode.Uri;
    return typeof uri.fsPath === 'string' ? uri.fsPath : undefined;
  }

  /**
   * Detect agent type from terminal name
   */
  private detectAgentFromName(name: string): AgentType {
    const lowerName = name.toLowerCase();

    for (const [type, pattern] of Object.entries(AGENT_PATTERNS)) {
      for (const cmd of pattern.commands) {
        if (lowerName.includes(cmd)) {
          return type as AgentType;
        }
      }
    }

    return 'generic';
  }

  /**
   * Detect agent type from terminal output
   */
  private detectAgentFromOutput(pid: number, output: string): void {
    const lowerOutput = output.toLowerCase();
    const info = this.terminals.get(pid);
    if (!info || info.agentType !== 'generic') return;

    // Check for agent signatures in output
    if (lowerOutput.includes('claude') || lowerOutput.includes('anthropic')) {
      info.agentType = 'claude';
    } else if (lowerOutput.includes('zed ai') || lowerOutput.includes('zai')) {
      info.agentType = 'zai';
    } else if (lowerOutput.includes('opencode')) {
      info.agentType = 'opencode';
    } else if (lowerOutput.includes('cline')) {
      info.agentType = 'cline';
    } else if (lowerOutput.includes('aider')) {
      info.agentType = 'aider';
    }
  }

  /**
   * Get the last N lines from a string
   * Preserves ANSI escape codes for color rendering in dashboard
   */
  private getLastLines(text: string, lines: number): string {
    if (!text || lines <= 0) {
      return '';
    }

    let seen = 0;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      if (text.charCodeAt(i) === 10) {
        seen += 1;
        if (seen >= lines) {
          return text.slice(i + 1);
        }
      }
    }

    return text;
  }

  /**
   * Strip ANSI escape codes from text
   */
  private stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  /**
   * Get all tracked terminals
   */
  public getTerminals(): TerminalInfo[] {
    return Array.from(this.terminals.values());
  }

  /**
   * Get terminal info by process ID
   */
  public getTerminal(pid: number): TerminalInfo | undefined {
    return this.terminals.get(pid);
  }

  /**
   * Refresh state for all terminals with tmux sessions
   */
  public async refreshStates(): Promise<void> {
    const tmux = TmuxManager.getInstance();
    const tmuxAvailable = await tmux.isAvailable();

    for (const [pid, info] of this.terminals) {
      if (info.tmuxSession && tmuxAvailable) {
        // Use tmux to get accurate state
        try {
          const stateInfo = await tmux.getSessionState(info.tmuxSession);
          info.state = stateInfo.state;
          info.currentCommand = stateInfo.currentCommand;
        } catch {
          info.state = 'unknown';
        }
      } else {
        // Infer state from last output patterns for non-tmux terminals
        info.state = this.inferStateFromOutput(info.lastOutput);
      }
    }
  }

  /**
   * Get the state of a single terminal
   */
  public async getTerminalState(pid: number): Promise<TerminalState> {
    const info = this.terminals.get(pid);
    if (!info) return 'unknown';

    if (info.tmuxSession) {
      const tmux = TmuxManager.getInstance();
      try {
        const stateInfo = await tmux.getSessionState(info.tmuxSession);
        info.state = stateInfo.state;
        info.currentCommand = stateInfo.currentCommand;
        return stateInfo.state;
      } catch {
        return 'unknown';
      }
    }

    return this.inferStateFromOutput(info.lastOutput);
  }

  /**
   * Infer terminal state from output patterns (fallback for non-tmux terminals)
   */
  private inferStateFromOutput(output: string): TerminalState {
    if (!output) return 'unknown';

    const lines = output.split('\n');
    const lastLine = lines.filter(l => l.trim()).pop() || '';
    const lowerOutput = output.toLowerCase();

    // Check for waiting-for-input patterns
    const waitingPatterns = [
      /password[:\s]*$/i,
      /\[y\/n\][:\s]*$/i,
      /\(y\/n\)[:\s]*$/i,
      /press enter/i,
      /continue\?/i,
      /\[sudo\]/i,
    ];
    if (waitingPatterns.some(p => p.test(lowerOutput))) {
      return 'waiting_for_input';
    }

    // Check for prompt patterns (idle)
    if (/[$#%>→]\s*$/.test(lastLine.trim())) {
      return 'idle';
    }

    // Default to running if we have recent output
    return 'running';
  }

  /**
   * Get terminal output buffer
   * Uses tmux if available, otherwise falls back to captured buffer
   */
  public async getOutput(pid: number, stripAnsi = true, lines?: number): Promise<string> {
    const info = this.terminals.get(pid);

    // If terminal has a tmux session, use it for output capture
    if (info?.tmuxSession) {
      const tmux = TmuxManager.getInstance();
      const output = await tmux.readBuffer(info.tmuxSession, lines || 1000);
      return stripAnsi ? this.stripAnsi(output) : output;
    }

    // Fall back to captured buffer
    const output = this.outputBuffers.get(pid) || '';
    return stripAnsi ? this.stripAnsi(output) : output;
  }

  /**
   * Get terminal output buffer (sync version for backwards compatibility)
   */
  public getOutputSync(pid: number, stripAnsi = true): string {
    const output = this.outputBuffers.get(pid) || '';
    return stripAnsi ? this.stripAnsi(output) : output;
  }

  /**
   * Get last N lines of output
   */
  public async getLastOutput(pid: number, lines = 50): Promise<string> {
    const info = this.terminals.get(pid);

    // If terminal has a tmux session, use it for output capture
    if (info?.tmuxSession) {
      const tmux = TmuxManager.getInstance();
      const output = await tmux.readBuffer(info.tmuxSession, lines);
      return this.stripAnsi(output);
    }

    // Fall back to captured buffer
    const output = this.getOutputSync(pid);
    return this.getLastLines(output, lines);
  }

  /**
   * Check if output capture is available (via proposed API or tmux)
   */
  public isOutputCaptureEnabled(): boolean {
    return this.bufferCaptureEnabled;
  }

  /**
   * Check if tmux-based capture is available for a terminal
   */
  public hasTmuxSession(pid: number): boolean {
    const info = this.terminals.get(pid);
    return !!info?.tmuxSession;
  }

  /**
   * Set tmux session for a terminal
   * If terminal isn't registered yet, stores in pending map to apply later
   */
  public setTmuxSession(pid: number, sessionName: string): void {
    const info = this.terminals.get(pid);
    if (info) {
      info.tmuxSession = sessionName;
    } else {
      // Terminal not registered yet, store for later
      this.pendingTmuxSessions.set(pid, sessionName);
    }
  }

  /**
   * Get tmux session name for a terminal
   */
  public getTmuxSession(pid: number): string | undefined {
    return this.terminals.get(pid)?.tmuxSession;
  }

  /**
   * Set project path for a terminal
   */
  public setTerminalProject(pid: number, projectPath: string): void {
    this.terminalProjects.set(pid, projectPath);
    const info = this.terminals.get(pid);
    if (info) {
      info.projectPath = projectPath;
    }
  }

  /**
   * Get project path for a terminal
   */
  public getTerminalProject(pid: number): string | undefined {
    return this.terminalProjects.get(pid) || this.terminals.get(pid)?.projectPath;
  }

  /**
   * Mark a terminal as created by MCP (AI)
   * If terminal isn't registered yet, stores in pending set to apply later
   */
  public setCreatedByMcp(pid: number, createdByMcp: boolean = true): void {
    const info = this.terminals.get(pid);
    if (info) {
      info.createdByMcp = createdByMcp;
    } else if (createdByMcp) {
      // Terminal not registered yet, store for later
      this.pendingMcpFlags.add(pid);
    }
  }

  /**
   * Check if terminal was created by MCP
   */
  public isCreatedByMcp(pid: number): boolean {
    return this.terminals.get(pid)?.createdByMcp || false;
  }

  /**
   * Record a command sent to a terminal
   */
  public recordCommand(
    pid: number,
    command: string,
    source: 'mcp' | 'user' | 'unknown' = 'unknown'
  ): string {
    const info = this.terminals.get(pid);
    if (!info) return '';

    const id = `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const entry: TerminalCommand = {
      id,
      command,
      timestamp: Date.now(),
      source,
      status: 'pending',
    };

    info.commandHistory.push(entry);

    // Keep last 100 commands per terminal
    if (info.commandHistory.length > 100) {
      info.commandHistory = info.commandHistory.slice(-100);
    }

    return id;
  }

  /**
   * Update command completion status
   */
  public completeCommand(
    pid: number,
    commandId: string,
    output?: string,
    exitCode?: number,
    error?: boolean
  ): void {
    const info = this.terminals.get(pid);
    if (!info) return;

    const command = info.commandHistory.find(c => c.id === commandId);
    if (command) {
      command.status = error ? 'error' : 'completed';
      command.output = output;
      command.exitCode = exitCode;
      command.duration = Date.now() - command.timestamp;
    }
  }

  /**
   * Get command history for a terminal
   */
  public getCommandHistory(pid: number, limit = 50): TerminalCommand[] {
    const info = this.terminals.get(pid);
    if (!info) return [];
    return info.commandHistory.slice(-limit);
  }

  /**
   * Get all MCP-created terminals
   */
  public getMcpCreatedTerminals(): TerminalInfo[] {
    return Array.from(this.terminals.values()).filter(t => t.createdByMcp);
  }

  /**
   * Get all terminals for a project
   */
  public getTerminalsForProject(projectPath: string): TerminalInfo[] {
    const result: TerminalInfo[] = [];
    for (const [pid, info] of this.terminals) {
      const terminalProject = this.terminalProjects.get(pid) || info.projectPath || info.cwd;
      if (terminalProject && terminalProject.startsWith(projectPath)) {
        result.push(info);
      }
    }
    return result;
  }

  /**
   * Group terminals by workspace/project
   */
  public groupByProject(): Map<string, TerminalInfo[]> {
    const groups = new Map<string, TerminalInfo[]>();

    // Use the workspace folder as the project identifier
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const defaultProject = workspaceFolders?.[0]?.name || 'Default';
    const defaultPath = workspaceFolders?.[0]?.uri.fsPath || '';

    this.terminals.forEach((info) => {
      // For now, group all terminals under the default project
      // In a more advanced version, we could try to determine the CWD
      const key = defaultPath || defaultProject;
      const existing = groups.get(key) || [];
      existing.push(info);
      groups.set(key, existing);
    });

    return groups;
  }

  /**
   * Send text to a terminal
   */
  public sendText(pid: number, text: string, addNewLine = true): boolean {
    const info = this.terminals.get(pid);
    if (!info) return false;

    info.terminal.sendText(text, addNewLine);
    return true;
  }

  /**
   * Show a terminal
   */
  public showTerminal(pid: number): boolean {
    const info = this.terminals.get(pid);
    if (!info) return false;

    info.terminal.show();
    return true;
  }

  /**
   * Dispose all watchers
   */
  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.terminals.clear();
    this.outputBuffers.clear();
    this.terminalProjects.clear();
  }
}
