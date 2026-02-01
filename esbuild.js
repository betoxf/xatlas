const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Copy xterm CSS to dist/webview
function copyXtermAssets() {
  const webviewDir = path.join(__dirname, 'dist', 'webview');

  // Ensure webview directory exists
  if (!fs.existsSync(webviewDir)) {
    fs.mkdirSync(webviewDir, { recursive: true });
  }

  // Copy xterm.css
  const xtermCssSource = path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
  const xtermCssDest = path.join(webviewDir, 'xterm.css');

  if (fs.existsSync(xtermCssSource)) {
    fs.copyFileSync(xtermCssSource, xtermCssDest);
    console.log('Copied xterm.css to dist/webview/');
  } else {
    console.warn('Warning: xterm.css not found at', xtermCssSource);
  }
}

async function main() {
  // Build main extension
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode', 'node-pty'],
    logLevel: 'info',
  });

  // Build webview bundle (xterm for browser)
  const webviewCtx = await esbuild.context({
    entryPoints: ['src/dashboard/webview/terminal.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'XtermBundle',
    minify: production,
    sourcemap: !production,
    platform: 'browser',
    outfile: 'dist/webview/terminal.js',
    logLevel: 'info',
  });

  // Copy assets
  copyXtermAssets();

  if (watch) {
    await Promise.all([
      extensionCtx.watch(),
      webviewCtx.watch(),
    ]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      extensionCtx.rebuild(),
      webviewCtx.rebuild(),
    ]);
    await extensionCtx.dispose();
    await webviewCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
