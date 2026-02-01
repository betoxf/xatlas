import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AgentType, AGENT_PATTERNS } from './terminalWatcher';

const execFileAsync = promisify(execFile);

/**
 * Agent launch configuration
 */
interface AgentConfig {
  command: string;
  args?: string[];
  displayName: string;
}

/**
 * Map of agent types to their launch configurations
 */
const AGENT_CONFIGS: Record<string, AgentConfig> = {
  claude: {
    command: 'claude',
    displayName: 'Claude Code',
  },
  zai: {
    command: 'zai',
    displayName: 'Zed AI',
  },
  opencode: {
    command: 'opencode',
    displayName: 'OpenCode',
  },
  cline: {
    command: 'cline',
    displayName: 'Cline',
  },
  aider: {
    command: 'aider',
    displayName: 'Aider',
  },
};

/**
 * Service to launch and manage AI agents
 */
export class AgentLauncher {
  private static instance: AgentLauncher;

  private constructor() {}

  public static getInstance(): AgentLauncher {
    if (!AgentLauncher.instance) {
      AgentLauncher.instance = new AgentLauncher();
    }
    return AgentLauncher.instance;
  }

  /**
   * Start an AI agent in a terminal
   */
  public async startAgent(
    agentType: string,
    projectPath?: string
  ): Promise<vscode.Terminal | null> {
    const config = AGENT_CONFIGS[agentType];

    if (!config) {
      vscode.window.showErrorMessage(`Unknown agent type: ${agentType}`);
      return null;
    }

    // Determine working directory
    let cwd = projectPath;
    if (!cwd) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      cwd = workspaceFolder?.uri.fsPath;
    }

    // Create terminal options
    const terminalOptions: vscode.TerminalOptions = {
      name: config.displayName,
      cwd,
    };

    // Create and show terminal
    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show();

    // Wait for terminal to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Send the agent command
    const fullCommand = config.args
      ? `${config.command} ${config.args.join(' ')}`
      : config.command;
    terminal.sendText(fullCommand);

    vscode.window.showInformationMessage(`Started ${config.displayName}`);

    return terminal;
  }

  /**
   * Stop an agent by disposing its terminal
   */
  public async stopAgent(processId: number): Promise<boolean> {
    const terminals = vscode.window.terminals;

    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === processId) {
        terminal.dispose();
        return true;
      }
    }

    return false;
  }

  /**
   * Get available agent types
   */
  public getAvailableAgents(): Array<{ type: string; displayName: string }> {
    return Object.entries(AGENT_CONFIGS).map(([type, config]) => ({
      type,
      displayName: config.displayName,
    }));
  }

  /**
   * Check if an agent command is available in the system
   * Uses execFile with fixed command names to prevent command injection
   */
  public async isAgentAvailable(agentType: string): Promise<boolean> {
    const config = AGENT_CONFIGS[agentType];
    if (!config) return false;

    // Use 'which' on Unix or 'where' on Windows to check if command exists
    const isWindows = process.platform === 'win32';
    const checkCommand = isWindows ? 'where' : 'which';

    try {
      // Using execFile with separate command and args prevents shell injection
      await execFileAsync(checkCommand, [config.command]);
      return true;
    } catch {
      return false;
    }
  }
}
