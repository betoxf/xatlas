import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { WebRemoteControlDeviceTransport } from "../../desktop/src/main/webRemoteControlTransport.js";
import { createNodeWebRemoteControlRelayAuthProvider } from "../../desktop/src/main/webRemoteControlRelayAuthProvider.js";
import { WebRemoteControlTerminalTransport } from "../../web/src/webRemoteControlTransport.js";
import { createBrowserWebRemoteControlRelayAuthProvider } from "../../web/src/webRemoteControlRelayAuthProvider.js";
import { FileRelayRegistry, startRelayServer, type RunningRelayServer } from "../src/index.js";

function waitUntil(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (assertion()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("Timed out waiting"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(options: Parameters<typeof startRelayServer>[0] = {}) {
  const server: RunningRelayServer = await startRelayServer({ port: 0, ...options });
  cleanups.push(() => server.close());
  return server;
}

describe("relay server with the real desktop and phone transports", () => {
  it("pairs them and carries rpc frames both ways", async () => {
    const server = await startServer();
    const authProvider = createNodeWebRemoteControlRelayAuthProvider();
    const passHash = authProvider.createPassHash(authProvider.createPassword());
    const desktopStates: string[] = [];
    const desktopPayloads: WebRemoteControlAppPayload[] = [];
    let registered: { deviceSid: string; passHash: string } | undefined;

    const desktop = new WebRemoteControlDeviceTransport({
      relayWsUrl: server.url,
      deviceMid: "mid-integration",
      auth: { mode: "register", passHash },
      meta: { platform: "darwin", version: "3.15.1", name: "Mac" },
      authProvider,
      logger,
      onRegisteredAuth: (auth) => {
        registered = auth;
      },
      onStateChange: (state) => desktopStates.push(state),
      onPayload: (payload) => desktopPayloads.push(payload),
      onError: () => {},
      onInvalidPersistedAuth: async () => {},
    });
    cleanups.push(() => desktop.dispose());
    desktop.start();
    await waitUntil(() => desktopStates.includes("waiting_terminal"));
    expect(registered?.passHash).toBe(passHash);

    const phoneStates: string[] = [];
    const phonePayloads: WebRemoteControlAppPayload[] = [];
    const phone = new WebRemoteControlTerminalTransport({
      relayWsUrl: server.url,
      deviceSid: registered!.deviceSid,
      passHash,
      deviceMid: "mid-integration",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
      onPayload: (payload) => phonePayloads.push(payload),
      onStateChange: (state) => phoneStates.push(state),
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });
    cleanups.push(() => phone.dispose());
    phone.start();
    await waitUntil(() => phoneStates.includes("paired") && desktopStates.at(-1) === "paired");

    const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    expect(phone.sendPayload(frame!)).toBe(true);
    await waitUntil(() => desktopPayloads.length === 1);
    expect(desktop.sendPayload(frame!)).toBe(true);
    await waitUntil(() => phonePayloads.length === 1);
    expect(desktopPayloads[0]).toEqual(frame);
    expect(phonePayloads[0]).toEqual(frame);
  });

  it("answers health checks and refuses other WebSocket paths", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(await response.json()).toEqual({ ok: true });

    const rejected = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/other`);
      socket.on("open", () => resolve(false));
      socket.on("error", () => resolve(true));
    });
    expect(rejected).toBe(true);
  });

  it("closes sockets that never authenticate", async () => {
    const server = await startServer({ authTimeoutMs: 50 });
    const closeCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(server.url);
      socket.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(4008);
  });

  it("keeps registrations in a private file across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xatlas-relay-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "devices.json");
    const registry = await FileRelayRegistry.open(file);
    await registry.register({ deviceSid: "xd_1", deviceMid: "mid", passHash: "h", registeredAt: 1 });

    const reopened = await FileRelayRegistry.open(file);
    expect(await reopened.get("xd_1")).toMatchObject({ deviceMid: "mid" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).devices).toHaveLength(1);
  });
});

describe("relay server serving the phone page", () => {
  it("serves built files, falls back to index.html, and stays inside its folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "xatlas-phone-page-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<title>xatlas</title>");
    await writeFile(join(root, "assets", "app.js"), "console.log(1)");
    await writeFile(join(tmpdir(), "xatlas-outside.txt"), "secret");
    const server = await startServer({ staticApp: { root } });
    const base = `http://127.0.0.1:${server.port}`;

    const asset = await fetch(`${base}/remote/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toBe("console.log(1)");
    expect(await (await fetch(`${base}/remote?sid=1&hash=2`)).text()).toBe("<title>xatlas</title>");
    // Raw request: fetch would normalize the dot segments before they reach the server.
    const escaped = await new Promise<string>((done, fail) => {
      get({ port: server.port, path: "/remote/..%2f..%2fxatlas-outside.txt" }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => done(body));
      }).on("error", fail);
    });
    expect(escaped).toBe("<title>xatlas</title>");
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });
});
