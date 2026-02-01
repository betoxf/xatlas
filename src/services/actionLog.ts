import * as vscode from 'vscode';

/**
 * Action Log Service
 *
 * Tracks all MCP tool calls and their results for dashboard visibility.
 * Provides real-time activity feed and history.
 */

export interface ActionEntry {
  id: string;
  timestamp: number;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'success' | 'error';
  result?: unknown;
  error?: string;
  duration?: number;
  source?: string; // 'xerebro' | 'claude-code' | 'direct'
}

export interface ActionStats {
  totalActions: number;
  successCount: number;
  errorCount: number;
  pendingCount: number;
  lastActionAt: number | null;
  topTools: Array<{ tool: string; count: number }>;
}

class ActionLogService {
  private static instance: ActionLogService;
  private actions: ActionEntry[] = [];
  private maxHistory = 500; // Keep last 500 actions
  private listeners: Set<(action: ActionEntry) => void> = new Set();

  private constructor() {}

  static getInstance(): ActionLogService {
    if (!ActionLogService.instance) {
      ActionLogService.instance = new ActionLogService();
    }
    return ActionLogService.instance;
  }

  /**
   * Log start of an action
   */
  startAction(
    toolName: string,
    args: Record<string, unknown>,
    source?: string
  ): string {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const entry: ActionEntry = {
      id,
      timestamp: Date.now(),
      toolName,
      args,
      status: 'pending',
      source,
    };

    this.actions.unshift(entry);
    this.trimHistory();
    this.notifyListeners(entry);

    console.log(`[ActionLog] Started: ${toolName}`, args);
    return id;
  }

  /**
   * Log completion of an action
   */
  completeAction(
    id: string,
    result: unknown,
    error?: string
  ): void {
    const entry = this.actions.find((a) => a.id === id);
    if (!entry) return;

    entry.status = error ? 'error' : 'success';
    entry.result = result;
    entry.error = error;
    entry.duration = Date.now() - entry.timestamp;

    this.notifyListeners(entry);

    console.log(
      `[ActionLog] ${entry.status}: ${entry.toolName} (${entry.duration}ms)`,
      error || ''
    );
  }

  /**
   * Log a complete action (start and end in one call)
   */
  logAction(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    error?: string,
    source?: string
  ): string {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const entry: ActionEntry = {
      id,
      timestamp: Date.now(),
      toolName,
      args,
      status: error ? 'error' : 'success',
      result,
      error,
      duration: 0,
      source,
    };

    this.actions.unshift(entry);
    this.trimHistory();
    this.notifyListeners(entry);

    return id;
  }

  /**
   * Get recent actions
   */
  getHistory(limit = 50, filter?: { status?: string; toolName?: string }): ActionEntry[] {
    let result = this.actions;

    if (filter?.status) {
      result = result.filter((a) => a.status === filter.status);
    }
    if (filter?.toolName) {
      result = result.filter((a) =>
        a.toolName.toLowerCase().includes(filter.toolName!.toLowerCase())
      );
    }

    return result.slice(0, limit);
  }

  /**
   * Get currently pending actions
   */
  getPending(): ActionEntry[] {
    return this.actions.filter((a) => a.status === 'pending');
  }

  /**
   * Get action statistics
   */
  getStats(): ActionStats {
    const toolCounts = new Map<string, number>();

    for (const action of this.actions) {
      const count = toolCounts.get(action.toolName) || 0;
      toolCounts.set(action.toolName, count + 1);
    }

    const topTools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    return {
      totalActions: this.actions.length,
      successCount: this.actions.filter((a) => a.status === 'success').length,
      errorCount: this.actions.filter((a) => a.status === 'error').length,
      pendingCount: this.actions.filter((a) => a.status === 'pending').length,
      lastActionAt: this.actions[0]?.timestamp || null,
      topTools,
    };
  }

  /**
   * Clear all history
   */
  clearHistory(): void {
    this.actions = [];
  }

  /**
   * Subscribe to action updates
   */
  subscribe(callback: (action: ActionEntry) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Get actions as JSON for dashboard
   */
  toJSON(): {
    actions: ActionEntry[];
    stats: ActionStats;
    pending: ActionEntry[];
  } {
    return {
      actions: this.getHistory(100),
      stats: this.getStats(),
      pending: this.getPending(),
    };
  }

  private trimHistory(): void {
    if (this.actions.length > this.maxHistory) {
      this.actions = this.actions.slice(0, this.maxHistory);
    }
  }

  private notifyListeners(action: ActionEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(action);
      } catch (error) {
        console.error('[ActionLog] Listener error:', error);
      }
    }
  }
}

export const actionLog = ActionLogService.getInstance();
export { ActionLogService };
