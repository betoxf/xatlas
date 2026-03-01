import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

interface TmuxSessionInfo {
  sessionName: string;
  terminalName: string;
  terminalId: number;
  cwd?: string;
}

/**
 * Terminal state types for detecting what the terminal is doing
 */
export type TerminalState = 'running' | 'idle' | 'waiting_for_input' | 'unknown';

export interface TerminalStateInfo {
  state: TerminalState;
  currentCommand: string;
}

/**
 * TmuxManager - Manages tmux sessions for VS Code terminals
 *
 * This provides reliable terminal output capture by backing each VS Code terminal
 * with a tmux session. Benefits:
 * - Read last N lines from any terminal (no 50KB limit)
 * - Works in stable VS Code (no proposed APIs needed)
 * - Headless control via send-keys
 * - 50,000 line scrollback buffer
 */
export class TmuxManager {
  private static instance: TmuxManager;
  private sessions: Map<number, TmuxSessionInfo> = new Map(); // terminalId -> session info
  private sessionByName: Map<string, TmuxSessionInfo> = new Map(); // terminalName -> session info
  private workspaceHash: string;
  private tmuxAvailable: boolean | null = null;
  private userShell: string = 'bash'; // Default to bash
  private terminalIdCounter = 0;
  private refreshTrackedSessionsPromise: Promise<void> | null = null;
  private lastTrackedRefreshAt = 0;
  private trackedRefreshIntervalMs = 15000;

  private static readonly SESSION_PREFIX = 'xvsc';
  private static readonly HISTORY_LIMIT = 50000;

  private constructor() {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'default';
    this.workspaceHash = crypto.createHash('md5')
      .update(workspacePath).digest('hex').substring(0, 6);
  }

  public static getInstance(): TmuxManager {
    if (!TmuxManager.instance) {
      TmuxManager.instance = new TmuxManager();
    }
    return TmuxManager.instance;
  }

  /**
   * Check if tmux is installed and available
   */
  public async isAvailable(): Promise<boolean> {
    if (this.tmuxAvailable !== null) {
      return this.tmuxAvailable;
    }

    try {
      await execAsync('which tmux');
      this.tmuxAvailable = true;
    } catch {
      this.tmuxAvailable = false;
    }

    return this.tmuxAvailable;
  }

  /**
   * Detect the user's default shell (bash, zsh, fish, etc.)
   */
  private async detectUserShell(): Promise<string> {
    try {
      const { stdout } = await execAsync('echo $SHELL');
      const shellPath = stdout.trim();
      const shellName = shellPath.split('/').pop() || 'bash';
      this.userShell = shellName;
      return shellName;
    } catch {
      // Fallback to bash
      this.userShell = 'bash';
      return 'bash';
    }
  }

  /**
   * Get shell-appropriate initialization commands for long-running processes
   * Returns empty string to avoid polluting terminal output
   */
  private getShellInitCommands(shell: string): string {
    // We no longer send init commands via send-keys to avoid polluting output
    // Instead, we configure the session via environment variables and tmux options
    return '';
  }

  /**
   * Show notification prompting user to install tmux if not available
   * Stores dismissal state in VS Code global storage
   */
  public async showInstallNotification(storage: vscode.Memento): Promise<void> {
    const DISMISSED_KEY = 'tmux.notificationDismissed';

    // Don't show if already dismissed
    if (storage.get<boolean>(DISMISSED_KEY, false)) {
      return;
    }

    // Don't show if tmux is available
    if (await this.isAvailable()) {
      return;
    }

    const installCmd = process.platform === 'darwin'
      ? 'brew install tmux'
      : 'apt install tmux';

    const result = await vscode.window.showInformationMessage(
      `Install tmux for full terminal buffer capture (50,000 lines). Run: ${installCmd}`,
      'Open Terminal',
      "Don't show again"
    );

    if (result === "Don't show again") {
      await storage.update(DISMISSED_KEY, true);
    } else if (result === 'Open Terminal') {
      const terminal = vscode.window.createTerminal('Install tmux');
      terminal.show();
      terminal.sendText(`# Run: ${installCmd}`, false);
    }
  }

  /**
   * Get the state of a tmux session (running, idle, waiting for input)
   */
  public async getSessionState(sessionName: string): Promise<TerminalStateInfo> {
    try {
      // Get the current command running in the pane
      const { stdout: currentCmd } = await execAsync(
        `tmux list-panes -t ${sessionName} -F '#{pane_current_command}'`
      );
      const currentCommand = currentCmd.trim();

      // Shell commands indicate the terminal is at a prompt
      const shellCommands = ['bash', 'zsh', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'ksh'];
      const isAtShell = shellCommands.includes(currentCommand.toLowerCase());

      if (!isAtShell) {
        // A non-shell command is running - check if it's waiting for input
        const buffer = await this.readBuffer(sessionName, 20);
        if (this.isWaitingForInput(buffer)) {
          return { state: 'waiting_for_input', currentCommand };
        }
        return { state: 'running', currentCommand };
      }

      // At shell - check if there's a prompt (idle) or waiting for input
      const buffer = await this.readBuffer(sessionName, 5);
      const lastLine = buffer.split('\n').filter(l => l.trim()).pop() || '';

      if (this.isWaitingForInput(buffer)) {
        return { state: 'waiting_for_input', currentCommand };
      }

      if (this.isPromptLine(lastLine)) {
        return { state: 'idle', currentCommand };
      }

      // Default to running if we can't determine
      return { state: 'running', currentCommand };
    } catch (error) {
      console.error(`Error getting session state for ${sessionName}:`, error);
      return { state: 'unknown', currentCommand: '' };
    }
  }

  /**
   * Check if a line looks like a shell prompt
   */
  private isPromptLine(line: string): boolean {
    const trimmed = line.trim();
    // Common prompt endings: $, #, %, >, →
    return /[$#%>→]\s*$/.test(trimmed) || /\$\s*$/.test(trimmed);
  }

  /**
   * Check if the terminal output indicates waiting for user input
   */
  private isWaitingForInput(text: string): boolean {
    const patterns = [
      /password[:\s]*$/i,
      /passphrase[:\s]*$/i,
      /\[y\/n\][:\s]*$/i,
      /\(y\/n\)[:\s]*$/i,
      /yes\/no[:\s]*$/i,
      /press enter/i,
      /press any key/i,
      /continue\?[:\s]*$/i,
      /\[sudo\]/i,
      /are you sure\?/i,
      /confirm[:\s]*$/i,
      /enter.*:/i,
      /input.*:/i,
      /type.*to continue/i,
    ];
    return patterns.some(p => p.test(text));
  }

  /**
   * Generate unique session name for a terminal
   * Format: xvsc_{workspaceHash}_{terminalId}
   */
  private generateSessionName(terminalId: number): string {
    return `${TmuxManager.SESSION_PREFIX}_${this.workspaceHash}_${terminalId}`;
  }

  /**
   * Create a new tmux session
   */
  public async createSession(
    terminalId: number,
    terminalName: string,
    cwd?: string
  ): Promise<string> {
    const sessionName = this.generateSessionName(terminalId);
    const workDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || '/tmp';

    // Kill existing session if any (cleanup from previous crashes)
    try {
      await execAsync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
    } catch {
      // Session didn't exist, which is fine
    }

    // Detect user's shell for proper session configuration
    const userShell = await this.detectUserShell();

    // Create new session with large scrollback
    // -d: detached, -s: session name, -c: working directory
    await execAsync(`tmux new-session -d -s ${sessionName} -c "${workDir}"`);

    // Configure session + window options for long-running commands and stability.
    // Important: history-limit/remain-on-exit/rename options are WINDOW options in tmux,
    // so they must be set with set-window-option to actually apply.
    const sessionOptions = [
      `status off`,                                            // Disable status bar (cleaner for embedded)
      `set-clipboard off`,                                     // Disable clipboard (faster, less issues)
      `default-terminal "screen-256color"`,                    // Proper terminal type
      `assume-paste-time 1`,                                   // Reduce paste delays
      `destroy-unattached off`,                                // Don't kill when detached
      `mouse off`,                                             // Keep native xterm scrollback behavior
    ];
    const windowOptions = [
      `history-limit ${TmuxManager.HISTORY_LIMIT}`,            // Large scrollback buffer
      `remain-on-exit on`,                                     // Keep pane alive after process exits
      `automatic-rename off`,                                  // Don't auto-rename windows
      `allow-rename off`,                                      // Prevent external rename
    ];

    for (const option of sessionOptions) {
      try {
        await execAsync(`tmux set-option -t ${sessionName} ${option}`);
      } catch (err) {
        console.warn(`[TmuxManager] Failed to set session option "${option}":`, err);
      }
    }

    for (const option of windowOptions) {
      try {
        await execAsync(`tmux set-window-option -t ${sessionName} ${option}`);
      } catch (err) {
        console.warn(`[TmuxManager] Failed to set window option "${option}":`, err);
      }
    }

    // Persist the logical terminal name in session metadata so we can recover
    // it across extension reloads instead of falling back to pane command names.
    const escapedTerminalName = terminalName
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    try {
      await execAsync(`tmux set-option -t ${sessionName} @xvsc_terminal_name "${escapedTerminalName}"`);
    } catch {
      // Custom options may be unavailable in older tmux builds; continue with defaults.
    }

    // Track the session
    const info: TmuxSessionInfo = {
      sessionName,
      terminalName,
      terminalId,
      cwd: workDir,
    };
    this.sessions.set(terminalId, info);
    this.sessionByName.set(terminalName, info);

    return sessionName;
  }

  /**
   * Create a VS Code terminal that attaches to a tmux session
   */
  public async createTerminal(
    name: string,
    cwd?: string,
    env?: Record<string, string>
  ): Promise<{ terminal: vscode.Terminal; sessionName: string }> {
    // Use millisecond timestamp + rolling suffix to avoid session name collisions
    // when multiple terminals are created in the same millisecond.
    this.terminalIdCounter = (this.terminalIdCounter + 1) % 1000;
    const terminalId = Date.now() * 1000 + this.terminalIdCounter;
    const sessionName = await this.createSession(terminalId, name, cwd);

    // Create VS Code terminal that attaches to the tmux session
    // Use exec to directly run tmux attach without intermediate shell
    // This prevents any shell init commands from appearing in output
    const terminal = vscode.window.createTerminal({
      name,
      shellPath: 'tmux',
      shellArgs: ['attach', '-t', sessionName],
      cwd,
      env: {
        ...env,
        // Environment variables for signal protection
        HUP: 'false',
      },
    });

    // Update tracking with actual terminal reference
    const info = this.sessions.get(terminalId);
    if (info) {
      info.terminalName = terminal.name;
      this.sessionByName.set(terminal.name, info);
    }

    return { terminal, sessionName };
  }

  /**
   * Read the last N lines from a tmux session's buffer
   */
  public async readBuffer(sessionName: string, lines: number = 1000): Promise<string> {
    try {
      // capture-pane: -p prints to stdout, -e includes escape sequences, -S -N starts N lines from bottom
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${sessionName} -p -e -S -${lines}`,
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
      );
      return stdout;
    } catch (error) {
      console.error(`Error reading tmux buffer for ${sessionName}:`, error);
      return '';
    }
  }

  /**
   * Read the entire scrollback buffer
   */
  public async readFullBuffer(sessionName: string): Promise<string> {
    try {
      // -S - means start from the beginning of scrollback
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${sessionName} -p -S -`,
        { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer for full history
      );
      return stdout;
    } catch (error) {
      console.error(`Error reading full tmux buffer for ${sessionName}:`, error);
      return '';
    }
  }

  /**
   * Resize a tmux session window to match the embedded terminal dimensions
   */
  public async resizeSession(sessionName: string, cols: number, rows: number): Promise<boolean> {
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));

    if (!Number.isFinite(safeCols) || !Number.isFinite(safeRows)) {
      return false;
    }

    try {
      await execAsync(`tmux resize-window -t ${sessionName} -x ${safeCols} -y ${safeRows}`);
      return true;
    } catch (error) {
      console.error(`Error resizing tmux session ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Send keys/text to a tmux session headlessly
   */
  public async sendKeys(
    sessionName: string,
    text: string,
    enter: boolean = true
  ): Promise<boolean> {
    try {
      // Escape special characters for tmux
      const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');

      const keys = enter ? `"${escaped}" Enter` : `"${escaped}"`;
      await execAsync(`tmux send-keys -t ${sessionName} ${keys}`);
      return true;
    } catch (error) {
      console.error(`Error sending keys to ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Send a special key (like C-c, C-d, etc.)
   */
  public async sendSpecialKey(sessionName: string, key: string): Promise<boolean> {
    try {
      await execAsync(`tmux send-keys -t ${sessionName} ${key}`);
      return true;
    } catch (error) {
      console.error(`Error sending special key to ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Execute a command and wait for completion using a marker
   */
  public async executeCommand(
    sessionName: string,
    command: string,
    timeoutMs: number = 30000
  ): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
    const marker = `___TMUX_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}___`;

    // Clear the current pane history for cleaner output capture
    try {
      await execAsync(`tmux clear-history -t ${sessionName}`);
    } catch {
      // Ignore if clearing fails
    }

    // Send command with completion marker that includes exit code
    // Format: command; echo "MARKER$?"
    const fullCommand = `${command}; echo "${marker}$?"`;
    await this.sendKeys(sessionName, fullCommand, true);

    // Poll for completion marker
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const buffer = await this.readBuffer(sessionName, 5000);
      const markerIndex = buffer.indexOf(marker);

      if (markerIndex !== -1) {
        // Found marker - extract exit code and output
        const afterMarker = buffer.substring(markerIndex + marker.length);
        const exitCodeMatch = afterMarker.match(/^(\d+)/);
        const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;

        // Get output (everything before the marker line)
        const lines = buffer.split('\n');
        const markerLineIndex = lines.findIndex(line => line.includes(marker));

        // Skip the command line itself (first line after clear)
        const outputLines = lines.slice(1, markerLineIndex);
        const output = outputLines.join('\n').trim();

        return { output, exitCode, timedOut: false };
      }
    }

    // Timed out - return whatever we have
    const buffer = await this.readBuffer(sessionName, 5000);
    return { output: buffer, exitCode: -1, timedOut: true };
  }

  /**
   * Kill a tmux session
   */
  public async killSession(sessionName: string): Promise<void> {
    try {
      await execAsync(`tmux kill-session -t ${sessionName}`);
    } catch {
      // Session might not exist
    }

    // Remove from tracking
    for (const [id, info] of this.sessions) {
      if (info.sessionName === sessionName) {
        this.sessions.delete(id);
        this.sessionByName.delete(info.terminalName);
        break;
      }
    }
  }

  /**
   * Get session info by terminal ID
   */
  public getSessionByTerminalId(terminalId: number): TmuxSessionInfo | undefined {
    return this.sessions.get(terminalId);
  }

  /**
   * Get session info by terminal name
   */
  public getSessionByName(terminalName: string): TmuxSessionInfo | undefined {
    return this.sessionByName.get(terminalName);
  }

  /**
   * Get session info by tmux session name (e.g., xvsc_abc123_12345)
   */
  public getInfoBySessionName(sessionName: string): TmuxSessionInfo | undefined {
    for (const info of this.sessions.values()) {
      if (info.sessionName === sessionName) {
        return info;
      }
    }
    return undefined;
  }

  /**
   * Register an existing terminal with tmux
   * Creates a tmux session and tracks it, but doesn't modify the terminal
   * (used for terminals created outside our control)
   */
  public async registerExistingTerminal(
    terminal: vscode.Terminal,
    cwd?: string
  ): Promise<string | null> {
    const pid = await terminal.processId;
    if (!pid) return null;

    // Check if already tracked
    if (this.sessions.has(pid)) {
      return this.sessions.get(pid)!.sessionName;
    }

    // Create new session for this terminal
    const sessionName = await this.createSession(pid, terminal.name, cwd);
    return sessionName;
  }

  /**
   * Handle terminal closure - clean up associated tmux session
   */
  public async onTerminalClosed(terminal: vscode.Terminal): Promise<void> {
    const info = this.sessionByName.get(terminal.name);
    if (info) {
      await this.killSession(info.sessionName);
    }
  }

  /**
   * List all tmux sessions for this workspace
   */
  public async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
      const prefix = `${TmuxManager.SESSION_PREFIX}_${this.workspaceHash}_`;
      return stdout
        .split('\n')
        .filter(s => s.startsWith(prefix))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Rebuild in-memory session tracking from live tmux sessions.
   * This is needed after extension reloads so collaborative sessions remain discoverable.
   */
  public async refreshTrackedSessions(force: boolean = false): Promise<void> {
    if (!force) {
      if (this.refreshTrackedSessionsPromise) {
        return this.refreshTrackedSessionsPromise;
      }
      if (
        this.lastTrackedRefreshAt > 0 &&
        Date.now() - this.lastTrackedRefreshAt < this.trackedRefreshIntervalMs
      ) {
        return;
      }
    }

    const refreshPromise = this.refreshTrackedSessionsInternal();
    this.refreshTrackedSessionsPromise = refreshPromise;
    try {
      await refreshPromise;
      this.lastTrackedRefreshAt = Date.now();
    } finally {
      if (this.refreshTrackedSessionsPromise === refreshPromise) {
        this.refreshTrackedSessionsPromise = null;
      }
    }
  }

  private async refreshTrackedSessionsInternal(): Promise<void> {
    if (!(await this.isAvailable())) {
      return;
    }

    const sessions = await this.listSessions();
    const nextById = new Map<number, TmuxSessionInfo>();
    const nextByName = new Map<string, TmuxSessionInfo>();
    const sessionMeta = await this.getSessionMetadataFromPanes();

    for (const sessionName of sessions) {
      const suffix = sessionName.split('_').pop() || '';
      const parsedId = Number(suffix);
      if (!Number.isFinite(parsedId)) {
        continue;
      }

      const existing = this.sessions.get(parsedId);
      const meta = sessionMeta.get(sessionName);
      let cwd = meta?.cwd || existing?.cwd || '';
      let terminalName = existing?.terminalName || meta?.terminalName || sessionName;

      // Read persisted terminal name only for sessions we don't already know well.
      const shouldLookupPersistedName =
        !existing ||
        !existing.terminalName ||
        existing.terminalName === sessionName ||
        existing.terminalName === (meta?.terminalName || '');

      if (shouldLookupPersistedName) {
        try {
          const { stdout } = await execAsync(
            `tmux show-options -v -t ${sessionName} @xvsc_terminal_name`
          );
          const persisted = stdout.trim();
          if (persisted) {
            terminalName = persisted;
          }
        } catch {
          // No persisted terminal name for this session.
        }
      }

      const info: TmuxSessionInfo = {
        sessionName,
        terminalName: terminalName || existing?.terminalName || sessionName,
        terminalId: parsedId,
        cwd: cwd || existing?.cwd,
      };

      nextById.set(parsedId, info);
      nextByName.set(info.terminalName, info);
    }

    this.sessions = nextById;
    this.sessionByName = nextByName;
  }

  private async getSessionMetadataFromPanes(): Promise<
    Map<string, { cwd: string; terminalName: string }>
  > {
    const result = new Map<string, { cwd: string; terminalName: string }>();
    const prefix = `${TmuxManager.SESSION_PREFIX}_${this.workspaceHash}_`;

    try {
      const { stdout } = await execAsync(
        'tmux list-panes -a -F "#{session_name}|#{pane_current_path}|#{window_name}"'
      );
      const lines = stdout.split('\n').filter(Boolean);

      for (const line of lines) {
        const [sessionName, cwd, terminalName] = line.split('|');
        if (!sessionName || !sessionName.startsWith(prefix)) {
          continue;
        }
        if (result.has(sessionName)) {
          continue;
        }
        result.set(sessionName, {
          cwd: cwd || '',
          terminalName: terminalName || sessionName,
        });
      }
    } catch {
      // Keep best-effort defaults when metadata lookup fails.
    }

    return result;
  }

  /**
   * Check if a session exists
   */
  public async sessionExists(sessionName: string): Promise<boolean> {
    try {
      await execAsync(`tmux has-session -t ${sessionName}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleanup all workspace sessions
   */
  public async cleanup(): Promise<void> {
    const sessions = await this.listSessions();
    for (const session of sessions) {
      await this.killSession(session);
    }
    this.sessions.clear();
    this.sessionByName.clear();
  }

  /**
   * Get all tracked sessions
   */
  public getAllSessions(): TmuxSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Dispose the manager and clean up resources
   */
  public async dispose(): Promise<void> {
    await this.cleanup();
  }
}

// Export singleton getter
export const tmuxManager = TmuxManager.getInstance();
