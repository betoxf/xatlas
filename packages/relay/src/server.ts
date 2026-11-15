import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayHub, type RelayHubOptions, type RelayPeer } from "./relayHub.js";
import { MemoryRelayRegistry, type RelayRegistry } from "./registry.js";
import { createStaticAppHandler } from "./staticFiles.js";

export interface RelayServerOptions {
  readonly host?: string;
  readonly port?: number;
  /** WebSocket path; clients connect to `ws://host:port<path>`. */
  readonly path?: string;
  readonly registry?: RelayRegistry;
  /** Largest accepted frame. The clients cap theirs at 1 MiB of payload plus the envelope. */
  readonly maxPayloadBytes?: number;
  /** Sockets that haven't authenticated by then are closed. */
  readonly authTimeoutMs?: number;
  /** Interval of the ping that finds dead sockets. */
  readonly pingIntervalMs?: number;
  readonly log?: RelayHubOptions["log"];
  /** Also serve the phone page: a Vite build with base `<mountPath>/` (default `/remote`). */
  readonly staticApp?: { readonly root: string; readonly mountPath?: string };
  /** Serve HTTPS/WSS with this certificate (PEM). */
  readonly tls?: { readonly key: string; readonly cert: string };
  /** Share pairings with another listener, e.g. a loopback one for the desktop itself. */
  readonly hub?: RelayHub;
}

export interface RunningRelayServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const AUTH_TIMEOUT_CLOSE_CODE = 4008;

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://relay.invalid");
}

/** Serves the relay over HTTP + WebSocket, with `GET /healthz` for uptime checks. */
export async function startRelayServer(options: RelayServerOptions = {}): Promise<RunningRelayServer> {
  const path = options.path ?? "/ws";
  const hub =
    options.hub ??
    new RelayHub({
      registry: options.registry ?? new MemoryRelayRegistry(),
      log: options.log,
    });
  const serveStaticApp = options.staticApp
    ? createStaticAppHandler({
        root: options.staticApp.root,
        mountPath: options.staticApp.mountPath ?? "/remote",
      })
    : undefined;
  const handleRequest: RequestListener = (request, response) => {
    const pathname = requestUrl(request).pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    void (async () => {
      if (!(await serveStaticApp?.(request, response, pathname))) response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };
  const http = options.tls
    ? createTlsServer({ key: options.tls.key, cert: options.tls.cert }, handleRequest)
    : createServer(handleRequest);
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 4 * 1024 * 1024,
    perMessageDeflate: { threshold: 1024 },
  });
  const alive = new WeakMap<WebSocket, boolean>();

  http.on("upgrade", (request, socket, head) => {
    if (requestUrl(request).pathname !== path) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });

  sockets.on("connection", (ws: WebSocket) => {
    const peer: RelayPeer = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    hub.open(peer);
    alive.set(ws, true);
    const authTimer = setTimeout(() => {
      if (!hub.isAuthenticated(peer)) ws.close(AUTH_TIMEOUT_CLOSE_CODE, "Authentication timeout");
    }, options.authTimeoutMs ?? 30_000);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, "Text frames only");
        return;
      }
      void hub.receive(peer, data.toString());
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      hub.close(peer);
    });
    ws.on("error", () => ws.terminate());
  });

  const pingTimer = setInterval(() => {
    for (const ws of sockets.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.pingIntervalMs ?? 30_000);
  pingTimer.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = http.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    url: `${options.tls ? "wss" : "ws"}://${host}:${address.port}${path}`,
    port: address.port,
    close: async () => {
      clearInterval(pingTimer);
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
