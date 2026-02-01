import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { registerTool } from '../server/mcpHandler';
import { MCPTool, ToolResult } from '../types';
import { terminalAutoNaming } from '../services/terminalAutoNaming';
import { TmuxManager } from '../services/tmuxManager';
import { TerminalWatcher } from '../services/terminalWatcher';

// Track terminals by name for easier reference
const terminalMap = new Map<string, vscode.Terminal>();

// Buffer to store terminal output for each terminal (by processId)
// Stores last N characters of output for each terminal
const terminalBuffers = new Map<number, string>();
const MAX_BUFFER_SIZE = 50000; // Store last ~50KB of output per terminal

/**
 * Strip ANSI escape codes from terminal output
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// Track if buffer capture is available
let bufferCaptureEnabled = false;

// Track if tmux is available for enhanced terminal control
let tmuxAvailable = false;

/**
 * Initialize terminal output capture for all terminals
 * Uses onDidWriteTerminalData API (proposed API - requires enabledApiProposals in package.json)
 */
function initTerminalCapture(): void {
  const enabledProposals = vscode.extensions
    .getExtension('iprado.vscode-mcp-server')
    ?.packageJSON?.enabledApiProposals as string[] | undefined;

  if (!enabledProposals || !enabledProposals.includes('terminalDataWriteEvent')) {
    return;
  }

  let onDidWriteTerminalData: vscode.Event<{ terminal: vscode.Terminal; data: string }> | undefined;
  try {
    // The API is declared in vscode.proposed.terminalDataWriteEvent.d.ts
    const windowAny = vscode.window as typeof vscode.window & {
      onDidWriteTerminalData?: vscode.Event<{ terminal: vscode.Terminal; data: string }>;
    };
    onDidWriteTerminalData = windowAny.onDidWriteTerminalData;
  } catch {
    return;
  }

  if (!onDidWriteTerminalData) {
    return;
  }

  try {
    // Capture output from all terminals using the proposed API
    onDidWriteTerminalData((event) => {
      const terminal = event.terminal;
      terminal.processId.then((pid: number | undefined) => {
        if (pid) {
          const existing = terminalBuffers.get(pid) || '';
          const newData = existing + event.data;
          // Keep only last MAX_BUFFER_SIZE characters
          const trimmed = newData.length > MAX_BUFFER_SIZE
            ? newData.slice(-MAX_BUFFER_SIZE)
            : newData;
          terminalBuffers.set(pid, trimmed);
        }
      });
    });

    bufferCaptureEnabled = true;
    // Clean up buffer when terminal closes
    vscode.window.onDidCloseTerminal(terminal => {
      terminal.processId.then((pid: number | undefined) => {
        if (pid) {
          terminalBuffers.delete(pid);
        }
      });
    });

    // Initialize buffers for existing terminals
    vscode.window.terminals.forEach(terminal => {
      terminal.processId.then((pid: number | undefined) => {
        if (pid && !terminalBuffers.has(pid)) {
          terminalBuffers.set(pid, '');
        }
      });
    });
  } catch {
    bufferCaptureEnabled = false;
  }
}

/**
 * Register all terminal tools
 */
export function registerTerminalTools(): void {
  // Initialize terminal output capture (proposed API fallback)
  initTerminalCapture();

  // Check tmux availability
  initTmuxSupport();

  registerTerminalCreate();
  registerTerminalSend();
  registerTerminalList();
  registerTerminalClose();
  registerTerminalExecute();
  registerTerminalReadOutput();
  registerTerminalShow();
  registerTerminalRunQuick();
  registerTerminalReadBuffer();
  registerTerminalRename();

  // Clean up terminal map when terminals are closed
  vscode.window.onDidCloseTerminal(async terminal => {
    for (const [name, t] of terminalMap.entries()) {
      if (t === terminal) {
        terminalMap.delete(name);
        break;
      }
    }

    // Clean up tmux session if one exists
    if (tmuxAvailable) {
      const tmux = TmuxManager.getInstance();
      await tmux.onTerminalClosed(terminal);
    }
  });
}

/**
 * Initialize tmux support
 */
async function initTmuxSupport(): Promise<void> {
  const tmux = TmuxManager.getInstance();
  tmuxAvailable = await tmux.isAvailable();

  if (tmuxAvailable) {
    console.log('[Terminal Tools] tmux available - using tmux for enhanced terminal control');
  } else {
    console.log('[Terminal Tools] tmux not available - falling back to file-based capture');
  }
}

/**
 * vscode_terminal_create - Create a new terminal
 */
function registerTerminalCreate(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_create',
    description: 'Create a new integrated terminal. Uses tmux backend when available for enhanced buffer capture.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the terminal',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the terminal',
        },
        env: {
          type: 'object',
          description: 'Environment variables to set',
        },
        shellPath: {
          type: 'string',
          description: 'Path to shell executable (ignored when using tmux backend)',
        },
        show: {
          type: 'boolean',
          description: 'Show the terminal after creation',
          default: true,
        },
        useTmux: {
          type: 'boolean',
          description: 'Use tmux backend for enhanced buffer capture (default: true if tmux available)',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const name = args.name as string | undefined;
    const cwd = args.cwd as string | undefined;
    const env = args.env as Record<string, string> | undefined;
    const shellPath = args.shellPath as string | undefined;
    const show = (args.show as boolean) ?? true;
    const useTmux = (args.useTmux as boolean) ?? tmuxAvailable;

    try {
      let terminal: vscode.Terminal;
      let tmuxSession: string | undefined;
      let backend: 'tmux' | 'vscode' = 'vscode';

      // Use tmux if available and requested
      if (useTmux && tmuxAvailable) {
        const tmux = TmuxManager.getInstance();
        const result = await tmux.createTerminal(name || 'Terminal', cwd, env);
        terminal = result.terminal;
        tmuxSession = result.sessionName;
        backend = 'tmux';

        // Register tmux session with terminal watcher and mark as MCP-created
        const pid = await terminal.processId;
        if (pid) {
          const watcher = TerminalWatcher.getInstance();
          watcher.setTmuxSession(pid, tmuxSession);
          watcher.setCreatedByMcp(pid, true); // Mark as AI-created
        }
      } else {
        // Fallback to standard terminal
        const options: vscode.TerminalOptions = {};
        if (name) options.name = name;
        if (cwd) options.cwd = cwd;
        if (env) options.env = env;
        if (shellPath) options.shellPath = shellPath;

        terminal = vscode.window.createTerminal(options);

        // Mark as MCP-created
        const pid = await terminal.processId;
        if (pid) {
          const watcher = TerminalWatcher.getInstance();
          watcher.setCreatedByMcp(pid, true);
        }
      }

      // Store in map for reference
      const terminalName = terminal.name;
      terminalMap.set(terminalName, terminal);

      if (show) {
        terminal.show();
      }

      const processId = await terminal.processId;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                created: true,
                name: terminalName,
                processId,
                backend,
                tmuxSession: tmuxSession || null,
                bufferCapture: backend === 'tmux' || bufferCaptureEnabled,
                hint: backend === 'tmux'
                  ? 'Terminal backed by tmux - full buffer capture available (50,000 lines)'
                  : bufferCaptureEnabled
                    ? 'Buffer capture via proposed API enabled'
                    : 'No buffer capture available - use vscode_terminal_execute for output',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_send - Send command to terminal
 */
function registerTerminalSend(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_send',
    description: 'Send text/command to a terminal. Uses tmux send-keys when available for headless control.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Terminal name. Omit to use active terminal.',
        },
        text: {
          type: 'string',
          description: 'Text/command to send',
        },
        addNewLine: {
          type: 'boolean',
          description: 'Add newline after text (execute command)',
          default: true,
        },
        useTmux: {
          type: 'boolean',
          description: 'Use tmux send-keys if terminal has tmux session (default: true)',
          default: true,
        },
      },
      required: ['text'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const name = args.name as string | undefined;
    const text = args.text as string;
    const addNewLine = (args.addNewLine as boolean) ?? true;
    const useTmux = (args.useTmux as boolean) ?? true;

    try {
      let terminal: vscode.Terminal | undefined;

      if (name) {
        // Find by name
        terminal = terminalMap.get(name);
        if (!terminal) {
          // Try to find in all terminals
          terminal = vscode.window.terminals.find(t => t.name === name);
        }
      } else {
        // Use active terminal
        terminal = vscode.window.activeTerminal;
      }

      if (!terminal) {
        // Create a new terminal if none exists
        terminal = vscode.window.createTerminal('MCP Terminal');
        terminalMap.set(terminal.name, terminal);
        terminal.show();
      }

      let sentViaTmux = false;

      // Check if terminal has a tmux session
      if (useTmux && tmuxAvailable) {
        const pid = await terminal.processId;
        if (pid) {
          const watcher = TerminalWatcher.getInstance();
          const tmuxSession = watcher.getTmuxSession(pid);
          if (tmuxSession) {
            const tmux = TmuxManager.getInstance();
            const sent = await tmux.sendKeys(tmuxSession, text, addNewLine);
            if (sent) {
              sentViaTmux = true;
            }
          }
        }
      }

      // Fall back to VS Code's sendText if tmux failed or not available
      if (!sentViaTmux) {
        terminal.sendText(text, addNewLine);
      }

      // Record command in terminal history (MCP-sourced)
      const pid = await terminal.processId;
      if (pid && addNewLine && text.trim()) {
        const watcher = TerminalWatcher.getInstance();
        watcher.recordCommand(pid, text.trim(), 'mcp');
      }

      // Register command with auto-naming manager
      if (addNewLine && text.trim()) {
        terminalAutoNaming.registerCommand(terminal, text.trim()).catch(err => {
          console.error('Error registering command for auto-naming:', err);
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                sent: true,
                terminal: terminal.name,
                text: text,
                addNewLine,
                method: sentViaTmux ? 'tmux' : 'vscode',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error sending to terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_list - List all terminals
 */
function registerTerminalList(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_list',
    description: 'List all open terminals with tmux session info',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  };

  const handler = async (): Promise<ToolResult> => {
    try {
      const terminals = vscode.window.terminals;
      const activeTerminal = vscode.window.activeTerminal;
      const watcher = TerminalWatcher.getInstance();

      const terminalList = await Promise.all(
        terminals.map(async t => {
          const pid = await t.processId;
          const tmuxSession = pid ? watcher.getTmuxSession(pid) : undefined;
          const state = pid ? await watcher.getTerminalState(pid) : 'unknown';
          const terminalInfo = pid ? watcher.getTerminal(pid) : undefined;
          return {
            name: t.name,
            processId: pid,
            isActive: t === activeTerminal,
            backend: tmuxSession ? 'tmux' : 'vscode',
            tmuxSession: tmuxSession || null,
            bufferCapture: tmuxSession ? true : bufferCaptureEnabled,
            state,
            currentCommand: terminalInfo?.currentCommand || null,
          };
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: terminalList.length,
                activeTerminal: activeTerminal?.name || null,
                tmuxAvailable,
                proposedApiAvailable: bufferCaptureEnabled,
                terminals: terminalList,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing terminals: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_close - Close a terminal
 */
function registerTerminalClose(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_close',
    description: 'Close a terminal and its associated tmux session',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Terminal name to close. Omit to close active terminal.',
        },
        all: {
          type: 'boolean',
          description: 'Close all terminals',
          default: false,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const name = args.name as string | undefined;
    const closeAll = args.all as boolean;

    try {
      if (closeAll) {
        const count = vscode.window.terminals.length;

        // Clean up all tmux sessions if tmux is available
        if (tmuxAvailable) {
          const tmux = TmuxManager.getInstance();
          await tmux.cleanup();
        }

        vscode.window.terminals.forEach(t => t.dispose());
        terminalMap.clear();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ closed: count, all: true, tmuxCleanedUp: tmuxAvailable }, null, 2),
            },
          ],
        };
      }

      let terminal: vscode.Terminal | undefined;

      if (name) {
        terminal = terminalMap.get(name);
        if (!terminal) {
          terminal = vscode.window.terminals.find(t => t.name === name);
        }
      } else {
        terminal = vscode.window.activeTerminal;
      }

      if (!terminal) {
        return {
          content: [{ type: 'text', text: `Terminal not found: ${name || 'active'}` }],
          isError: true,
        };
      }

      const terminalName = terminal.name;
      let tmuxSessionClosed: string | null = null;

      // Clean up tmux session if it exists
      if (tmuxAvailable) {
        const pid = await terminal.processId;
        if (pid) {
          const watcher = TerminalWatcher.getInstance();
          const tmuxSession = watcher.getTmuxSession(pid);
          if (tmuxSession) {
            const tmux = TmuxManager.getInstance();
            await tmux.killSession(tmuxSession);
            tmuxSessionClosed = tmuxSession;
          }
        }
      }

      terminal.dispose();
      terminalMap.delete(terminalName);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              closed: terminalName,
              tmuxSessionClosed,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error closing terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

// Unique marker to detect command completion
const MCP_DONE_MARKER = '___MCP_DONE_EXIT_CODE_';

/**
 * vscode_terminal_execute - Execute command and capture output
 *
 * Enhanced version with:
 * - Marker-based completion detection (no guessing with timeout)
 * - Pagination support for large outputs
 * - Exit code capture
 */
function registerTerminalExecute(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_execute',
    description: 'Execute a command in terminal and capture its output. Uses marker-based completion detection for reliable output capture.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command to execute',
        },
        name: {
          type: 'string',
          description: 'Terminal name. Omit to use active or create new.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command',
        },
        maxWait: {
          type: 'number',
          description: 'Maximum milliseconds to wait for completion (default: 30000)',
          default: 30000,
        },
        pollInterval: {
          type: 'number',
          description: 'Milliseconds between completion checks (default: 200)',
          default: 200,
        },
        tailLines: {
          type: 'number',
          description: 'Return only last N lines of output (default: 100)',
          default: 100,
        },
        maxBytes: {
          type: 'number',
          description: 'Maximum bytes to return (default: 100000)',
          default: 100000,
        },
        keepFile: {
          type: 'boolean',
          description: 'Keep output file after reading (for manual inspection)',
          default: false,
        },
        captureStderr: {
          type: 'boolean',
          description: 'Also capture stderr (2>&1)',
          default: true,
        },
      },
      required: ['command'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const command = args.command as string;
    const terminalName = args.name as string | undefined;
    const cwd = args.cwd as string | undefined;
    const maxWait = (args.maxWait as number) ?? 30000;
    const pollInterval = (args.pollInterval as number) ?? 200;
    const tailLines = (args.tailLines as number) ?? 100;
    const maxBytes = (args.maxBytes as number) ?? 100000;
    const keepFile = (args.keepFile as boolean) ?? false;
    const captureStderr = (args.captureStderr as boolean) ?? true;

    try {
      // Create unique output file
      const timestamp = Date.now();
      const outputFile = path.join(os.tmpdir(), `mcp_exec_${timestamp}.txt`);
      const markerFile = path.join(os.tmpdir(), `mcp_marker_${timestamp}.txt`);

      // Build command with redirect and completion marker
      // The marker includes the exit code of the command
      const redirectSuffix = captureStderr ? ' 2>&1' : '';
      const cwdPrefix = cwd ? `cd "${cwd}" && ` : '';
      const fullCommand = `${cwdPrefix}${command}${redirectSuffix} > "${outputFile}"; echo "${MCP_DONE_MARKER}$?" > "${markerFile}"`;

      // Find or create terminal
      let terminal: vscode.Terminal | undefined;

      if (terminalName) {
        terminal = terminalMap.get(terminalName);
        if (!terminal) {
          terminal = vscode.window.terminals.find(t => t.name === terminalName);
        }
      } else {
        terminal = vscode.window.activeTerminal;
      }

      if (!terminal) {
        terminal = vscode.window.createTerminal('MCP Execute');
        terminalMap.set(terminal.name, terminal);
        terminal.show();
        // Give new terminal time to initialize
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Record command in terminal history (MCP-sourced)
      const pid = await terminal.processId;
      let commandId = '';
      if (pid) {
        const watcher = TerminalWatcher.getInstance();
        commandId = watcher.recordCommand(pid, command, 'mcp');
      }

      // Send the command
      terminal.sendText(fullCommand, true);

      // Poll for completion marker
      const startTime = Date.now();
      let completed = false;
      let exitCode: number | null = null;
      let timedOut = false;

      while (!completed && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        try {
          if (fs.existsSync(markerFile)) {
            const markerContent = fs.readFileSync(markerFile, 'utf-8').trim();
            if (markerContent.startsWith(MCP_DONE_MARKER)) {
              completed = true;
              exitCode = parseInt(markerContent.replace(MCP_DONE_MARKER, ''), 10);
              // Clean up marker file
              fs.unlinkSync(markerFile);
            }
          }
        } catch {
          // File might be being written, continue polling
        }
      }

      if (!completed) {
        timedOut = true;
      }

      // Read the output file
      let output = '';
      let fileExists = false;
      let totalBytes = 0;
      let totalLines = 0;
      let truncated = false;

      try {
        if (fs.existsSync(outputFile)) {
          fileExists = true;
          const stats = fs.statSync(outputFile);
          totalBytes = stats.size;

          if (tailLines > 0) {
            // Read only last N lines (default: 100)
            const content = fs.readFileSync(outputFile, 'utf-8');
            const lines = content.split('\n');
            totalLines = lines.length;
            if (lines.length > tailLines) {
              output = lines.slice(-tailLines).join('\n');
              truncated = true;
            } else {
              output = content;
            }
          } else if (totalBytes > maxBytes) {
            // Read only last maxBytes
            const fd = fs.openSync(outputFile, 'r');
            const buffer = Buffer.alloc(maxBytes);
            fs.readSync(fd, buffer, 0, maxBytes, totalBytes - maxBytes);
            fs.closeSync(fd);
            output = '...(truncated)...\n' + buffer.toString('utf-8');
            truncated = true;
          } else {
            output = fs.readFileSync(outputFile, 'utf-8');
          }

          // Clean up output file unless keepFile is true
          if (!keepFile) {
            fs.unlinkSync(outputFile);
          }
        }

        // Register command with auto-naming manager (with output)
        terminalAutoNaming.registerCommand(terminal, command, output).catch(err => {
          console.error('Error registering command for auto-naming:', err);
        });

        // Complete command record in terminal history
        if (pid && commandId) {
          const watcher = TerminalWatcher.getInstance();
          watcher.completeCommand(pid, commandId, output, exitCode ?? undefined, !completed);
        }
      } catch (readError) {
        output = `(Could not read output file: ${readError})`;
        // Mark command as error
        if (pid && commandId) {
          const watcher = TerminalWatcher.getInstance();
          watcher.completeCommand(pid, commandId, String(readError), undefined, true);
        }
      }

      // Clean up marker file if it exists (in case of timeout)
      try {
        if (fs.existsSync(markerFile)) {
          fs.unlinkSync(markerFile);
        }
      } catch {
        // Ignore cleanup errors
      }

      const elapsedMs = Date.now() - startTime;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                executed: true,
                completed,
                timedOut,
                exitCode,
                command,
                terminal: terminal.name,
                cwd: cwd || '(terminal default)',
                elapsedMs,
                outputFile: keepFile ? outputFile : '(deleted)',
                totalBytes,
                totalLines: totalLines || output.split('\n').length,
                truncated,
                output,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error executing command: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_read_output - Read output from a previous command
 *
 * For reading large outputs with pagination, or re-reading a kept output file
 */
function registerTerminalReadOutput(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_read_output',
    description: 'Read output from a file with pagination support. Useful for reading large outputs or re-reading kept output files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to output file',
        },
        offset: {
          type: 'number',
          description: 'Start reading from this byte offset (default: 0)',
          default: 0,
        },
        limit: {
          type: 'number',
          description: 'Maximum bytes to read (default: 50000)',
          default: 50000,
        },
        tailLines: {
          type: 'number',
          description: 'Instead of offset/limit, return last N lines',
        },
        headLines: {
          type: 'number',
          description: 'Instead of offset/limit, return first N lines',
        },
        grep: {
          type: 'string',
          description: 'Filter lines containing this string',
        },
        delete: {
          type: 'boolean',
          description: 'Delete file after reading',
          default: false,
        },
      },
      required: ['file'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = args.file as string;
    const offset = (args.offset as number) ?? 0;
    const limit = (args.limit as number) ?? 50000;
    const tailLines = args.tailLines as number | undefined;
    const headLines = args.headLines as number | undefined;
    const grep = args.grep as string | undefined;
    const deleteAfter = (args.delete as boolean) ?? false;

    try {
      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: 'text', text: `File not found: ${filePath}` }],
          isError: true,
        };
      }

      const stats = fs.statSync(filePath);
      const totalBytes = stats.size;
      let output = '';
      let linesReturned = 0;

      if (tailLines !== undefined || headLines !== undefined || grep !== undefined) {
        // Line-based reading
        const content = fs.readFileSync(filePath, 'utf-8');
        let lines = content.split('\n');
        const totalLines = lines.length;

        if (grep) {
          lines = lines.filter(line => line.includes(grep));
        }

        if (tailLines !== undefined) {
          lines = lines.slice(-tailLines);
        } else if (headLines !== undefined) {
          lines = lines.slice(0, headLines);
        }

        output = lines.join('\n');
        linesReturned = lines.length;

        if (deleteAfter) {
          fs.unlinkSync(filePath);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  file: filePath,
                  totalBytes,
                  totalLines,
                  linesReturned,
                  filtered: grep ? true : false,
                  deleted: deleteAfter,
                  output,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Byte-based reading with offset/limit
      const fd = fs.openSync(filePath, 'r');
      const readSize = Math.min(limit, totalBytes - offset);
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, offset);
      fs.closeSync(fd);
      output = buffer.toString('utf-8');

      if (deleteAfter) {
        fs.unlinkSync(filePath);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                file: filePath,
                totalBytes,
                offset,
                bytesRead: readSize,
                hasMore: offset + readSize < totalBytes,
                nextOffset: offset + readSize,
                deleted: deleteAfter,
                output,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading file: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_show - Show/switch to a specific terminal
 */
function registerTerminalShow(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_show',
    description: 'Show/switch to a specific terminal by name. Makes it the active terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Terminal name to show/activate',
        },
        preserveFocus: {
          type: 'boolean',
          description: 'If true, the terminal will not take focus',
          default: false,
        },
      },
      required: ['name'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const name = args.name as string;
    const preserveFocus = (args.preserveFocus as boolean) ?? false;

    try {
      let terminal = terminalMap.get(name);
      if (!terminal) {
        terminal = vscode.window.terminals.find(t => t.name === name);
      }

      if (!terminal) {
        return {
          content: [{ type: 'text', text: `Terminal not found: ${name}` }],
          isError: true,
        };
      }

      terminal.show(preserveFocus);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                shown: true,
                name: terminal.name,
                preserveFocus,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error showing terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_run_quick - Quick command execution with sensible defaults
 *
 * Designed for quick checks like `git status`, `ls`, etc.
 * Returns last 100 lines by default, shorter timeout.
 */
function registerTerminalRunQuick(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_run_quick',
    description: 'Run a quick command and get last 100 lines of output. Optimized for fast commands like git status, ls, etc. For long-running commands, use vscode_terminal_execute instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command to execute',
        },
        name: {
          type: 'string',
          description: 'Terminal name. Omit to use active terminal.',
        },
        lines: {
          type: 'number',
          description: 'Number of lines to return (default: 100)',
          default: 100,
        },
        timeout: {
          type: 'number',
          description: 'Max wait in milliseconds (default: 10000)',
          default: 10000,
        },
      },
      required: ['command'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const command = args.command as string;
    const terminalName = args.name as string | undefined;
    const lines = (args.lines as number) ?? 100;
    const timeout = (args.timeout as number) ?? 10000;

    try {
      // Create unique output file
      const timestamp = Date.now();
      const outputFile = path.join(os.tmpdir(), `mcp_quick_${timestamp}.txt`);
      const markerFile = path.join(os.tmpdir(), `mcp_qmark_${timestamp}.txt`);

      const fullCommand = `${command} 2>&1 > "${outputFile}"; echo "${MCP_DONE_MARKER}$?" > "${markerFile}"`;

      // Find terminal
      let terminal: vscode.Terminal | undefined;
      if (terminalName) {
        terminal = terminalMap.get(terminalName);
        if (!terminal) {
          terminal = vscode.window.terminals.find(t => t.name === terminalName);
        }
      } else {
        terminal = vscode.window.activeTerminal;
      }

      if (!terminal) {
        terminal = vscode.window.createTerminal('MCP Quick');
        terminalMap.set(terminal.name, terminal);
        terminal.show();
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Record command in terminal history (MCP-sourced)
      const pid = await terminal.processId;
      let commandId = '';
      if (pid) {
        const watcher = TerminalWatcher.getInstance();
        commandId = watcher.recordCommand(pid, command, 'mcp');
      }

      terminal.sendText(fullCommand, true);

      // Poll for completion
      const startTime = Date.now();
      let completed = false;
      let exitCode: number | null = null;

      while (!completed && (Date.now() - startTime) < timeout) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try {
          if (fs.existsSync(markerFile)) {
            const markerContent = fs.readFileSync(markerFile, 'utf-8').trim();
            if (markerContent.startsWith(MCP_DONE_MARKER)) {
              completed = true;
              exitCode = parseInt(markerContent.replace(MCP_DONE_MARKER, ''), 10);
              fs.unlinkSync(markerFile);
            }
          }
        } catch {
          // Continue polling
        }
      }

      // Read output
      let output = '';
      let totalLines = 0;
      let truncated = false;

      try {
        if (fs.existsSync(outputFile)) {
          const content = fs.readFileSync(outputFile, 'utf-8');
          const allLines = content.split('\n');
          totalLines = allLines.length;

          if (allLines.length > lines) {
            output = allLines.slice(-lines).join('\n');
            truncated = true;
          } else {
            output = content;
          }
          fs.unlinkSync(outputFile);
        }
      } catch {
        output = '(Could not read output)';
      }

      // Register command with auto-naming manager (with output)
      terminalAutoNaming.registerCommand(terminal, command, output).catch(err => {
        console.error('Error registering command for auto-naming:', err);
      });

      // Complete command record in terminal history
      if (pid && commandId) {
        const watcher = TerminalWatcher.getInstance();
        watcher.completeCommand(pid, commandId, output, exitCode ?? undefined, !completed);
      }

      // Cleanup
      try {
        if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
      } catch {}

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                command,
                terminal: terminal.name,
                completed,
                timedOut: !completed,
                exitCode,
                totalLines,
                linesReturned: Math.min(lines, totalLines),
                truncated,
                output,
                hint: truncated ? `Output truncated. Use vscode_terminal_execute with higher tailLines to see more.` : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_read_buffer - Read captured terminal output from buffer
 *
 * This reads from the live buffer that captures ALL terminal output,
 * including interactive apps like Claude, vim, htop, etc.
 * Works even when the Mac is locked!
 *
 * ENHANCED: Uses tmux buffer when available for 50,000 line scrollback!
 */
function registerTerminalReadBuffer(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_read_buffer',
    description: 'Read captured terminal output from buffer. Uses tmux (50,000 line scrollback) when available, otherwise falls back to memory buffer. Works for interactive apps!',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Terminal name to read from',
        },
        lines: {
          type: 'number',
          description: 'Number of lines to return from end (default: 50, max: 50000 with tmux)',
          default: 50,
        },
        stripAnsiCodes: {
          type: 'boolean',
          description: 'Remove ANSI escape codes for cleaner output (default: true)',
          default: true,
        },
        search: {
          type: 'string',
          description: 'Optional: Only return lines containing this text',
        },
        all: {
          type: 'boolean',
          description: 'Return all buffered content (up to 50KB with memory buffer, 50,000 lines with tmux)',
          default: false,
        },
      },
      required: ['name'],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const name = args.name as string;
    const lines = (args.lines as number) ?? 50;
    const stripCodes = (args.stripAnsiCodes as boolean) ?? true;
    const search = args.search as string | undefined;
    const all = (args.all as boolean) ?? false;

    try {
      // Find terminal by name
      let terminal = terminalMap.get(name);
      if (!terminal) {
        terminal = vscode.window.terminals.find(t => t.name === name);
      }

      if (!terminal) {
        // List available terminals
        const available = vscode.window.terminals.map(t => t.name);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Terminal not found: ${name}`,
              availableTerminals: available,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Get process ID
      const pid = await terminal.processId;
      if (!pid) {
        return {
          content: [{
            type: 'text',
            text: `Terminal "${name}" has no process ID (may be closed)`,
          }],
          isError: true,
        };
      }

      let buffer: string = '';
      let source: 'tmux' | 'memory' | 'none' = 'none';
      let maxLines = 50000; // tmux default

      // Try tmux first
      const watcher = TerminalWatcher.getInstance();
      const tmuxSession = watcher.getTmuxSession(pid);

      if (tmuxSession && tmuxAvailable) {
        const tmux = TmuxManager.getInstance();
        if (all) {
          buffer = await tmux.readFullBuffer(tmuxSession);
        } else {
          buffer = await tmux.readBuffer(tmuxSession, lines);
        }
        source = 'tmux';
      } else if (bufferCaptureEnabled) {
        // Fall back to memory buffer
        buffer = terminalBuffers.get(pid) || '';
        source = 'memory';
        maxLines = MAX_BUFFER_SIZE / 50; // Rough estimate
      }

      if (!buffer && source === 'none') {
        // No buffer capture available
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Terminal buffer capture is not available for this terminal',
              terminal: name,
              pid,
              tmuxAvailable,
              proposedApiAvailable: bufferCaptureEnabled,
              hint: tmuxAvailable
                ? 'Create a new terminal with vscode_terminal_create to get tmux-backed buffer capture'
                : 'Use vscode_terminal_execute instead, which captures output to files',
            }, null, 2),
          }],
          isError: true,
        };
      }

      if (!buffer) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              terminal: name,
              pid,
              bufferSize: 0,
              source,
              message: 'No output captured yet. Buffer starts capturing when terminal writes output.',
              hint: 'Try sending a command to the terminal first, then read buffer again.',
            }, null, 2),
          }],
        };
      }

      // Process buffer
      let content = stripCodes ? stripAnsi(buffer) : buffer;
      let allLines = content.split('\n');
      const totalLines = allLines.length;

      // Filter by search term if provided
      if (search) {
        allLines = allLines.filter(line => line.includes(search));
      }

      // Get last N lines unless 'all' is requested
      let outputLines: string[];
      if (all) {
        outputLines = allLines;
      } else {
        outputLines = allLines.slice(-lines);
      }

      const output = outputLines.join('\n');

      // Get terminal state
      const state = await watcher.getTerminalState(pid);
      const terminalInfo = watcher.getTerminal(pid);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            terminal: name,
            pid,
            source,
            maxScrollback: source === 'tmux' ? maxLines : (source === 'memory' ? `~${maxLines} chars` : 0),
            bufferSize: buffer.length,
            totalLines,
            linesReturned: outputLines.length,
            filtered: search ? true : false,
            searchTerm: search || null,
            strippedAnsi: stripCodes,
            state,
            currentCommand: terminalInfo?.currentCommand || null,
            output,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading terminal buffer: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}

/**
 * vscode_terminal_rename - Manually trigger AI-based terminal naming
 */
function registerTerminalRename(): void {
  const definition: MCPTool = {
    name: 'vscode_terminal_rename',
    description: 'Manually trigger AI-based terminal naming. Analyzes terminal context (commands, outputs, open files) to generate a descriptive name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Terminal name to rename. Omit to use active terminal.',
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const terminalName = args.name as string | undefined;

    try {
      if (!terminalAutoNaming.isEnabled()) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Terminal auto-naming is not enabled',
              reason: 'OpenRouter API key not found or feature disabled in settings',
              hint: 'Configure API key in macOS Keychain with: security add-generic-password -a "vscode-mcp-server" -s "openrouter-api-key" -w "YOUR_KEY"'
            }, null, 2),
          }],
          isError: true,
        };
      }

      let terminal: vscode.Terminal | undefined;

      if (terminalName) {
        terminal = terminalMap.get(terminalName);
        if (!terminal) {
          terminal = vscode.window.terminals.find(t => t.name === terminalName);
        }
      } else {
        terminal = vscode.window.activeTerminal;
      }

      if (!terminal) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Terminal not found',
              hint: 'Create a terminal first with vscode_terminal_create or use an existing terminal'
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Get current activity for context
      const activity = await terminalAutoNaming.getActivity(terminal);

      const suggestedName = await terminalAutoNaming.nameTerminal(terminal);

      if (!suggestedName) {
        return {
          content: [{ type: 'text', text: 'Failed to generate terminal name' }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            terminal: terminal.name,
            suggestedName,
            commandCount: activity?.commandCount || 0,
            note: 'VS Code API does not support renaming terminals directly. The suggested name is shown in a notification.',
            instructions: 'To manually rename: Right-click terminal tab > Rename (if supported by your terminal)'
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error renaming terminal: ${error}` }],
        isError: true,
      };
    }
  };

  registerTool(definition, handler);
}
