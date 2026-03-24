// FILE: codex-transport.js
// Purpose: Abstracts the xatlas MCP server transport so the bridge can forward JSON-RPC to the running xatlas app.
// Layer: CLI helper
// Exports: createCodexTransport
// Depends on: http, fs, path, os, ws

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");

const MCP_STATE_FILE = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "xatlas",
  "mcp-server.json"
);
const DEFAULT_MCP_PORT = 9012;
const HEALTH_CHECK_INTERVAL_MS = 5_000;

function createCodexTransport({
  endpoint = "",
  env = process.env,
  WebSocketImpl = WebSocket,
} = {}) {
  if (endpoint) {
    return createWebSocketTransport({ endpoint, WebSocketImpl });
  }

  return createXatlasMCPTransport({ env });
}

// Connects to the running xatlas macOS app's MCP HTTP server.
// Instead of spawning a child process, we poll /health and POST JSON-RPC to /mcp.
function createXatlasMCPTransport({ env }) {
  const listeners = createListenerBag();
  let mcpPort = resolveMCPPort(env);
  let mcpSessionId = null;
  let healthTimer = null;
  let isShutdown = false;

  // Start health monitoring
  healthTimer = setInterval(() => {
    if (isShutdown) return;
    checkHealth(mcpPort)
      .then((healthy) => {
        if (!healthy) {
          // Try to re-read the port in case xatlas restarted on a different port
          const nextPort = resolveMCPPort(env);
          if (nextPort !== mcpPort) {
            mcpSessionId = null;
          }
          mcpPort = nextPort;
        }
      })
      .catch(() => {});
  }, HEALTH_CHECK_INTERVAL_MS);

  return {
    mode: "xatlas-mcp",
    describe() {
      return `xatlas MCP server at localhost:${mcpPort}`;
    },
    // Send a JSON-RPC message to the xatlas MCP server via HTTP POST
    send(message) {
      if (isShutdown) return;

      const body = typeof message === "string" ? message : JSON.stringify(message);

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: mcpPort,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...(mcpSessionId ? { "MCP-Session-Id": mcpSessionId } : {}),
          },
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          const nextSessionId = res.headers["mcp-session-id"];
          if (typeof nextSessionId === "string" && nextSessionId.trim()) {
            mcpSessionId = nextSessionId.trim();
          }
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (data.trim()) {
              // The MCP server may return one or more JSON-RPC responses
              for (const line of data.split("\n")) {
                const trimmed = line.trim();
                if (trimmed) {
                  listeners.emitMessage(trimmed);
                }
              }
            }
          });
        }
      );

      req.on("error", (error) => {
        // Transient connection errors are expected if xatlas hasn't started yet
        console.error(`[xatlas-bridge] MCP request error: ${error.message}`);
      });

      req.write(body);
      req.end();
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    shutdown() {
      isShutdown = true;
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      listeners.emitClose(0, "bridge shutdown");
    },
  };
}

// Reads the active MCP port from the xatlas state file, or falls back to default.
function resolveMCPPort(env) {
  const envPort = env.XATLAS_MCP_PORT;
  if (envPort) return parseInt(envPort, 10);

  try {
    const raw = fs.readFileSync(MCP_STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    if (state.port) return state.port;
  } catch {
    // State file doesn't exist yet or is unreadable
  }

  return DEFAULT_MCP_PORT;
}

function checkHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/health", timeout: 3_000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.status === "ok");
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function createWebSocketTransport({ endpoint, WebSocketImpl = WebSocket }) {
  const socket = new WebSocketImpl(endpoint);
  const listeners = createListenerBag();
  const openState = WebSocketImpl.OPEN ?? WebSocket.OPEN ?? 1;
  const connectingState = WebSocketImpl.CONNECTING ?? WebSocket.CONNECTING ?? 0;

  socket.on("message", (chunk) => {
    const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (message.trim()) {
      listeners.emitMessage(message);
    }
  });

  socket.on("close", (code, reason) => {
    const safeReason = reason ? reason.toString("utf8") : "no reason";
    listeners.emitClose(code, safeReason);
  });

  socket.on("error", (error) => listeners.emitError(error));

  return {
    mode: "websocket",
    describe() {
      return endpoint;
    },
    send(message) {
      if (socket.readyState === openState) {
        socket.send(message);
      }
    },
    onMessage(handler) {
      listeners.onMessage = handler;
    },
    onClose(handler) {
      listeners.onClose = handler;
    },
    onError(handler) {
      listeners.onError = handler;
    },
    shutdown() {
      if (socket.readyState === openState || socket.readyState === connectingState) {
        socket.close();
      }
    },
  };
}

function createListenerBag() {
  return {
    onMessage: null,
    onClose: null,
    onError: null,
    emitMessage(message) {
      this.onMessage?.(message);
    },
    emitClose(...args) {
      this.onClose?.(...args);
    },
    emitError(error) {
      this.onError?.(error);
    },
  };
}

module.exports = { createCodexTransport };
