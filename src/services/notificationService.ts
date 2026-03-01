/**
 * Notification Service
 *
 * Handles notifications for terminal state changes with VS Code notifications
 * and system sounds.
 */

import * as vscode from 'vscode';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import type { StateChange, TerminalState } from './terminalMonitor';
import { AgentDiscovery, ProjectActivity, ProjectActivityChange } from './agentDiscovery';
import { TmuxManager } from './tmuxManager';

const execAsync = promisify(exec);

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
  private discovery: AgentDiscovery;
  private boundActivityHandler: ((change: ProjectActivityChange) => void) | null = null;
  private lastNotificationTime: Map<string, number> = new Map();
  private lastNotifiedState: Map<string, TerminalState> = new Map();
  private throttleMs: number = 8000; // Minimum 8 seconds between notifications per session
  private repeatStateCooldownMs: number = 30000; // Suppress same-state repeats for 30 seconds
  private flapSuppressMs: number = 12000; // Suppress rapid flips between attention states
  private sessionProjectCache: Map<string, string> = new Map(); // sessionName -> projectName
  private activeNotificationCount = 0;
  private maxActiveNotifications = 3;

  private constructor() {
    this.config = {
      enabled: true,
      soundEnabled: true,
      notifyOnIdle: false,           // Disabled by default - too noisy
      notifyOnWaitingInput: true,    // Important - AI needs input
      notifyOnCompleted: true,       // Useful - task finished
      notifyOnError: true,           // Important - something went wrong
      notifyOnContextWarning: false, // Disabled by default to keep notification noise low
    };
    this.discovery = AgentDiscovery.getInstance();
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
    if (this.boundActivityHandler) {
      return; // Already started
    }

    console.log('[NotificationService] Starting stream-driven notification service...');
    this.boundActivityHandler = (change: ProjectActivityChange) =>
      this.handleProjectActivityChange(change);
    this.discovery.onProjectActivityChange(this.boundActivityHandler);
    console.log('[NotificationService] Notification service started');
  }

  /**
   * Stop the notification service
   */
  public stop(): void {
    if (this.boundActivityHandler) {
      this.discovery.offProjectActivityChange(this.boundActivityHandler);
      this.boundActivityHandler = null;
      console.log('[NotificationService] Notification service stopped');
    }
  }

  private handleProjectActivityChange(change: ProjectActivityChange): void {
    const mappedState = this.projectActivityToTerminalState(change.activity);
    if (!mappedState) {
      return;
    }

    const previousMappedState = this.projectActivityToTerminalState(change.previousActivity);
    const sessionName = `project:${change.projectPath}`;
    const stateChange: StateChange = {
      sessionName,
      previousState: previousMappedState ?? 'processing',
      newState: mappedState,
      message: `Project activity changed: ${change.activity}`,
      timestamp: change.timestamp || Date.now(),
    };

    const projectName =
      this.getProjectNameFromPath(change.projectPath) ||
      change.projectPath.split('/').filter(Boolean).pop() ||
      'Project';

    this.handleStateChange(stateChange, projectName);
  }

  private projectActivityToTerminalState(
    activity: ProjectActivity | undefined
  ): TerminalState | null {
    switch (activity) {
      case 'idle':
        return 'idle';
      case 'waiting':
      case 'waiting_input':
        return 'waiting_input';
      case 'completed':
        return 'completed';
      case 'error':
        return 'error';
      case 'context_warning':
        return 'context_warning';
      default:
        return null;
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
   * Handle a state change from stream events
   */
  private handleStateChange(change: StateChange, projectNameOverride?: string): void {
    if (!this.config.enabled) {
      return;
    }

    // Check if this state change should trigger a notification
    if (!this.shouldNotify(change.newState)) {
      return;
    }

    // Throttle notifications per session
    const lastTime = this.lastNotificationTime.get(change.sessionName) || 0;
    const now = Date.now();
    if (now - lastTime < this.throttleMs) {
      console.log(`[NotificationService] Throttled notification for ${change.sessionName}`);
      return;
    }

    // Avoid repeat alerts and state flapping noise.
    if (!this.shouldNotifyTransition(change, now)) {
      return;
    }

    this.lastNotificationTime.set(change.sessionName, now);
    this.lastNotifiedState.set(change.sessionName, change.newState);

    if (projectNameOverride) {
      this.showNotification(change, projectNameOverride);
      return;
    }

    // Get project name from session (async but fire-and-forget)
    this.resolveProjectNameAndNotify(change);
  }

  /**
   * Resolve project name and show notification
   */
  private async resolveProjectNameAndNotify(change: StateChange): Promise<void> {
    try {
      const projectName = await this.getProjectNameFromSession(change.sessionName);
      this.showNotification(change, projectName);
    } catch (error) {
      console.error('[NotificationService] Error resolving project name:', error);
      // Use fallback name
      const fallbackName = change.sessionName.replace(/^xvsc_/, '').split('_')[0].slice(0, 8);
      this.showNotification(change, fallbackName);
    }
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
   * Prevent noisy repeats and rapid state oscillation popups.
   */
  private shouldNotifyTransition(change: StateChange, now: number): boolean {
    const lastNotifiedState = this.lastNotifiedState.get(change.sessionName);
    const lastNotifiedAt = this.lastNotificationTime.get(change.sessionName) || 0;

    if (
      lastNotifiedState === change.newState &&
      now - lastNotifiedAt < this.repeatStateCooldownMs
    ) {
      console.log(
        `[NotificationService] Suppressed repeat ${change.newState} notification for ${change.sessionName}`
      );
      return false;
    }

    if (
      this.isAttentionState(change.previousState) &&
      this.isAttentionState(change.newState) &&
      now - lastNotifiedAt < this.flapSuppressMs
    ) {
      console.log(
        `[NotificationService] Suppressed flapping ${change.previousState} -> ${change.newState} for ${change.sessionName}`
      );
      return false;
    }

    return true;
  }

  private isAttentionState(state: TerminalState): boolean {
    return state === 'waiting_input' || state === 'error' || state === 'context_warning';
  }

  /**
   * Get project name from session name
   */
  private async getProjectNameFromSession(sessionName: string): Promise<string> {
    // Check cache first
    const cached = this.sessionProjectCache.get(sessionName);
    if (cached) {
      return cached;
    }

    // Try to get project info from TmuxManager cache
    const tmux = TmuxManager.getInstance();
    const sessionInfo = tmux.getInfoBySessionName(sessionName);
    let cwd = sessionInfo?.cwd;

    // If not in TmuxManager cache, query tmux directly
    if (!cwd) {
      try {
        const { stdout } = await execAsync(`tmux display-message -t "${sessionName}" -p '#{pane_current_path}' 2>/dev/null`);
        cwd = stdout.trim();
      } catch {
        // Session might not exist or tmux command failed
      }
    }

    if (cwd) {
      const projectName = this.getProjectNameFromPath(cwd);
      if (projectName) {
        this.sessionProjectCache.set(sessionName, projectName);
        return projectName;
      }
    }

    // If we have a terminal name from the session info, use it
    if (sessionInfo?.terminalName) {
      this.sessionProjectCache.set(sessionName, sessionInfo.terminalName);
      return sessionInfo.terminalName;
    }

    // Fallback: extract folder name from session name hash (last resort)
    // Session format: xvsc_HASH_TIMESTAMP
    const fallback = sessionName.replace(/^xvsc_/, '').split('_')[0].slice(0, 8);
    return fallback;
  }

  /**
   * Get project name from a path by matching against tracked projects or extracting folder name
   */
  private getProjectNameFromPath(cwd: string): string | null {
    // Try to find a matching project in AgentDiscovery
    const discovery = AgentDiscovery.getInstance();
    const trackedProjects = discovery.getTrackedProjects();

    // Find project whose path matches the session's cwd
    for (const project of trackedProjects) {
      if (cwd === project.path || cwd.startsWith(project.path + '/')) {
        return project.name;
      }
    }

    // If no tracked project matches, use the folder name from cwd
    const folderName = cwd.split('/').pop();
    if (folderName && folderName !== '~' && folderName !== '') {
      return folderName;
    }

    return null;
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
        title = projectName;
        sound = 'success';
        this.showInfoMessage(`${title}: Webview is ready for input`, ['Focus Terminal']);
        break;

      case 'waiting_input':
        title = projectName;
        sound = 'attention';
        this.showWarningMessage(`${title}: Webview is waiting for your input`, ['Focus Terminal', 'Dismiss']);
        break;

      case 'completed':
        title = projectName;
        sound = 'success';
        this.showInfoMessage(`${title}: Webview is done and waiting for your next prompt`, ['Focus Terminal']);
        break;

      case 'error':
        title = projectName;
        sound = 'error';
        this.showErrorMessage(`${title}: Webview reported an error`, ['Focus Terminal', 'Dismiss']);
        break;

      case 'context_warning':
        title = projectName;
        sound = 'attention';
        this.showWarningMessage(`${title}: Webview context usage is high`, ['Focus Terminal', 'Use /compact']);
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
    await this.showMessageWithLimit(() => vscode.window.showInformationMessage(message, ...actions));
  }

  /**
   * Show warning message with optional actions
   */
  private async showWarningMessage(message: string, actions: string[]): Promise<void> {
    await this.showMessageWithLimit(() => vscode.window.showWarningMessage(message, ...actions));
  }

  /**
   * Show error message with optional actions
   */
  private async showErrorMessage(message: string, actions: string[]): Promise<void> {
    await this.showMessageWithLimit(() => vscode.window.showErrorMessage(message, ...actions));
  }

  /**
   * Show a VS Code notification while enforcing a max number of active popups.
   */
  private async showMessageWithLimit(
    show: () => Thenable<string | undefined>
  ): Promise<void> {
    if (this.activeNotificationCount >= this.maxActiveNotifications) {
      console.log(
        `[NotificationService] Suppressed notification (active=${this.activeNotificationCount}, max=${this.maxActiveNotifications})`
      );
      return;
    }

    this.activeNotificationCount += 1;
    try {
      const result = await show();
      this.handleAction(result);
    } finally {
      this.activeNotificationCount = Math.max(0, this.activeNotificationCount - 1);
    }
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
