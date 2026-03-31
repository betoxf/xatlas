#!/usr/bin/env node

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

const fallbackUrl = process.env.XATLAS_MCP_URL || 'http://127.0.0.1:9012/mcp';
const stateFile = process.env.XATLAS_MCP_STATE_FILE || `${process.env.HOME || ''}/Library/Application Support/xatlas/mcp-server.json`;
const logPath = process.env.XATLAS_MCP_BRIDGE_LOG || '';
const bridgeRoot = path.resolve(__dirname, '..');
let sessionId = process.env.XATLAS_MCP_SESSION_ID || '';
let protocolVersion = process.env.XATLAS_MCP_PROTOCOL_VERSION || '';
let inputBuffer = Buffer.alloc(0);
let queue = Promise.resolve();
let launchAttempted = false;
let transportMode = '';

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on('end', () => {
  queue.finally(() => process.exit(process.exitCode || 0));
});

process.stdin.on('error', (error) => {
  console.error(`[xatlas-bridge] stdin error: ${error.message}`);
  process.exit(1);
});

function drainInput() {
  while (true) {
    const parsed = parseInputMessage();
    if (!parsed) return;

    const { body } = parsed;
    queue = queue.then(() => forwardMessage(body)).catch((error) => {
      console.error(`[xatlas-bridge] ${error.stack || error.message}`);
      process.exitCode = 1;
    });
  }
}

function parseInputMessage() {
  if (inputBuffer.length === 0) {
    return null;
  }

  const prefix = inputBuffer
    .subarray(0, Math.min(inputBuffer.length, 32))
    .toString('utf8')
    .toLowerCase();

  if (prefix.startsWith('content-length:')) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;

    const headerText = inputBuffer.subarray(0, headerEnd).toString('utf8');
    const contentLength = parseContentLength(headerText);
    if (contentLength == null) {
      console.error('[xatlas-bridge] missing Content-Length');
      process.exit(1);
    }

    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) return null;

    transportMode = transportMode || 'framed';
    const body = inputBuffer.subarray(messageStart, messageEnd).toString('utf8');
    inputBuffer = inputBuffer.subarray(messageEnd);
    return { body };
  }

  const newlineIndex = inputBuffer.indexOf('\n');
  if (newlineIndex === -1) return null;

  const line = inputBuffer.subarray(0, newlineIndex).toString('utf8').replace(/\r$/, '');
  inputBuffer = inputBuffer.subarray(newlineIndex + 1);
  if (!line.trim()) {
    return { body: '' };
  }

  transportMode = transportMode || 'line';
  return { body: line };
}

function parseContentLength(headerText) {
  for (const line of headerText.split('\r\n')) {
    const match = /^content-length\s*:\s*(\d+)$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

async function forwardMessage(body) {
  if (!body.trim()) {
    return;
  }

  logEvent(`stdin ${body}`);
  const response = await postMessageWithRetry(body);
  logEvent(`http ${response.statusCode} ${response.body}`);

  const responseSessionId = response.headers['mcp-session-id'];
  if (responseSessionId) {
    sessionId = Array.isArray(responseSessionId) ? responseSessionId[0] : responseSessionId;
  }

  const responseProtocolVersion = extractProtocolVersion(response);
  if (responseProtocolVersion) {
    protocolVersion = responseProtocolVersion;
  }

  if (response.statusCode === 202 || response.statusCode === 204) {
    return;
  }

  if (!response.body) {
    return;
  }

  writeMessage(response.body);
}

async function postMessageWithRetry(body) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    const targetUrl = resolveTargetUrl();
    try {
      return await postMessage(body, targetUrl);
    } catch (error) {
      lastError = error;
      if (!launchAttempted && shouldAttemptAppLaunch(error)) {
        launchAttempted = true;
        await launchAppIfAvailable();
      }
      logEvent(`retry ${attempt + 1} ${error.message}`);
      await sleep(attempt < 10 ? 250 : 500);
    }
  }
  throw lastError || new Error('xatlas bridge failed without an explicit error');
}

function postMessage(body, targetUrl) {
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(body)
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }
  if (protocolVersion) {
    headers['mcp-protocol-version'] = protocolVersion;
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: 'POST',
        headers,
        agent: false
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    request.setTimeout(2000, () => {
      request.destroy(new Error('request timeout'));
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function resolveTargetUrl() {
  try {
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.url === 'string' && parsed.url) {
        return new URL(parsed.url);
      }
      if (parsed && Number.isInteger(parsed.port)) {
        return new URL(`http://127.0.0.1:${parsed.port}/mcp`);
      }
    }
  } catch (error) {
    logEvent(`state-read-error ${error.message}`);
  }

  return new URL(fallbackUrl);
}

function shouldAttemptAppLaunch(error) {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || /timeout/i.test(error.message || '');
}

async function launchAppIfAvailable() {
  const appPath = resolveAppPath();
  if (!appPath) {
    logEvent('launch skipped: no xatlas.app found');
    return;
  }

  logEvent(`launching app ${appPath}`);
  try {
    const child = childProcess.spawn('open', ['-g', '-a', appPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (error) {
    logEvent(`launch failed: ${error.message}`);
    return;
  }

  await waitForHealth();
}

function resolveAppPath() {
  const candidates = [
    process.env.XATLAS_APP_PATH || '',
    '/Applications/xatlas.app',
    path.join(bridgeRoot, '.dist', 'xatlas.app')
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const targetUrl = resolveTargetUrl();
    if (await isServerHealthy(targetUrl)) {
      return;
    }
    await sleep(250);
  }
}

function isServerHealthy(targetUrl) {
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const healthPath = `${targetUrl.pathname.replace(/\/mcp$/, '') || ''}/health${targetUrl.search}`;
  return new Promise((resolve) => {
    const request = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: healthPath,
        method: 'GET',
        headers: { accept: 'application/json' },
        agent: false
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(body);
            resolve(response.statusCode === 200 && parsed?.status === 'ok');
          } catch {
            resolve(false);
          }
        });
      }
    );

    request.setTimeout(1000, () => {
      request.destroy(new Error('health timeout'));
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeMessage(body) {
  logEvent(`stdout ${body}`);

  if (transportMode === 'line') {
    process.stdout.write(`${body}\n`);
    return;
  }

  const payload = Buffer.from(body, 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function extractProtocolVersion(response) {
  const headerValue = response.headers['mcp-protocol-version'];
  if (headerValue) {
    return Array.isArray(headerValue) ? headerValue[0] : headerValue;
  }

  try {
    const parsed = JSON.parse(response.body);
    const version = parsed?.result?.protocolVersion;
    return typeof version === 'string' && version ? version : '';
  } catch {
    return '';
  }
}

function logEvent(message) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Ignore logging failures.
  }
}
