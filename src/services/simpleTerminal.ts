import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

export interface SimpleTerminal {
  sessionName: string;
  sendInput: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * Create a simple tmux-backed terminal
 *
 * Minimal implementation:
 * - Creates tmux session with pipe-pane for output
 * - Streams output to callback via named pipe
 * - Handles input via send-keys
 */
export async function createSimpleTerminal(
  cwd: string,
  onData: (text: string) => void
): Promise<SimpleTerminal> {
  // 1. Generate unique session name
  const sessionName = `xvsc_${Date.now()}`;
  const pipePath = path.join(os.tmpdir(), `${sessionName}.pipe`);

  // 2. Detect shell
  const shell = process.env.SHELL || '/bin/bash';

  // 3. Create tmux session with interactive login shell
  await execAsync(`tmux new-session -d -s ${sessionName} -c "${cwd}" "${shell}" -il`);
  await execAsync(`tmux set-option -t ${sessionName} history-limit 50000`);
  await execAsync(`tmux set-option -t ${sessionName} status off`);

  // 4. Set up named pipe for streaming
  try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
  await execAsync(`mkfifo "${pipePath}"`);
  try { await execAsync(`tmux pipe-pane -t ${sessionName}`); } catch { /* ignore */ }
  await execAsync(`tmux pipe-pane -t ${sessionName} 'cat > "${pipePath}"'`);

  // 5. Start reading from pipe
  const reader = fs.createReadStream(pipePath, { encoding: 'utf8' });
  reader.on('data', (chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    onData(text);
  });
  reader.on('error', (err) => {
    console.error(`[SimpleTerminal] Pipe read error for ${sessionName}:`, err);
  });

  // 6. Wait for shell to initialize, then send snapshot
  await new Promise(r => setTimeout(r, 300));
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${sessionName} -p -e`);
    if (stdout) onData(stdout);
  } catch { /* ignore snapshot errors */ }

  return {
    sessionName,

    async sendInput(data: string) {
      // Send raw keys to tmux (handles special chars properly)
      const escaped = data.replace(/'/g, "'\"'\"'");
      await execAsync(`tmux send-keys -t ${sessionName} -l '${escaped}'`);
    },

    async resize(cols: number, rows: number) {
      if (cols > 0 && rows > 0) {
        try {
          await execAsync(`tmux resize-window -t ${sessionName} -x ${cols} -y ${rows}`);
        } catch {
          // Ignore resize errors (session may not have a window yet)
        }
      }
    },

    async dispose() {
      reader.destroy();
      try { await execAsync(`tmux pipe-pane -t ${sessionName}`); } catch { /* ignore */ }
      try { await execAsync(`tmux kill-session -t ${sessionName}`); } catch { /* ignore */ }
      try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
    }
  };
}
