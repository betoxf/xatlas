#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const targetUrl = new URL(process.env.XATLAS_MCP_URL || 'http://127.0.0.1:9012/mcp');
const logPath = process.env.XATLAS_MCP_BRIDGE_LOG || '';
let sessionId = process.env.XATLAS_MCP_SESSION_ID || '';
let inputBuffer = Buffer.alloc(0);
let queue = Promise.resolve();

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
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headerText = inputBuffer.subarray(0, headerEnd).toString('utf8');
    const contentLength = parseContentLength(headerText);
    if (contentLength == null) {
      console.error('[xatlas-bridge] missing Content-Length');
      process.exit(1);
    }

    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) return;

    const body = inputBuffer.subarray(messageStart, messageEnd).toString('utf8');
    inputBuffer = inputBuffer.subarray(messageEnd);
    queue = queue.then(() => forwardMessage(body)).catch((error) => {
      console.error(`[xatlas-bridge] ${error.stack || error.message}`);
      process.exitCode = 1;
    });
  }
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
  logEvent(`stdin ${body}`);
  const response = await postMessage(body);
  logEvent(`http ${response.statusCode} ${response.body}`);

  const responseSessionId = response.headers['mcp-session-id'];
  if (responseSessionId) {
    sessionId = Array.isArray(responseSessionId) ? responseSessionId[0] : responseSessionId;
  }

  if (response.statusCode === 202 || response.statusCode === 204) {
    return;
  }

  if (!response.body) {
    return;
  }

  writeFramedMessage(response.body);
}

function postMessage(body) {
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(body)
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
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

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function writeFramedMessage(body) {
  logEvent(`stdout ${body}`);
  const payload = Buffer.from(body, 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function logEvent(message) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Ignore logging failures.
  }
}
