import * as vscode from 'vscode';
import * as path from 'path';
import { OpenRouterService, TerminalContext, getApiKeyFromKeychain } from './openRouterService';

/**
 * Configuration for terminal auto-naming
 */
interface AutoNamingConfig {
  enabled: boolean;
  commandThreshold: number;
  model: string;
}

/**
 * Tracks activity for a single terminal
 */
interface TerminalActivity {
  terminal: vscode.Terminal;
  commandCount: number;
  recentCommands: string[];
  recentOutputs: string[];
  hasBeenNamed: boolean;
}

/**
 * Manages automatic terminal naming based on activity
 */
export class TerminalAutoNamingManager {
  private service: OpenRouterService | null = null;
  private activityMap = new Map<number, TerminalActivity>();
  private config: AutoNamingConfig;

  private static instance: TerminalAutoNamingManager;

  private constructor() {
    this.config = {
      enabled: true,
      commandThreshold: 3,
      model: 'x-ai/grok-4.1-fast',
    };
    this.initialize();
  }

  static getInstance(): TerminalAutoNamingManager {
    if (!TerminalAutoNamingManager.instance) {
      TerminalAutoNamingManager.instance = new TerminalAutoNamingManager();
    }
    return TerminalAutoNamingManager.instance;
  }

  private async initialize() {
    // Load configuration
    this.loadConfiguration();

    // Initialize OpenRouter service
    const apiKey = await getApiKeyFromKeychain();
    if (apiKey) {
      this.service = new OpenRouterService(apiKey, this.config.model);
      console.log('TerminalAutoNaming: OpenRouter service initialized');
    } else {
      console.warn('TerminalAutoNaming: No API key found, auto-naming disabled');
      this.config.enabled = false;
    }

    // Watch for configuration changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vscode-mcp-server.autoNaming')) {
        this.loadConfiguration();
      }
    });

    // Clean up when terminals close
    vscode.window.onDidCloseTerminal(async (terminal) => {
      const pid = await terminal.processId;
      if (pid) {
        this.activityMap.delete(pid);
      }
    });
  }

  private loadConfiguration() {
    const config = vscode.workspace.getConfiguration('vscode-mcp-server');
    const autoNamingConfig = config.get<any>('autoNaming');

    if (autoNamingConfig) {
      this.config.enabled = autoNamingConfig.enabled ?? true;
      this.config.commandThreshold = autoNamingConfig.commandThreshold ?? 3;
      this.config.model = autoNamingConfig.model ?? 'x-ai/grok-4.1-fast';
    }
  }

  /**
   * Register a command execution for a terminal
   */
  async registerCommand(terminal: vscode.Terminal, command: string, output?: string): Promise<void> {
    if (!this.config.enabled || !this.service) {
      return;
    }

    const pid = await terminal.processId;
    if (!pid) return;

    // Get or create activity tracker
    let activity = this.activityMap.get(pid);
    if (!activity) {
      activity = {
        terminal,
        commandCount: 0,
        recentCommands: [],
        recentOutputs: [],
        hasBeenNamed: false,
      };
      this.activityMap.set(pid, activity);
    }

    // Skip if already named
    if (activity.hasBeenNamed) {
      return;
    }

    // Record command
    activity.commandCount++;
    activity.recentCommands.push(command);

    // Record output if provided (limit size)
    if (output) {
      const maxOutputLength = 500;
      const truncated = output.length > maxOutputLength
        ? output.substring(0, maxOutputLength) + '...'
        : output;
      activity.recentOutputs.push(truncated);

      // Keep only last 3 outputs
      if (activity.recentOutputs.length > 3) {
        activity.recentOutputs = activity.recentOutputs.slice(-3);
      }
    }

    // Keep only last 10 commands
    if (activity.recentCommands.length > 10) {
      activity.recentCommands = activity.recentCommands.slice(-10);
    }

    // Check if threshold reached
    if (activity.commandCount >= this.config.commandThreshold) {
      await this.generateAndApplyName(terminal, activity);
    }
  }

  /**
   * Manually trigger naming for a terminal
   */
  async nameTerminal(terminal: vscode.Terminal): Promise<string | null> {
    if (!this.service) {
      return null;
    }

    const pid = await terminal.processId;
    if (!pid) return null;

    const activity = this.activityMap.get(pid);
    const context = await this.buildContext(terminal, activity);

    try {
      const name = await this.service.generateTerminalName(context);
      await this.applyTerminalName(terminal, name);

      if (activity) {
        activity.hasBeenNamed = true;
      }

      return name;
    } catch (error) {
      console.error('TerminalAutoNaming: Error naming terminal:', error);
      return null;
    }
  }

  /**
   * Generate and apply a name to the terminal
   */
  private async generateAndApplyName(terminal: vscode.Terminal, activity: TerminalActivity): Promise<void> {
    const context = await this.buildContext(terminal, activity);

    try {
      const name = await this.service!.generateTerminalName(context);
      await this.applyTerminalName(terminal, name);
      activity.hasBeenNamed = true;
      console.log(`TerminalAutoNaming: Renamed terminal to "${name}"`);
    } catch (error) {
      console.error('TerminalAutoNaming: Error generating name:', error);
    }
  }

  /**
   * Build context for name generation
   */
  private async buildContext(terminal: vscode.Terminal, activity?: TerminalActivity): Promise<TerminalContext> {
    // Get working directory from terminal creation options (not directly available)
    // We'll infer from other context

    // Get open files
    const openFiles = vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .map(tab => tab.input)
      .filter((input): input is { path: string } => input !== undefined && 'path' in input)
      .map(input => input.path);

    // Get recent commands and outputs from activity
    const recentCommands = activity?.recentCommands || [];
    const recentOutputs = activity?.recentOutputs || [];

    // Try to infer working directory from git or open files
    let workingDirectory: string | undefined;
    if (openFiles.length > 0) {
      const firstFile = openFiles[0];
      workingDirectory = path.dirname(firstFile);
    }

    return {
      workingDirectory,
      recentCommands,
      recentOutputs,
      openFiles,
    };
  }

  /**
   * Apply a new name to a terminal by creating a renamed copy
   */
  private async applyTerminalName(terminal: vscode.Terminal, newName: string): Promise<void> {
    // VS Code doesn't support renaming terminals directly
    // We need to dispose and recreate with the new name
    // However, this would lose the terminal state

    // Instead, we'll store the suggested name and show it to the user
    // The user can manually rename if they want

    // For now, let's just log it
    vscode.window.showInformationMessage(`Terminal suggested name: "${newName}"`);

    // TODO: Find a way to actually rename the terminal tab
    // VS Code API doesn't currently support this
  }

  /**
   * Get activity for a terminal
   */
  async getActivity(terminal: vscode.Terminal): Promise<TerminalActivity | undefined> {
    const pid = await terminal.processId;
    if (!pid) return undefined;
    return this.activityMap.get(pid);
  }

  /**
   * Reset naming state for a terminal (allow re-naming)
   */
  async resetTerminal(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    if (!pid) return;

    const activity = this.activityMap.get(pid);
    if (activity) {
      activity.hasBeenNamed = false;
    }
  }

  /**
   * Check if auto-naming is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && this.service !== null;
  }

  /**
   * Enable or disable auto-naming
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

// Export singleton instance
export const terminalAutoNaming = TerminalAutoNamingManager.getInstance();
