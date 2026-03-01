import * as vscode from 'vscode';
import {
  startServer,
  stopServer,
  isServerRunning,
  createStatusBarItem,
  disposeStatusBar,
} from './server';
import { registerAllTools } from './tools';
import { DashboardPanel } from './dashboard/DashboardPanel';
import { AgentDiscovery } from './services/agentDiscovery';
import { TmuxManager } from './services/tmuxManager';
import { NotificationService } from './services/notificationService';

export function activate(context: vscode.ExtensionContext) {
  console.log('VS Code MCP Server extension activating...');

  AgentDiscovery.getInstance().setStorage(context.globalState);

  // Create status bar item
  const statusBarItem = createStatusBarItem();
  context.subscriptions.push(statusBarItem);

  // Create dashboard status bar item
  const dashboardStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  dashboardStatusBar.text = '$(layout) Xerebro';
  dashboardStatusBar.tooltip = 'Open Xerebro';
  dashboardStatusBar.command = 'vscode-mcp-server.openDashboard';
  dashboardStatusBar.show();
  context.subscriptions.push(dashboardStatusBar);

  // Register tools
  registerAllTools();

  // Show tmux installation notification if needed (non-blocking)
  TmuxManager.getInstance().showInstallNotification(context.globalState);

  // Start terminal notification service
  const notificationService = NotificationService.getInstance();
  notificationService.start();

  // Get configuration
  const config = vscode.workspace.getConfiguration('vscode-mcp-server');
  const port = config.get<number>('port', 9002);
  const host = config.get<string>('host', '127.0.0.1');
  const autoStart = config.get<boolean>('autoStart', true);

  // Register commands
  const startCommand = vscode.commands.registerCommand('vscode-mcp-server.start', async () => {
    if (isServerRunning()) {
      vscode.window.showInformationMessage('MCP Server is already running');
      return;
    }
    try {
      await startServer({ port, host });
    } catch (error) {
      // Error already shown by startServer
    }
  });

  const stopCommand = vscode.commands.registerCommand('vscode-mcp-server.stop', () => {
    if (!isServerRunning()) {
      vscode.window.showInformationMessage('MCP Server is not running');
      return;
    }
    stopServer();
  });

  const toggleCommand = vscode.commands.registerCommand('vscode-mcp-server.toggle', async () => {
    if (isServerRunning()) {
      stopServer();
    } else {
      try {
        await startServer({ port, host });
      } catch (error) {
        // Error already shown by startServer
      }
    }
  });

  // Register dashboard command
  const dashboardCommand = vscode.commands.registerCommand(
    'vscode-mcp-server.openDashboard',
    () => {
      DashboardPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(startCommand, stopCommand, toggleCommand, dashboardCommand);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vscode-mcp-server')) {
        vscode.window.showInformationMessage(
          'MCP Server configuration changed. Restart server to apply.'
        );
      }
    })
  );

  // Auto-start if configured
  if (autoStart) {
    startServer({ port, host }).catch(error => {
      console.error('Failed to auto-start MCP server:', error);
    });
  }

  console.log('VS Code MCP Server extension activated');
}

export function deactivate() {
  console.log('VS Code MCP Server extension deactivating...');
  NotificationService.getInstance().stop();
  stopServer();
  disposeStatusBar();
  console.log('VS Code MCP Server extension deactivated');
}
