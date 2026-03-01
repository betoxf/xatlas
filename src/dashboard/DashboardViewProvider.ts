import * as vscode from 'vscode';
import { AgentDiscovery, ProjectInfo } from '../services/agentDiscovery';
import { TerminalWatcher } from '../services/terminalWatcher';

/**
 * Provider for the AI Agent Dashboard sidebar webview
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiAgentDashboard';

  private view?: vscode.WebviewView;
  private agentDiscovery: AgentDiscovery;
  private terminalWatcher: TerminalWatcher;
  private updateInterval?: NodeJS.Timeout;
  private isRefreshing = false;
  private pendingRefresh = false;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.terminalWatcher = TerminalWatcher.getInstance();
    this.agentDiscovery = AgentDiscovery.getInstance(this.terminalWatcher);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.handleWebviewMessage(message);
    });

    // Start auto-refresh when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refreshData();
        this.startAutoRefresh();
      } else {
        this.stopAutoRefresh();
      }
    });

    // Initial refresh
    if (webviewView.visible) {
      this.refreshData();
      this.startAutoRefresh();
    }
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    switch (message.command) {
      case 'refresh':
        await this.refreshData();
        break;

      case 'sendCommand':
        this.terminalWatcher.sendText(message.terminalId, message.text);
        break;

      case 'startAgent':
        const { AgentLauncher } = await import('../services/agentLauncher');
        const launcher = AgentLauncher.getInstance();
        await launcher.startAgent(message.agentType, message.projectPath);
        await this.refreshData();
        break;

      case 'stopAgent':
        for (const terminal of vscode.window.terminals) {
          const pid = await terminal.processId;
          if (pid === message.terminalId) {
            terminal.dispose();
            break;
          }
        }
        await this.refreshData();
        break;

      case 'showTerminal':
        this.terminalWatcher.showTerminal(message.terminalId);
        break;

      case 'focusTerminal':
        await this.focusRealTerminal(message.terminalId);
        break;

      case 'addProject':
        await this.showAddProjectPicker();
        break;

      case 'getTerminalOutput':
        const output = this.terminalWatcher.getOutput(message.terminalId);
        this.view?.webview.postMessage({
          type: 'terminalOutput',
          terminalId: message.terminalId,
          output: output || '',
        });
        break;

      case 'openFullDashboard':
        vscode.commands.executeCommand('vscode-mcp-server.openDashboard');
        break;

      case 'reorderProjects':
        if (Array.isArray(message.order)) {
          this.agentDiscovery.setProjectOrder(message.order);
          await this.refreshData();
        }
        break;
    }
  }

  private async refreshData(): Promise<void> {
    if (!this.view) return;

    if (this.isRefreshing) {
      this.pendingRefresh = true;
      return;
    }

    this.isRefreshing = true;
    try {
      const projects = await this.agentDiscovery.discoverProjects();
      const config = vscode.workspace.getConfiguration('vscode-mcp-server');
      const coloredPreviews = config.get<boolean>('coloredPreviews', true);

      this.view.webview.postMessage({
        type: 'projectsUpdate',
        projects,
        coloredPreviews,
      });
    } finally {
      this.isRefreshing = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        void this.refreshData();
      }
    }
  }

  /**
   * Focus the real VS Code terminal for full terminal experience with autocompletion
   */
  private async focusRealTerminal(terminalId: number): Promise<void> {
    const terminals = vscode.window.terminals;
    for (const terminal of terminals) {
      const pid = await terminal.processId;
      if (pid === terminalId) {
        terminal.show(false);
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
        break;
      }
    }
  }

  private async showAddProjectPicker(): Promise<void> {
    interface FolderItem extends vscode.QuickPickItem {
      folderPath?: string;
      action?: 'browse';
    }

    const items: FolderItem[] = [];

    // Add currently open workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      items.push({
        label: '$(folder-opened) Open Workspaces',
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const folder of workspaceFolders) {
        items.push({
          label: `$(folder) ${folder.name}`,
          description: folder.uri.fsPath,
          folderPath: folder.uri.fsPath,
        });
      }
    }

    // Try to get recent folders from VS Code
    try {
      const recentlyOpened = await vscode.commands.executeCommand<{
        workspaces?: Array<{ folderUri?: vscode.Uri; workspace?: { configPath: vscode.Uri } }>;
      }>('_workbench.getRecentlyOpened');

      if (recentlyOpened?.workspaces && recentlyOpened.workspaces.length > 0) {
        items.push({
          label: '$(history) Recent',
          kind: vscode.QuickPickItemKind.Separator,
        });

        const openPaths = new Set(workspaceFolders?.map(f => f.uri.fsPath) || []);

        for (const workspace of recentlyOpened.workspaces.slice(0, 10)) {
          const uri = workspace.folderUri || workspace.workspace?.configPath;
          if (uri && !openPaths.has(uri.fsPath)) {
            const name = uri.fsPath.split('/').pop() || uri.fsPath;
            items.push({
              label: `$(folder) ${name}`,
              description: uri.fsPath,
              folderPath: uri.fsPath,
            });
          }
        }
      }
    } catch {
      // Recent workspaces API not available, continue without it
    }

    // Add browse option
    items.push({
      label: '$(search) Browse...',
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push({
      label: '$(folder-opened) Open Folder...',
      description: 'Select a folder from your filesystem',
      action: 'browse',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a project folder',
      title: 'Add Project',
    });

    if (!selected) return;

    let folderPath: string | undefined;

    if (selected.action === 'browse') {
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Project Folder',
      });
      if (folderUri && folderUri[0]) {
        folderPath = folderUri[0].fsPath;
      }
    } else if (selected.folderPath) {
      folderPath = selected.folderPath;
    }

    if (folderPath) {
      const projectName = folderPath.split('/').pop() || 'Project';

      // Add to tracked projects
      this.agentDiscovery.addProject(folderPath, projectName);
      await this.refreshData();
    }
  }

  private startAutoRefresh(): void {
    if (this.updateInterval) return;
    this.updateInterval = setInterval(() => this.refreshData(), 5000);
  }

  private stopAutoRefresh(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Operator</title>
  <style>
    :root {
      --bg-primary: var(--vscode-editor-background);
      --bg-secondary: var(--vscode-sideBar-background);
      --bg-card: var(--vscode-editorWidget-background);
      --border-color: var(--vscode-panel-border);
      --text-primary: var(--vscode-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --text-muted: var(--vscode-disabledForeground);
      --accent-blue: var(--vscode-button-background);
      --terminal-bg: var(--vscode-terminal-background, #1a1a1a);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: clamp(11px, 1.3vw, var(--vscode-font-size));
      background: transparent;
      color: var(--text-primary);
      padding: 8px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-color);
    }

    .header h2 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
    }

    .header-actions {
      display: flex;
      gap: 4px;
    }

    .btn {
      background: #000;
      border: 1px solid #fff;
      color: #fff;
      padding: 4px 6px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
    }

    .btn:hover {
      background: #fff;
      color: #000;
    }

    .project-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .project-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      transition: border-color 0.15s;
    }

    .project-card:hover {
      border-color: var(--accent-blue);
    }

    .project-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-color);
      gap: 8px;
      flex-wrap: nowrap;
    }

    .project-name {
      font-size: clamp(11px, 1.6vw, 13px);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
    }

    .agent-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: clamp(9px, 1.3vw, 11px);
      padding: 2px 6px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    .status-dot.active { animation: pulse 2s infinite; }
    .status-dot.status-running { background: #22c55e; }
    .status-dot.status-waiting { background: #ff6b00; }
    .status-dot.status-idle { background: var(--text-muted); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .terminal-preview {
      background: var(--terminal-bg);
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: clamp(10px, 1.5vw, 12px);
      line-height: 1.35;
      max-height: 76px;
      overflow: hidden;
      color: var(--text-secondary);
      white-space: pre;
      word-break: normal;
    }

    .card-actions {
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      background: var(--bg-card);
      border-top: 1px solid var(--border-color);
    }

    .card-btn {
      flex: 1;
      padding: 4px 8px;
      font-size: clamp(9px, 1.3vw, 11px);
      background: #000;
      border: 1px solid #fff;
      border-radius: 3px;
      color: #fff;
      cursor: pointer;
    }

    .card-btn:hover {
      background: #fff;
      color: #000;
    }

    .card-btn-primary {
      background: #000;
      color: #fff;
      border-color: #fff;
    }

    .card-btn-primary:hover {
      background: #fff;
      color: #000;
    }

    .add-project {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 12px;
      margin-top: 12px;
      border: 1px dashed var(--border-color);
      border-radius: 4px;
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .add-project:hover {
      border-color: var(--accent-blue);
      color: var(--text-primary);
      background: var(--vscode-list-hoverBackground);
    }

    /* Drag and drop styles */
    .project-card[draggable="true"] {
      cursor: grab;
    }

    .project-card.dragging {
      opacity: 0.5;
      cursor: grabbing;
    }

    .project-card.drag-over {
      border-color: var(--accent-blue);
      border-style: dashed;
      background: var(--vscode-list-hoverBackground);
    }

    .project-card.drag-over-top {
      border-top: 2px solid var(--accent-blue);
    }

    .project-card.drag-over-bottom {
      border-bottom: 2px solid var(--accent-blue);
    }

    .empty-state {
      text-align: center;
      padding: 24px 12px;
      color: var(--text-muted);
      font-size: 11px;
    }

    .open-full-btn {
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 16px;
      background: #000;
      border: 1px solid #fff;
      border-radius: 4px;
      color: #fff;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }

    .open-full-btn:hover {
      background: #fff;
      color: #000;
    }

  </style>
</head>
<body>
  <button class="open-full-btn" id="openFullBtn">Open Full Dashboard</button>

  <div class="header">
    <h2>Operator</h2>
    <div class="header-actions">
      <button class="btn" id="addBtn" title="Add Project">+</button>
      <button class="btn" id="refreshBtn" title="Refresh">&#8635;</button>
    </div>
  </div>

  <div class="project-list" id="projectList">
    <div class="empty-state">No projects detected</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let projects = [];

    const projectList = document.getElementById('projectList');
    const previewFontSizing = {
      min: 8,
      max: 12,
      base: 10,
      charWidth: 0,
      fontFamily: '',
      fontSize: 10
    };

    function measurePreviewCharWidth(preview) {
      if (!preview) return previewFontSizing.charWidth || 0;
      const styles = getComputedStyle(preview);
      const fontFamily = styles.fontFamily || 'monospace';
      const fontSize = parseFloat(styles.fontSize) || previewFontSizing.base;

      if (
        previewFontSizing.charWidth &&
        previewFontSizing.fontFamily === fontFamily &&
        previewFontSizing.fontSize === fontSize
      ) {
        return previewFontSizing.charWidth;
      }

      const probe = document.createElement('span');
      probe.textContent = 'MMMMMMMMMM';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.style.fontFamily = fontFamily;
      probe.style.fontSize = fontSize + 'px';
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width / 10;
      probe.remove();

      previewFontSizing.charWidth = width || previewFontSizing.charWidth || 6;
      previewFontSizing.fontFamily = fontFamily;
      previewFontSizing.fontSize = fontSize;
      return previewFontSizing.charWidth;
    }

    function fitPreviewText(preview, text) {
      if (!preview) return;
      const content = text || preview.textContent || '';
      if (!content) {
        preview.style.fontSize = '';
        return;
      }

      const lines = content.split('\\n');
      const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
      if (!longestLine) {
        preview.style.fontSize = '';
        return;
      }

      const styles = getComputedStyle(preview);
      const paddingLeft = parseFloat(styles.paddingLeft) || 0;
      const paddingRight = parseFloat(styles.paddingRight) || 0;
      const availableWidth = preview.clientWidth - paddingLeft - paddingRight;

      if (availableWidth <= 0) {
        return;
      }

      const charWidth = measurePreviewCharWidth(preview);
      if (!charWidth) {
        return;
      }

      const baseFont = previewFontSizing.fontSize || previewFontSizing.base;
      const targetFont = Math.floor((availableWidth * baseFont) / (longestLine * charWidth));
      const clamped = Math.max(previewFontSizing.min, Math.min(previewFontSizing.max, targetFont));
      preview.style.fontSize = clamped + 'px';
    }

    function refreshPreviewFonts() {
      const previews = projectList.querySelectorAll('.terminal-preview');
      previews.forEach((preview) => {
        fitPreviewText(preview);
      });
    }

    document.getElementById('addBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'addProject' });
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('openFullBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'openFullDashboard' });
    });

    let coloredPreviews = true;

    // ANSI color mappings
    const ANSI_COLORS = {
      30: '#000', 31: '#c00', 32: '#0c0', 33: '#cc0',
      34: '#00c', 35: '#c0c', 36: '#0cc', 37: '#ccc',
      90: '#666', 91: '#f00', 92: '#0f0', 93: '#ff0',
      94: '#00f', 95: '#f0f', 96: '#0ff', 97: '#fff',
    };

    // XSS prevention: escape HTML entities BEFORE wrapping in spans
    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Convert ANSI escape codes to styled HTML spans
    // Uses regex with \\x1b to match the ESC character (ASCII 27)

    function hasAnsiCodes(text) {
      return /\\x1b\\[/.test(text);
    }

    function ansiToHtml(text) {
      let result = '';
      let currentColor = null;
      let currentBold = false;
      let lastIndex = 0;

      // Use regex.exec() to iterate through ANSI sequences
      const regex = /\\x1b\\[([0-9;]*)m/g;
      let match;

      while ((match = regex.exec(text)) !== null) {
        // Add text before this match
        const textBefore = text.slice(lastIndex, match.index);
        if (textBefore) {
          const escaped = escapeHtml(textBefore);
          if (currentColor) {
            result += '<span style="color:' + currentColor + (currentBold ? ';font-weight:bold' : '') + '">' + escaped + '</span>';
          } else if (currentBold) {
            result += '<span style="font-weight:bold">' + escaped + '</span>';
          } else {
            result += escaped;
          }
        }

        // Parse ANSI code parameters
        const codes = match[1] ? match[1].split(';').map(c => parseInt(c, 10) || 0) : [0];
        for (const code of codes) {
          if (code === 0) { currentColor = null; currentBold = false; }
          else if (code === 1) { currentBold = true; }
          else if (code === 22) { currentBold = false; }
          else if (code >= 30 && code <= 37) { currentColor = ANSI_COLORS[code]; }
          else if (code >= 90 && code <= 97) { currentColor = ANSI_COLORS[code]; }
          else if (code === 39) { currentColor = null; }
        }

        lastIndex = regex.lastIndex;
      }

      // Add remaining text after last match
      const remaining = text.slice(lastIndex);
      if (remaining) {
        const escaped = escapeHtml(remaining);
        if (currentColor) {
          result += '<span style="color:' + currentColor + (currentBold ? ';font-weight:bold' : '') + '">' + escaped + '</span>';
        } else if (currentBold) {
          result += '<span style="font-weight:bold">' + escaped + '</span>';
        } else {
          result += escaped;
        }
      }

      return result;
    }

    // Strip all ANSI escape sequences for plain text
    function stripAnsi(text) {
      return text.replace(/\\x1b\\[[0-9;]*m/g, '');
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'projectsUpdate') {
        projects = message.projects || [];
        coloredPreviews = message.coloredPreviews !== false;
        renderProjects();
      }
    });

    window.addEventListener('resize', () => {
      refreshPreviewFonts();
    });

    // Drag and drop state
    let draggedProjectPath = null;
    let draggedCard = null;

    function handleDragStart(e, projectPath) {
      draggedProjectPath = projectPath;
      draggedCard = e.currentTarget;
      e.currentTarget.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', projectPath);
    }

    function handleDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      draggedProjectPath = null;
      draggedCard = null;
      // Remove all drag-over classes
      document.querySelectorAll('.drag-over, .drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
      });
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const card = e.currentTarget;
      if (card === draggedCard) return;

      // Remove previous indicators
      document.querySelectorAll('.drag-over, .drag-over-top, .drag-over-bottom').forEach(el => {
        if (el !== card) el.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
      });

      card.classList.add('drag-over');
    }

    function handleDragLeave(e) {
      e.currentTarget.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
    }

    function handleDrop(e, targetProjectPath) {
      e.preventDefault();
      const card = e.currentTarget;
      card.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');

      if (!draggedProjectPath || draggedProjectPath === targetProjectPath) return;

      // Build new order
      const currentOrder = projects.map(p => p.path);
      const fromIndex = currentOrder.indexOf(draggedProjectPath);
      const toIndex = currentOrder.indexOf(targetProjectPath);

      if (fromIndex === -1 || toIndex === -1) return;

      // Remove from old position and insert at new position
      currentOrder.splice(fromIndex, 1);
      currentOrder.splice(toIndex, 0, draggedProjectPath);

      // Send new order to extension
      vscode.postMessage({ command: 'reorderProjects', order: currentOrder });
    }

    function renderProjects() {
      if (projects.length === 0) {
        projectList.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No projects detected. Click + to add one.';
        projectList.appendChild(empty);
        return;
      }

      projectList.textContent = '';

      projects.forEach(project => {
        const card = document.createElement('div');
        card.className = 'project-card';

        // Make card draggable
        card.draggable = true;
        card.addEventListener('dragstart', (e) => handleDragStart(e, project.path));
        card.addEventListener('dragend', handleDragEnd);
        card.addEventListener('dragover', handleDragOver);
        card.addEventListener('dragleave', handleDragLeave);
        card.addEventListener('drop', (e) => handleDrop(e, project.path));

        const header = document.createElement('div');
        header.className = 'project-header';

        const name = document.createElement('span');
        name.className = 'project-name';
        name.textContent = project.name;

        const badge = document.createElement('span');
        badge.className = 'agent-badge';

        const activeAgent = project.agents && project.agents.find(a => a.isActive);
        const hasTerminals = project.terminals && project.terminals.length > 0;
        const firstTerminal = hasTerminals && project.terminals[0];

        // Use terminal state if available, otherwise infer from activity
        let activity = 'idle';
        if (firstTerminal && firstTerminal.state) {
          // Map terminal state to activity: running, idle, waiting_for_input, unknown
          if (firstTerminal.state === 'running') activity = 'running';
          else if (firstTerminal.state === 'waiting_for_input') activity = 'waiting';
          else if (firstTerminal.state === 'idle') activity = 'idle';
          else activity = hasTerminals ? 'running' : 'idle';
        } else if (project.activity) {
          activity = project.activity;
        } else if (hasTerminals) {
          activity = 'running';
        }

        const activityLabel = activity === 'waiting' ? 'Waiting' : activity === 'running' ? 'Running' : 'Idle';
        const badgeLabel = activeAgent ? (activeAgent.name + ' - ' + activityLabel) : activityLabel;

        const dot = document.createElement('span');
        dot.className = 'status-dot status-' + activity + (activity === 'running' ? ' active' : '');

        const badgeText = document.createElement('span');
        badgeText.textContent = badgeLabel;

        badge.appendChild(dot);
        badge.appendChild(badgeText);
        header.appendChild(name);
        header.appendChild(badge);
        card.appendChild(header);

        const preview = document.createElement('div');
        preview.className = 'terminal-preview';
        const previewText = (firstTerminal && firstTerminal.lastOutput) || '> _';

        // Use ANSI color rendering if enabled, otherwise strip codes and use textContent
        // Note: ansiToHtml is XSS-safe - it escapes HTML entities before wrapping in spans
        if (coloredPreviews && hasAnsiCodes(previewText)) {
          preview.innerHTML = ansiToHtml(previewText);
        } else {
          preview.textContent = stripAnsi(previewText);
        }
        card.appendChild(preview);

        // Card actions
        const cardActions = document.createElement('div');
        cardActions.className = 'card-actions';

        const openTerminalBtn = document.createElement('button');
        openTerminalBtn.className = 'card-btn card-btn-primary';
        openTerminalBtn.textContent = 'Open Terminal';
        openTerminalBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (firstTerminal) {
            vscode.postMessage({ command: 'focusTerminal', terminalId: firstTerminal.processId });
          }
        });

        cardActions.appendChild(openTerminalBtn);
        card.appendChild(cardActions);

        card.addEventListener('click', () => {
          if (firstTerminal) {
            vscode.postMessage({ command: 'showTerminal', terminalId: firstTerminal.processId });
          }
        });

        projectList.appendChild(card);
        // Use stripped text for font sizing calculation (ANSI codes don't contribute to width)
        fitPreviewText(preview, stripAnsi(previewText));
      });

      const addCard = document.createElement('div');
      addCard.className = 'add-project';
      addCard.textContent = '+ Add Project';
      addCard.addEventListener('click', () => {
        vscode.postMessage({ command: 'addProject' });
      });
      projectList.appendChild(addCard);
    }

    vscode.postMessage({ command: 'refresh' });
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
