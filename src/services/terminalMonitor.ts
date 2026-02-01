/**
 * Terminal Monitor Service
 *
 * Monitors embedded dashboard terminals (tmux sessions) for state changes
 * and sends notifications when important events occur.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export type TerminalState =
  | 'idle'           // Ready for input, showing prompt
  | 'processing'     // AI is thinking/working
  | 'waiting_input'  // AI asked a question, waiting for user
  | 'completed'      // Just finished a task
  | 'error'          // Error occurred
  | 'context_warning' // Context usage is high
  | 'unknown';

export interface TerminalStatus {
  sessionName: string;
  projectPath: string;
  state: TerminalState;
  agentType: 'claude' | 'opencode' | 'shell' | 'unknown';
  lastOutput: string;
  contextUsage?: number; // Percentage if detected
  hasQuestion?: boolean;
  timestamp: number;
}

export interface StateChange {
  sessionName: string;
  previousState: TerminalState;
  newState: TerminalState;
  message: string;
  timestamp: number;
}

type StateChangeCallback = (change: StateChange) => void;

export class TerminalMonitor {
  private static instance: TerminalMonitor;
  private intervalId: NodeJS.Timeout | null = null;
  private previousStates: Map<string, TerminalState> = new Map();
  private callbacks: StateChangeCallback[] = [];
  private pollInterval: number = 3000; // 3 seconds

  private constructor() {}

  public static getInstance(): TerminalMonitor {
    if (!TerminalMonitor.instance) {
      TerminalMonitor.instance = new TerminalMonitor();
    }
    return TerminalMonitor.instance;
  }

  /**
   * Start monitoring terminals
   */
  public start(intervalMs?: number): void {
    if (this.intervalId) {
      return; // Already running
    }

    if (intervalMs) {
      this.pollInterval = intervalMs;
    }

    console.log('[TerminalMonitor] Starting terminal monitoring...');
    this.intervalId = setInterval(() => this.pollTerminals(), this.pollInterval);

    // Initial poll
    this.pollTerminals();
  }

  /**
   * Stop monitoring
   */
  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[TerminalMonitor] Stopped terminal monitoring');
    }
  }

  /**
   * Register callback for state changes
   */
  public onStateChange(callback: StateChangeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove callback
   */
  public offStateChange(callback: StateChangeCallback): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx >= 0) {
      this.callbacks.splice(idx, 1);
    }
  }

  /**
   * Get current status of all terminals
   */
  public async getStatus(): Promise<TerminalStatus[]> {
    const sessions = await this.listTmuxSessions();
    const statuses: TerminalStatus[] = [];

    for (const session of sessions) {
      if (!session.startsWith('xvsc_')) {
        continue; // Only monitor dashboard terminals
      }

      try {
        const content = await this.capturePane(session, 50);
        const status = this.analyzeTerminal(session, content);
        statuses.push(status);
      } catch (err) {
        // Session might have been killed
      }
    }

    return statuses;
  }

  /**
   * Poll all terminals and detect state changes
   */
  private async pollTerminals(): Promise<void> {
    try {
      const statuses = await this.getStatus();

      for (const status of statuses) {
        const previousState = this.previousStates.get(status.sessionName);

        if (previousState && previousState !== status.state) {
          // State changed!
          const change: StateChange = {
            sessionName: status.sessionName,
            previousState,
            newState: status.state,
            message: this.getStateChangeMessage(status),
            timestamp: Date.now(),
          };

          console.log(`[TerminalMonitor] State change: ${status.sessionName} ${previousState} -> ${status.state}`);

          // Notify all callbacks
          for (const callback of this.callbacks) {
            try {
              callback(change);
            } catch (err) {
              console.error('[TerminalMonitor] Callback error:', err);
            }
          }
        }

        this.previousStates.set(status.sessionName, status.state);
      }
    } catch (err) {
      console.error('[TerminalMonitor] Poll error:', err);
    }
  }

  /**
   * Analyze terminal content to determine state
   */
  private analyzeTerminal(sessionName: string, content: string): TerminalStatus {
    const lines = content.split('\n');
    const lastLines = lines.slice(-30).join('\n');

    // Detect agent type
    let agentType: TerminalStatus['agentType'] = 'unknown';
    if (content.includes('Claude Code') || content.includes('▐▛███▜▌')) {
      agentType = 'claude';
    } else if (content.includes('GPT-') || content.includes('opencode') || content.includes('Auto (Off)')) {
      agentType = 'opencode';
    } else if (content.match(/\$\s*❯?\s*$/) && !content.includes('Claude')) {
      agentType = 'shell';
    }

    // Detect project path
    let projectPath = '';
    const pathMatch = content.match(/~\/([^\s\n]+)|Current folder: ([^\n]+)/);
    if (pathMatch) {
      projectPath = pathMatch[1] || pathMatch[2] || '';
    }

    // Detect state
    let state: TerminalState = 'unknown';
    let contextUsage: number | undefined;
    let hasQuestion = false;

    // Check for context usage warnings
    const contextMatch = content.match(/(\d+)%\s*context|(\d+)k\/(\d+)k\s*tokens?\s*\((\d+)%\)/i);
    if (contextMatch) {
      if (contextMatch[4]) {
        contextUsage = parseInt(contextMatch[4]);
      } else if (contextMatch[1]) {
        contextUsage = parseInt(contextMatch[1]);
      }
      if (contextUsage && contextUsage > 80) {
        state = 'context_warning';
      }
    }

    // Check for processing indicators
    const processingIndicators = [
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Spinner
      /\.\.\.$/, // Trailing dots
      /Thinking|Processing|Working|Reading|Writing|Searching/i,
      /⏳/,
      /━+.*%/, // Progress bar
    ];

    for (const indicator of processingIndicators) {
      if (indicator.test(lastLines)) {
        state = 'processing';
        break;
      }
    }

    // Check for waiting for input (question/options)
    const questionIndicators = [
      /\?\s*$/m, // Ends with ?
      /Select|Choose|Pick|Which|Options:/i,
      /\[Y\/n\]|\[y\/N\]/i,
      /Enter.*:|Input.*:/i,
      /❯\s*\[.*\]/,  // Selection brackets
      /^\s*>\s*\[/m, // Selection list
    ];

    for (const indicator of questionIndicators) {
      if (indicator.test(lastLines)) {
        hasQuestion = true;
        if (state === 'unknown') {
          state = 'waiting_input';
        }
        break;
      }
    }

    // Check for completed state (just finished something)
    if (lastLines.includes('✓') || lastLines.includes('Done') || lastLines.includes('Completed') || lastLines.includes('Success')) {
      if (state === 'unknown') {
        state = 'completed';
      }
    }

    // Check for error state
    if (lastLines.includes('Error:') || lastLines.includes('Failed') || lastLines.includes('✗')) {
      state = 'error';
    }

    // Check for idle/ready state
    const idlePatterns = [
      /❯\s*$/m, // Empty prompt
      /❯\s*Try\s*"/m, // Suggestion prompt
      />\s*Try\s*"/m, // OpenCode suggestion
      /\$\s*$/m, // Shell prompt
    ];

    if (state === 'unknown') {
      for (const pattern of idlePatterns) {
        if (pattern.test(lastLines)) {
          state = 'idle';
          break;
        }
      }
    }

    if (state === 'unknown') {
      state = 'idle'; // Default to idle if we can't determine
    }

    return {
      sessionName,
      projectPath,
      state,
      agentType,
      lastOutput: lastLines.slice(-500), // Keep last 500 chars
      contextUsage,
      hasQuestion,
      timestamp: Date.now(),
    };
  }

  /**
   * Generate human-readable state change message
   */
  private getStateChangeMessage(status: TerminalStatus): string {
    const agent = status.agentType === 'claude' ? 'Claude' :
                  status.agentType === 'opencode' ? 'OpenCode' :
                  'Terminal';

    switch (status.state) {
      case 'idle':
        return `${agent} is ready for input`;
      case 'processing':
        return `${agent} is thinking...`;
      case 'waiting_input':
        return `${agent} is waiting for your response`;
      case 'completed':
        return `${agent} finished the task`;
      case 'error':
        return `${agent} encountered an error`;
      case 'context_warning':
        return `${agent} context is ${status.contextUsage}% full`;
      default:
        return `${agent} state changed`;
    }
  }

  /**
   * List tmux sessions
   */
  private async listTmuxSessions(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null');
      return stdout.trim().split('\n').filter(s => s);
    } catch {
      return [];
    }
  }

  /**
   * Capture tmux pane content
   */
  private async capturePane(session: string, lines: number = 50): Promise<string> {
    try {
      const { stdout } = await execAsync(`tmux capture-pane -t "${session}" -p -S -${lines} 2>/dev/null`);
      return stdout;
    } catch {
      return '';
    }
  }
}
