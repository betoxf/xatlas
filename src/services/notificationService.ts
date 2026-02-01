/**
 * Notification Service
 *
 * Handles notifications for terminal state changes with VS Code notifications
 * and system sounds.
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { TerminalMonitor, StateChange, TerminalState } from './terminalMonitor';
import { AgentDiscovery } from './agentDiscovery';

export interface NotificationConfig {
  enabled: boolean;
  soundEnabled: boolean;
  notifyOnIdle: boolean;        // When AI becomes ready
  notifyOnWaitingInput: boolean; // When AI asks a question
  notifyOnCompleted: boolean;   // When task completes
  notifyOnError: boolean;       // When error occurs
  notifyOnContextWarning: boolean; // When context is high
}

type SoundType = 'success' | 'attention' | 'error' | 'info';

export class NotificationService {
  private static instance: NotificationService;
  private config: NotificationConfig;
  private monitor: TerminalMonitor;
  private boundHandler: ((change: StateChange) => void) | null = null;
  private lastNotificationTime: Map<string, number> = new Map();
  private throttleMs: number = 5000; // Minimum 5 seconds between notifications per session

  private constructor() {
    this.config = {
      enabled: true,
      soundEnabled: true,
      notifyOnIdle: true,
      notifyOnWaitingInput: true,
      notifyOnCompleted: true,
      notifyOnError: true,
      notifyOnContextWarning: true,
    };
    this.monitor = TerminalMonitor.getInstance();
  }

  public static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Start the notification service
   */
  public start(): void {
    if (this.boundHandler) {
      return; // Already started
    }

    console.log('[NotificationService] Starting notification service...');

    // Start the terminal monitor if not already running
    this.monitor.start(3000);

    // Register callback for state changes
    this.boundHandler = (change: StateChange) => this.handleStateChange(change);
    this.monitor.onStateChange(this.boundHandler);

    console.log('[NotificationService] Notification service started');
  }

  /**
   * Stop the notification service
   */
  public stop(): void {
    if (this.boundHandler) {
      this.monitor.offStateChange(this.boundHandler);
      this.boundHandler = null;
      console.log('[NotificationService] Notification service stopped');
    }
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<NotificationConfig>): void {
    this.config = { ...this.config, ...config };
    console.log('[NotificationService] Config updated:', this.config);
  }

  /**
   * Get current configuration
   */
  public getConfig(): NotificationConfig {
    return { ...this.config };
  }

  /**
   * Handle a state change from the terminal monitor
   */
  private handleStateChange(change: StateChange): void {
    if (!this.config.enabled) {
      return;
    }

    // Throttle notifications per session
    const lastTime = this.lastNotificationTime.get(change.sessionName) || 0;
    const now = Date.now();
    if (now - lastTime < this.throttleMs) {
      console.log(`[NotificationService] Throttled notification for ${change.sessionName}`);
      return;
    }

    // Check if this state change should trigger a notification
    if (!this.shouldNotify(change.newState)) {
      return;
    }

    this.lastNotificationTime.set(change.sessionName, now);

    // Get project name from session
    const projectName = this.getProjectNameFromSession(change.sessionName);

    // Show notification based on state
    this.showNotification(change, projectName);
  }

  /**
   * Check if a state should trigger a notification
   */
  private shouldNotify(state: TerminalState): boolean {
    switch (state) {
      case 'idle':
        return this.config.notifyOnIdle;
      case 'waiting_input':
        return this.config.notifyOnWaitingInput;
      case 'completed':
        return this.config.notifyOnCompleted;
      case 'error':
        return this.config.notifyOnError;
      case 'context_warning':
        return this.config.notifyOnContextWarning;
      default:
        return false;
    }
  }

  /**
   * Get project name from session name
   */
  private getProjectNameFromSession(sessionName: string): string {
    // Fallback: extract from session name
    // Session format: xvsc_HASH_TIMESTAMP
    // Note: AgentDiscovery.discoverProjects() is async, so we use a simple fallback here
    return sessionName.replace(/^xvsc_/, '').slice(0, 8);
  }

  /**
   * Show VS Code notification and play sound
   */
  private showNotification(change: StateChange, projectName: string): void {
    const { newState } = change;

    // Determine notification type and sound
    let sound: SoundType = 'info';
    let title = `[${projectName}]`;

    switch (newState) {
      case 'idle':
        title = `✅ ${projectName}`;
        sound = 'success';
        this.showInfoMessage(`${title}: Ready for input`, ['Focus Terminal']);
        break;

      case 'waiting_input':
        title = `❓ ${projectName}`;
        sound = 'attention';
        this.showWarningMessage(`${title}: Needs your input!`, ['Focus Terminal', 'Dismiss']);
        break;

      case 'completed':
        title = `🎉 ${projectName}`;
        sound = 'success';
        this.showInfoMessage(`${title}: Task completed`, ['Focus Terminal']);
        break;

      case 'error':
        title = `❌ ${projectName}`;
        sound = 'error';
        this.showErrorMessage(`${title}: Error occurred`, ['Focus Terminal', 'Dismiss']);
        break;

      case 'context_warning':
        title = `⚠️ ${projectName}`;
        sound = 'attention';
        this.showWarningMessage(`${title}: Context usage high`, ['Focus Terminal', 'Use /compact']);
        break;
    }

    // Play sound if enabled
    if (this.config.soundEnabled) {
      this.playSound(sound);
    }
  }

  /**
   * Show info message with optional actions
   */
  private async showInfoMessage(message: string, actions: string[]): Promise<void> {
    const result = await vscode.window.showInformationMessage(message, ...actions);
    this.handleAction(result);
  }

  /**
   * Show warning message with optional actions
   */
  private async showWarningMessage(message: string, actions: string[]): Promise<void> {
    const result = await vscode.window.showWarningMessage(message, ...actions);
    this.handleAction(result);
  }

  /**
   * Show error message with optional actions
   */
  private async showErrorMessage(message: string, actions: string[]): Promise<void> {
    const result = await vscode.window.showErrorMessage(message, ...actions);
    this.handleAction(result);
  }

  /**
   * Handle notification action button clicks
   */
  private handleAction(action: string | undefined): void {
    if (!action) return;

    switch (action) {
      case 'Focus Terminal':
        // Open the dashboard to see terminals
        vscode.commands.executeCommand('vscode-mcp-server.openDashboard');
        break;
      case 'Use /compact':
        // Copy /compact to clipboard
        vscode.env.clipboard.writeText('/compact');
        vscode.window.showInformationMessage('Copied /compact to clipboard');
        break;
      // 'Dismiss' requires no action
    }
  }

  /**
   * Play system sound using execFile (safe from injection)
   */
  private playSound(type: SoundType): void {
    // macOS system sounds
    const sounds: Record<SoundType, string> = {
      success: '/System/Library/Sounds/Glass.aiff',
      attention: '/System/Library/Sounds/Ping.aiff',
      error: '/System/Library/Sounds/Basso.aiff',
      info: '/System/Library/Sounds/Pop.aiff',
    };

    const soundFile = sounds[type];

    // Use execFile instead of exec to avoid shell injection (though sounds are hardcoded)
    execFile('afplay', [soundFile], (error) => {
      if (error) {
        console.error('[NotificationService] Failed to play sound:', error);
      }
    });
  }

  /**
   * Test notification (for debugging)
   */
  public testNotification(state: TerminalState = 'waiting_input'): void {
    const testChange: StateChange = {
      sessionName: 'test_session',
      previousState: 'processing',
      newState: state,
      message: `Test notification for ${state}`,
      timestamp: Date.now(),
    };

    // Bypass throttling for tests
    this.lastNotificationTime.delete('test_session');
    this.handleStateChange(testChange);
  }
}
