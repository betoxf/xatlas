import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';

export interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  cwd: string;
}

export interface PtyManagerOptions {
  shell?: string;
  env?: { [key: string]: string };
}

/**
 * @deprecated Use TmuxManager instead for terminal management.
 *
 * PtyManager was used for embedded PTY terminals in the dashboard webview.
 * As part of the unification effort, dashboard terminals now use VS Code
 * terminals with tmux backend (same as MCP tools) for headless control.
 *
 * Benefits of TmuxManager over PtyManager:
 * - 50,000 line scrollback buffer (vs limited buffer)
 * - Headless control via MCP tools
 * - Same terminal accessible from both dashboard and VS Code panel
 * - Unified terminal management across the extension
 *
 * Migration:
 * - Replace PtyManager.spawn() with TmuxManager.createTerminal()
 * - Replace PtyManager.write() with TmuxManager.sendKeys()
 * - Replace buffer reading with TmuxManager.readBuffer()
 *
 * This class is kept for backwards compatibility but should not be used
 * for new code.
 */
export class PtyManager {
  private static instance: PtyManager;
  private sessions: Map<string, PtySession> = new Map();
  private idCounter: number = 0;
  private spawnHelperChecked = false;
  private nodePtyRoot?: string;

  private constructor() {}

  public static getInstance(): PtyManager {
    if (!PtyManager.instance) {
      PtyManager.instance = new PtyManager();
    }
    return PtyManager.instance;
  }

  /**
   * Get the default shell for the current platform
   */
  private getDefaultShell(): string {
    if (os.platform() === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  private getNodePtyRoot(): string | undefined {
    if (this.nodePtyRoot) {
      return this.nodePtyRoot;
    }

    try {
      const resolved = require.resolve('node-pty');
      this.nodePtyRoot = path.dirname(path.dirname(resolved));
      return this.nodePtyRoot;
    } catch {
      return undefined;
    }
  }

  private ensureSpawnHelperPermissions(): void {
    if (this.spawnHelperChecked || os.platform() === 'win32') {
      return;
    }

    this.spawnHelperChecked = true;
    const root = this.getNodePtyRoot();
    if (!root) {
      return;
    }

    const prebuildsPath = path.join(root, 'prebuilds');
    if (!fs.existsSync(prebuildsPath)) {
      return;
    }

    try {
      const entries = fs.readdirSync(prebuildsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const helperPath = path.join(prebuildsPath, entry.name, 'spawn-helper');
        if (!fs.existsSync(helperPath)) continue;
        const stat = fs.statSync(helperPath);
        if ((stat.mode & 0o111) === 0) {
          fs.chmodSync(helperPath, 0o755);
        }
      }
    } catch {
      // Ignore permission errors; spawn will surface failures if any.
    }
  }

  /**
   * Resolve a usable shell path with fallbacks.
   */
  private resolveShell(preferred?: string): string {
    if (os.platform() === 'win32') {
      return preferred || process.env.COMSPEC || 'cmd.exe';
    }

    const candidates = [
      preferred,
      process.env.SHELL,
      '/bin/zsh',
      '/bin/bash',
      '/bin/sh',
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return '/bin/sh';
  }

  /**
   * Ensure the cwd exists; fall back to home or process cwd.
   */
  private resolveCwd(cwd: string): string {
    if (cwd && fs.existsSync(cwd)) {
      return cwd;
    }

    const home = os.homedir();
    if (home && fs.existsSync(home)) {
      return home;
    }

    return process.cwd();
  }

  /**
   * Spawn a new PTY process
   */
  public spawn(
    cwd: string,
    cols: number = 80,
    rows: number = 24,
    options?: PtyManagerOptions
  ): PtySession {
    const id = `pty-${++this.idCounter}`;
    const shell = this.resolveShell(options?.shell || this.getDefaultShell());
    const resolvedCwd = this.resolveCwd(cwd);

    this.ensureSpawnHelperPermissions();

    // Prepare environment
    const env = {
      ...process.env,
      ...options?.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as { [key: string]: string };

    // Shell arguments (use login shell for proper initialization)
    const shellArgs: string[] = os.platform() === 'win32' ? [] : ['-l'];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolvedCwd,
      env,
    });

    const session: PtySession = {
      id,
      ptyProcess,
      cwd: resolvedCwd,
    };

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Write data to a PTY process
   */
  public write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.ptyProcess.write(data);
    return true;
  }

  /**
   * Register a callback for PTY output
   */
  public onData(id: string, callback: (data: string) => void): void {
    const session = this.sessions.get(id);
    if (session) {
      session.ptyProcess.onData(callback);
    }
  }

  /**
   * Register a callback for PTY exit
   */
  public onExit(id: string, callback: (exitCode: number, signal?: number) => void): void {
    const session = this.sessions.get(id);
    if (session) {
      session.ptyProcess.onExit(({ exitCode, signal }) => {
        callback(exitCode, signal);
        // Clean up when process exits
        this.sessions.delete(id);
      });
    }
  }

  /**
   * Resize a PTY process
   */
  public resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.ptyProcess.resize(cols, rows);
    return true;
  }

  /**
   * Kill a PTY process
   */
  public kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.ptyProcess.kill();
    this.sessions.delete(id);
    return true;
  }

  /**
   * Get a PTY session by ID
   */
  public getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Get all active PTY sessions
   */
  public getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Kill all PTY processes and clean up
   */
  public dispose(): void {
    this.sessions.forEach((session) => {
      try {
        session.ptyProcess.kill();
      } catch {
        // Ignore errors during cleanup
      }
    });
    this.sessions.clear();
  }
}
