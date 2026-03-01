import * as vscode from 'vscode';

/**
 * Lightweight sidebar launcher that opens the full dashboard panel.
 * Keeps Activity Bar entry available without running sidebar dashboard logic.
 */
export class DashboardLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'xerebroLauncherView';

  private lastOpenAt = 0;
  private openInFlight = false;

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.command === 'openDashboard') {
        await this.openDashboard();
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.openDashboard();
      }
    });
  }

  private async openDashboard(): Promise<void> {
    const now = Date.now();
    if (this.openInFlight || now - this.lastOpenAt < 400) {
      return;
    }

    this.openInFlight = true;
    this.lastOpenAt = now;
    try {
      await vscode.commands.executeCommand('vscode-mcp-server.openDashboard');
    } finally {
      this.openInFlight = false;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      margin: 0;
      padding: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .wrap {
      display: grid;
      gap: 8px;
    }
    .hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.4;
    }
    button {
      border: 1px solid var(--vscode-button-border);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 8px 10px;
      cursor: pointer;
      font-size: 12px;
      text-align: left;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <button id="openBtn">Open Full Dashboard</button>
    <div class="hint">This sidebar icon is a launcher. The full Xerebro dashboard opens in an editor panel.</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('openBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'openDashboard' });
      });
    }
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i++) {
      value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
  }
}

