import { TmuxManager } from './tmuxManager';
import { TmuxStreamBridge, TmuxStreamCallbacks } from './tmuxStreamBridge';

export type EmbeddedSessionState = 'creating' | 'streaming' | 'resizing' | 'closed';

export interface EmbeddedSessionDescriptor {
  clientId: string;
  sessionName: string;
  projectPath: string;
  terminalId: number;
}

export class EmbeddedTerminalSession {
  public state: EmbeddedSessionState = 'creating';
  public readonly clientId: string;
  public readonly sessionName: string;
  public readonly projectPath: string;
  public readonly terminalId: number;

  private tmux: TmuxManager;
  private bridge: TmuxStreamBridge;
  private pendingInput: string = '';
  private flushTimer?: NodeJS.Timeout;
  private flushing: boolean = false;
  private queuedBytes: number = 0;
  private sentBytes: number = 0;
  private flushCount: number = 0;
  private lastFlushAt?: number;
  private lastInputAt?: number;
  private lastInputError?: string;
  private droppedBytes: number = 0;

  constructor(tmux: TmuxManager, bridge: TmuxStreamBridge, descriptor: EmbeddedSessionDescriptor) {
    this.tmux = tmux;
    this.bridge = bridge;
    this.clientId = descriptor.clientId;
    this.sessionName = descriptor.sessionName;
    this.projectPath = descriptor.projectPath;
    this.terminalId = descriptor.terminalId;
  }

  public async startStream(
    callbacks: TmuxStreamCallbacks,
    size?: { cols?: number; rows?: number },
    skipSnapshot?: boolean
  ): Promise<void> {
    this.state = 'creating';
    await this.bridge.startStream(this.clientId, this.sessionName, callbacks, size, skipSnapshot);
    this.state = 'streaming';
  }

  public async resize(cols?: number, rows?: number): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    const hasSize = typeof cols === 'number' &&
      typeof rows === 'number' &&
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      cols > 0 &&
      rows > 0;
    if (!hasSize) {
      return;
    }

    this.state = 'resizing';
    await this.tmux.resizeSession(this.sessionName, cols, rows);
    this.bridge.updateSize(this.clientId, cols, rows);
    if (this.state !== 'closed') {
      this.state = 'streaming';
    }
  }

  public async send(text: string, enter: boolean = false): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    const payload = (text || '') + (enter ? '\n' : '');
    if (!payload) {
      return;
    }
    this.pendingInput += payload;
    this.queuedBytes += Buffer.byteLength(payload, 'utf8');
    this.lastInputAt = Date.now();
    this.scheduleFlush();
  }

  public async detach(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    await this.bridge.stopStream(this.clientId);
    this.state = 'creating';
  }

  public async close(killSession: boolean): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    this.clearFlushTimer();
    await this.bridge.stopStream(this.clientId);
    if (killSession) {
      await this.tmux.killSession(this.sessionName);
    }
    this.state = 'closed';
  }

  public getInputStats(): {
    queuedBytes: number;
    sentBytes: number;
    droppedBytes: number;
    flushCount: number;
    lastFlushAt?: number;
    lastInputAt?: number;
    lastError?: string;
    flushing: boolean;
  } {
    return {
      queuedBytes: this.pendingInput ? Buffer.byteLength(this.pendingInput, 'utf8') : 0,
      sentBytes: this.sentBytes,
      droppedBytes: this.droppedBytes,
      flushCount: this.flushCount,
      lastFlushAt: this.lastFlushAt,
      lastInputAt: this.lastInputAt,
      lastError: this.lastInputError,
      flushing: this.flushing,
    };
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushing) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPending().catch(() => {
        // errors handled inside flushPending
      });
    }, 8);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async flushPending(): Promise<void> {
    if (this.state === 'closed' || this.flushing) {
      return;
    }
    const payload = this.pendingInput;
    if (!payload) {
      return;
    }

    this.pendingInput = '';
    this.flushing = true;
    try {
      const sent = await this.tmux.sendKeys(this.sessionName, payload, false);
      if (sent) {
        this.sentBytes += Buffer.byteLength(payload, 'utf8');
        this.flushCount += 1;
        this.lastFlushAt = Date.now();
        this.lastInputError = undefined;
      } else {
        this.droppedBytes += Buffer.byteLength(payload, 'utf8');
        this.lastInputError = 'tmux sendKeys failed';
      }
    } catch (error) {
      this.droppedBytes += Buffer.byteLength(payload, 'utf8');
      this.lastInputError = error instanceof Error ? error.message : String(error);
    } finally {
      this.flushing = false;
    }

    if (this.pendingInput) {
      this.scheduleFlush();
    }
  }
}
