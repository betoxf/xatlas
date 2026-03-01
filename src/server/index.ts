import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import { MCPRequest, MCPResponse, MCPError, MCPErrorCodes, ServerConfig } from '../types';
import { handleMCPRequest } from './mcpHandler';
import { TerminalWatcher } from '../services/terminalWatcher';
import { actionLog } from '../services/actionLog';

let server: http.Server | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let activePort: number | null = null;

// Find the first available port in [startPort, maxPort] by attempting a real TCP bind.
function findAvailablePort(host: string, startPort: number, maxPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    function tryPort() {
      if (port > maxPort) {
        reject(new Error(`No available port found between ${startPort} and ${maxPort}`));
        return;
      }
      const tester = net.createServer();
      tester.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          port++;
          tryPort();
        } else {
          reject(err);
        }
      });
      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, host);
    }
    tryPort();
  });
}

export function createStatusBarItem(): vscode.StatusBarItem {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'vscode-mcp-server.toggle';
  }
  return statusBarItem;
}

function updateStatusBar(running: boolean, port?: number) {
  if (statusBarItem) {
    if (running && port) {
      statusBarItem.text = `$(radio-tower) MCP :${port}`;
      statusBarItem.tooltip = `MCP Server running on port ${port}. Click to stop.`;
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = `$(circle-slash) MCP Off`;
      statusBarItem.tooltip = 'MCP Server stopped. Click to start.';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    statusBarItem.show();
  }
}

export async function startServer(config: ServerConfig): Promise<void> {
  if (server) {
    console.log('MCP Server already running');
    return;
  }

  // Find the first free port starting from config.port (each VS Code window gets its own port)
  let port: number;
  try {
    port = await findAvailablePort(config.host, config.port, config.port + 13); // 9002–9015
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`MCP Server: ${msg}`);
    return;
  }

  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      // Enable CORS for local development
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Health check endpoint
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'vscode-mcp-server' }));
        return;
      }

      // Dashboard info endpoint - for cross-window discovery
      if (req.method === 'GET' && req.url === '/dashboard/info') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const terminalWatcher = TerminalWatcher.getInstance();
        const terminals = terminalWatcher.getTerminals();

        const response = {
          workspace: workspaceFolder?.name || 'Untitled',
          workspacePath: workspaceFolder?.uri.fsPath || '',
          terminals: terminals.map(t => ({
            id: t.id,
            name: t.name,
            agentType: t.agentType,
            isActive: t.isActive,
            createdByMcp: t.createdByMcp,
            commandCount: t.commandHistory.length,
            lastOutput: t.lastOutput,
          })),
          mcpCreatedCount: terminals.filter(t => t.createdByMcp).length,
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      // Dashboard terminals endpoint - for getting terminal outputs
      if (req.method === 'GET' && req.url === '/dashboard/terminals') {
        const terminalWatcher = TerminalWatcher.getInstance();
        const terminals = terminalWatcher.getTerminals();

        const response = {
          terminals: await Promise.all(terminals.map(async t => ({
            id: t.id,
            name: t.name,
            agentType: t.agentType,
            isActive: t.isActive,
            createdByMcp: t.createdByMcp,
            commandCount: t.commandHistory.length,
            output: await terminalWatcher.getOutput(t.id),
          }))),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      // Terminal command history endpoint - get "conversation" for a terminal
      if (req.method === 'GET' && req.url?.startsWith('/dashboard/terminal/') && req.url?.endsWith('/history')) {
        const match = req.url.match(/\/dashboard\/terminal\/(\d+)\/history/);
        if (match) {
          const terminalId = parseInt(match[1], 10);
          const terminalWatcher = TerminalWatcher.getInstance();
          const history = terminalWatcher.getCommandHistory(terminalId);
          const terminalInfo = terminalWatcher.getTerminal(terminalId);

          const response = {
            terminalId,
            terminalName: terminalInfo?.name || 'Unknown',
            createdByMcp: terminalInfo?.createdByMcp || false,
            agentType: terminalInfo?.agentType || 'generic',
            commandCount: history.length,
            commands: history.map(cmd => ({
              id: cmd.id,
              command: cmd.command,
              timestamp: cmd.timestamp,
              source: cmd.source,
              status: cmd.status,
              duration: cmd.duration,
              exitCode: cmd.exitCode,
              // Truncate output for HTTP response
              output: cmd.output ? cmd.output.slice(0, 2000) : null,
              outputTruncated: cmd.output ? cmd.output.length > 2000 : false,
            })),
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }
      }

      // MCP-created terminals endpoint - list only AI-created terminals
      if (req.method === 'GET' && req.url === '/dashboard/terminals/mcp') {
        const terminalWatcher = TerminalWatcher.getInstance();
        const terminals = terminalWatcher.getMcpCreatedTerminals();

        const response = {
          count: terminals.length,
          terminals: await Promise.all(terminals.map(async t => ({
            id: t.id,
            name: t.name,
            agentType: t.agentType,
            isActive: t.isActive,
            projectPath: t.projectPath,
            tmuxSession: t.tmuxSession,
            commandCount: t.commandHistory.length,
            lastCommand: t.commandHistory.length > 0
              ? t.commandHistory[t.commandHistory.length - 1].command
              : null,
            output: await terminalWatcher.getOutput(t.id),
          }))),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      // Action log endpoint - get history of MCP tool calls
      if (req.method === 'GET' && req.url === '/action-log') {
        const response = actionLog.toJSON();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      // Action log stats endpoint
      if (req.method === 'GET' && req.url === '/action-log/stats') {
        const stats = actionLog.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
      }

      // Dashboard send command endpoint
      if (req.method === 'POST' && req.url?.startsWith('/dashboard/terminal/') && req.url?.endsWith('/send')) {
        const match = req.url.match(/\/dashboard\/terminal\/(\d+)\/send/);
        if (match) {
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { command } = JSON.parse(body);
              const terminalId = parseInt(match[1], 10);
              const terminalWatcher = TerminalWatcher.getInstance();
              const success = terminalWatcher.sendText(terminalId, command);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success }));
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid request' }));
            }
          });
          return;
        }
      }

      // MCP endpoint
      if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
        let body = '';

        req.on('data', chunk => {
          body += chunk.toString();
        });

        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              const errorResponse: MCPResponse = {
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: MCPErrorCodes.INVALID_REQUEST,
                  message: 'Invalid JSON-RPC request payload',
                },
              };
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(errorResponse));
              return;
            }

            const request = parsed as MCPRequest;
            const isNotification = request.id === undefined || request.id === null;
            const response = await handleMCPRequest(request);

            if (isNotification) {
              // JSON-RPC notifications must not receive a response body.
              res.writeHead(202);
              res.end();
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (error) {
            const errorResponse: MCPResponse = {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: MCPErrorCodes.PARSE_ERROR,
                message: error instanceof Error ? error.message : 'Parse error',
              },
            };
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errorResponse));
          }
        });
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      vscode.window.showErrorMessage(`MCP Server error: ${error.message}`);
      server = null;
      activePort = null;
      updateStatusBar(false);
      reject(error);
    });

    server.listen(port, config.host, () => {
      activePort = port;
      console.log(`MCP Server listening on http://${config.host}:${port}`);
      vscode.window.showInformationMessage(`MCP Server started on port ${port}`);
      updateStatusBar(true, port);
      resolve();
    });
  });
}

export function stopServer(): void {
  if (server) {
    server.close(() => {
      console.log('MCP Server stopped');
      vscode.window.showInformationMessage('MCP Server stopped');
    });
    server = null;
    activePort = null;
    updateStatusBar(false);
  }
}

export function isServerRunning(): boolean {
  return server !== null;
}

export function getActivePort(): number | null {
  return activePort;
}

export function disposeStatusBar(): void {
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }
}
