import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TmuxManager } from './tmuxManager';

const execAsync = promisify(exec);

/**
 * Callbacks for stream events
 */
export interface TmuxStreamCallbacks {
  onData: (payload: { text: string; full?: boolean }) => void;
  onExit: () => void;
  onError?: (error: Error) => void;
}

interface StreamInfo {
  clientId: string;
  sessionName: string;
  callbacks: TmuxStreamCallbacks;
  pipePath: string;
  reader?: fs.ReadStream;
  rows?: number;
  cols?: number;
  isActive: boolean;
  exited: boolean;
  // Debouncing state
  pendingData: string;
  flushTimer?: NodeJS.Timeout;
}

interface PaneCursorPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * TmuxStreamBridge - Bridges tmux sessions to webviews using pipe-pane
 *
 * This provides a real-time stream of terminal output (including control sequences)
 * instead of polling capture-pane snapshots.
 */
export class TmuxStreamBridge {
  private static readonly SNAPSHOT_SCROLLBACK_LINES = 1400;
  private static readonly SNAPSHOT_MAX_RENDER_LINES = 420;
  private static readonly SNAPSHOT_MAX_CONSECUTIVE_BLANKS = 2;
  private static readonly MAX_CAPTURE_LINES = 50000;
  private static readonly CAPTURE_MAX_BUFFER = 32 * 1024 * 1024;
  private static readonly STREAM_PENDING_MAX_CHARS = 128 * 1024;
  private streams: Map<string, StreamInfo> = new Map(); // clientId -> StreamInfo
  private tmux: TmuxManager;

  constructor() {
    this.tmux = TmuxManager.getInstance();
  }

  /**
   * Start streaming output from a tmux session to the webview
   *
   * @param skipSnapshot - When true, skip sending the initial snapshot (useful for reconnecting
   *                       to an existing session where the user just saw the terminal content)
   */
  public async startStream(
    clientId: string,
    sessionName: string,
    callbacks: TmuxStreamCallbacks,
    size?: { cols?: number; rows?: number },
    skipSnapshot?: boolean
  ): Promise<void> {
    console.log(`[TmuxStreamBridge] Starting pipe stream for ${clientId} -> ${sessionName}, skipSnapshot: ${skipSnapshot}`);

    // Stop any existing stream for this client
    if (this.streams.has(clientId)) {
      await this.stopStream(clientId);
    }

    // Also stop any stream using the same session (different clientId)
    // This prevents race conditions when switching back to a previously-used terminal
    for (const [existingClientId, info] of this.streams) {
      if (info.sessionName === sessionName && existingClientId !== clientId) {
        console.log(`[TmuxStreamBridge] Stopping existing stream for same session: ${existingClientId}`);
        await this.stopStream(existingClientId);
      }
    }

    const pipePath = this.buildPipePath(clientId, sessionName);
    await this.ensurePipe(pipePath);

    const streamInfo: StreamInfo = {
      clientId,
      sessionName,
      callbacks,
      pipePath,
      rows: size?.rows,
      cols: size?.cols,
      isActive: true,
      exited: false,
      pendingData: '',
      flushTimer: undefined,
    };

    this.streams.set(clientId, streamInfo);

    await this.attachPipe(streamInfo);

    // Only send snapshot for new sessions, not reconnections
    // When reconnecting, the tmux session content is unchanged and pipe-pane will stream new output
    if (!skipSnapshot) {
      await this.sendSnapshot(streamInfo);
    }

    console.log(`[TmuxStreamBridge] Pipe stream started for ${clientId}`);
  }

  /**
   * Stop streaming for a client
   */
  public async stopStream(clientId: string): Promise<void> {
    const streamInfo = this.streams.get(clientId);
    if (!streamInfo) {
      return;
    }

    streamInfo.isActive = false;

    // Clear any pending flush timer
    if (streamInfo.flushTimer) {
      clearTimeout(streamInfo.flushTimer);
      streamInfo.flushTimer = undefined;
    }

    // Flush any remaining data before closing
    if (streamInfo.pendingData) {
      try {
        streamInfo.callbacks.onData({ text: streamInfo.pendingData });
      } catch {
        // Ignore errors during final flush
      }
      streamInfo.pendingData = '';
    }

    try {
      await execAsync(`tmux pipe-pane -t ${this.shellEscape(streamInfo.sessionName)}`);
    } catch {
      // Ignore errors when tearing down
    }

    if (streamInfo.reader) {
      streamInfo.reader.removeAllListeners();
      streamInfo.reader.destroy();
      streamInfo.reader = undefined;
    }

    this.safeUnlink(streamInfo.pipePath);
    this.streams.delete(clientId);
  }

  /**
   * Stop all active streams
   */
  public async stopAllStreams(): Promise<void> {
    const clientIds = Array.from(this.streams.keys());
    for (const clientId of clientIds) {
      await this.stopStream(clientId);
    }
  }

  /**
   * Update size for a stream.
   */
  public updateSize(clientId: string, cols?: number, rows?: number): void {
    const streamInfo = this.streams.get(clientId);
    if (!streamInfo) {
      return;
    }

    if (typeof cols === 'number' && Number.isFinite(cols) && cols > 0) {
      streamInfo.cols = Math.floor(cols);
    }
    if (typeof rows === 'number' && Number.isFinite(rows) && rows > 0) {
      streamInfo.rows = Math.floor(rows);
    }
  }

  /**
   * Get the session name for a client
   */
  public getSessionName(clientId: string): string | undefined {
    return this.streams.get(clientId)?.sessionName;
  }

  /**
   * Dispose the bridge and stop all streams
   */
  public async dispose(): Promise<void> {
    await this.stopAllStreams();
  }

  private async attachPipe(streamInfo: StreamInfo): Promise<void> {
    const pipeCmd = `tmux pipe-pane -o -t ${this.shellEscape(streamInfo.sessionName)} "cat > ${this.shellEscape(streamInfo.pipePath)}"`;
    await execAsync(pipeCmd);

    const reader = fs.createReadStream(streamInfo.pipePath, { encoding: 'utf8' });
    streamInfo.reader = reader;

    // Debounce data sending - batch chunks together to reduce UI thrash.
    const FLUSH_INTERVAL_MS = 80;

    reader.on('data', (chunk: string | Buffer) => {
      if (!streamInfo.isActive || !chunk) {
        return;
      }

      // Convert Buffer to string if needed
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      // Accumulate data
      streamInfo.pendingData += text;
      if (streamInfo.pendingData.length > TmuxStreamBridge.STREAM_PENDING_MAX_CHARS) {
        // Keep tail to preserve latest prompt/cursor updates when output floods.
        streamInfo.pendingData =
          streamInfo.pendingData.slice(-TmuxStreamBridge.STREAM_PENDING_MAX_CHARS);
      }

      // Schedule flush if not already scheduled
      if (!streamInfo.flushTimer) {
        streamInfo.flushTimer = setTimeout(() => {
          if (streamInfo.isActive && streamInfo.pendingData) {
            streamInfo.callbacks.onData({ text: streamInfo.pendingData });
            streamInfo.pendingData = '';
          }
          streamInfo.flushTimer = undefined;
        }, FLUSH_INTERVAL_MS);
      }
    });

    reader.on('error', (error) => {
      if (!streamInfo.isActive) return;
      if (streamInfo.callbacks.onError) {
        streamInfo.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const handleEnd = () => {
      if (!streamInfo.isActive || streamInfo.exited) return;
      streamInfo.exited = true;
      streamInfo.callbacks.onExit();
    };
    reader.on('end', handleEnd);
    reader.on('close', handleEnd);
  }

  private async sendSnapshot(streamInfo: StreamInfo): Promise<void> {
    if (!streamInfo.isActive) return;

    const [snapshot, pendingPrefix, cursor] = await Promise.all([
      this.capturePaneWithHistory(
        streamInfo.sessionName,
        TmuxStreamBridge.SNAPSHOT_SCROLLBACK_LINES
      ),
      this.captureIncompleteEscapePrefix(streamInfo.sessionName),
      this.getPaneCursorPosition(streamInfo.sessionName),
    ]);

    if (snapshot) {
      let normalized = this.normalizeSnapshot(snapshot);

      // Restore parser state if tmux currently has an incomplete escape sequence.
      // Without this, the remainder delivered by pipe-pane can be interpreted as
      // plain text and cause cursor/prompt desync.
      if (pendingPrefix) {
        normalized += pendingPrefix;
      }

      // Force cursor position to tmux's current cursor coordinates so typing
      // resumes on the same logical row/column as the pane.
      if (cursor) {
        const row = Math.max(1, Math.min(cursor.height || 1, cursor.y + 1));
        const col = Math.max(1, Math.min(cursor.width || 1, cursor.x + 1));
        normalized += `\x1b[${row};${col}H`;
      }

      // For reconnect/open flows we want scrollback restoration. Sending pane history
      // directly gives xterm real scroll depth per terminal tab.
      streamInfo.callbacks.onData({ text: normalized, full: true });
    }
  }

  private async captureIncompleteEscapePrefix(sessionName: string): Promise<string> {
    const target = this.shellEscape(sessionName);
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${target} -p -P`,
        { maxBuffer: 64 * 1024 }
      );
      return stdout || '';
    } catch {
      return '';
    }
  }

  private async getPaneCursorPosition(sessionName: string): Promise<PaneCursorPosition | null> {
    const target = this.shellEscape(sessionName);
    try {
      const { stdout } = await execAsync(
        `tmux list-panes -t ${target} -F '#{cursor_x},#{cursor_y},#{pane_width},#{pane_height}'`,
        { maxBuffer: 16 * 1024 }
      );
      const first = (stdout || '').split('\n').find(Boolean);
      if (!first) {
        return null;
      }

      const [xRaw, yRaw, wRaw, hRaw] = first.split(',');
      const x = Number.parseInt(xRaw || '', 10);
      const y = Number.parseInt(yRaw || '', 10);
      const width = Number.parseInt(wRaw || '', 10);
      const height = Number.parseInt(hRaw || '', 10);
      if (![x, y, width, height].every((n) => Number.isFinite(n))) {
        return null;
      }

      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  private normalizeSnapshot(snapshot: string): string {
    let normalized = snapshot.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Trim one trailing newline emitted by capture-pane.
    if (normalized.endsWith('\n')) {
      normalized = normalized.slice(0, -1);
    }

    // Remove trailing blank rows so prompt and cursor don't appear separated
    // when restoring into xterm.
    const lines = normalized.split('\n');
    while (lines.length > 0 && this.isEffectivelyBlankLine(lines[lines.length - 1])) {
      lines.pop();
    }

    const collapsed = this.collapseBlankRuns(
      lines,
      TmuxStreamBridge.SNAPSHOT_MAX_CONSECUTIVE_BLANKS
    );

    if (collapsed.length > TmuxStreamBridge.SNAPSHOT_MAX_RENDER_LINES) {
      return collapsed
        .slice(collapsed.length - TmuxStreamBridge.SNAPSHOT_MAX_RENDER_LINES)
        .join('\n');
    }

    return collapsed.join('\n');
  }

  private isEffectivelyBlankLine(line: string): boolean {
    if (!line) {
      return true;
    }
    const withoutAnsi = this.stripAnsi(line);
    return withoutAnsi.trim().length === 0;
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
  }

  private collapseBlankRuns(lines: string[], maxConsecutiveBlanks: number): string[] {
    const output: string[] = [];
    let blankRun = 0;

    for (const line of lines) {
      if (this.isEffectivelyBlankLine(line)) {
        blankRun += 1;
        if (blankRun <= maxConsecutiveBlanks) {
          output.push('');
        }
      } else {
        blankRun = 0;
        output.push(line);
      }
    }

    return output;
  }

  /**
   * Capture pane content with history so xterm can restore per-terminal scrollback
   * when a card/window is opened or reattached.
   */
  private async capturePaneWithHistory(sessionName: string, lines: number): Promise<string> {
    const target = this.shellEscape(sessionName);
    const safeLines = Math.max(200, Math.min(Math.floor(lines), TmuxStreamBridge.MAX_CAPTURE_LINES));

    // Prefer alternate-screen capture when available. This avoids restoring stale
    // primary-screen prompts while the real app is in the alternate screen.
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${target} -a -p -q -J`,
        { maxBuffer: TmuxStreamBridge.CAPTURE_MAX_BUFFER }
      );
      if (stdout && stdout.trim().length > 0) {
        return stdout;
      }
    } catch {
      // Fall back to primary screen capture.
    }

    try {
      const { stdout } = await execAsync(
        // Do not use -e here: escape/control sequences in snapshots can move the
        // cursor to a different row than the visible prompt, which makes typing
        // appear detached from the cwd/prompt line after restore.
        `tmux capture-pane -t ${target} -p -J -S -${safeLines}`,
        { maxBuffer: TmuxStreamBridge.CAPTURE_MAX_BUFFER }
      );
      return stdout;
    } catch {
      try {
        const { stdout } = await execAsync(
          `tmux capture-pane -t ${target} -p -S -${safeLines}`,
          { maxBuffer: TmuxStreamBridge.CAPTURE_MAX_BUFFER }
        );
        return stdout;
      } catch {
        return '';
      }
    }
  }

  private buildPipePath(clientId: string, sessionName: string): string {
    const safeClient = clientId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(os.tmpdir(), `xvsc-${safeSession}-${safeClient}.pipe`);
  }

  private async ensurePipe(pipePath: string): Promise<void> {
    this.safeUnlink(pipePath);
    await execAsync(`mkfifo ${this.shellEscape(pipePath)}`);
  }

  private safeUnlink(pipePath: string): void {
    try {
      if (fs.existsSync(pipePath)) {
        fs.unlinkSync(pipePath);
      }
    } catch {
      // Ignore
    }
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
}
