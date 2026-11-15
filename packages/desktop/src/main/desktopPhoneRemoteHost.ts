import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import {
  FileRelayRegistry,
  RelayHub,
  startRelayServer,
  type RunningRelayServer,
} from "@zcode/relay";
import { ensurePhoneRemoteServerCertificate } from "@zcode/services/node";

/** Stable port so links from earlier QR codes keep working; any free port if it's taken. */
const DEFAULT_PHONE_REMOTE_PORT = 47120;

export interface PhoneRemoteHost {
  /** Where this app's own device connection goes. */
  readonly relayWsUrl: string;
  /** The page phones open, at this Mac's current network address. */
  remoteUrl(): string;
  close(): Promise<void>;
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** Built by `pnpm build:phone-remote`; packaged as extraResources/phone-remote. */
function resolvePhoneRemotePageDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "phone-remote")
    : join(import.meta.dirname, "..", "..", "resources", "phone-remote");
}

/**
 * The address a phone on the same network uses to reach this Mac: Wi-Fi or Ethernet
 * first, then any other private IPv4 address (VPNs such as Tailscale), else loopback.
 */
export function resolvePhoneReachableAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({ name, address: address.address })),
  );
  const preferred =
    candidates.find(({ name }) => /^(en|eth|wlan|wl)\d/.test(name)) ?? candidates[0];
  return preferred?.address ?? "127.0.0.1";
}

let starting: Promise<PhoneRemoteHost> | undefined;

/**
 * Runs the relay and serves the phone page from this Mac, so a phone pairs straight
 * with it: no xatlas or Z.ai service in between, and no account.
 */
export function ensurePhoneRemoteHost(logger: Logger): Promise<PhoneRemoteHost> {
  starting ??= startPhoneRemoteHost(logger).catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

async function startPhoneRemoteHost(logger: Logger): Promise<PhoneRemoteHost> {
  const directory = join(app.getPath("userData"), "phone-remote");
  const hub = new RelayHub({
    registry: await FileRelayRegistry.open(join(directory, "devices.json")),
    log: (event, fields) => logger.info(`[phone-remote] ${event}`, fields),
  });
  // Phones reach the Mac over the network with TLS, trusting the certificate whose
  // fingerprint the pairing code carries. This app's own connection stays on loopback.
  const certificate = ensurePhoneRemoteServerCertificate(directory);
  const loopback = await startRelayServer({ hub, host: "127.0.0.1", port: 0 });
  const options = {
    hub,
    host: "0.0.0.0",
    tls: { key: certificate.key, cert: certificate.cert },
    staticApp: { root: resolvePhoneRemotePageDir() },
  };
  const configuredPort = Number(process.env["XATLAS_PHONE_REMOTE_PORT"]) || DEFAULT_PHONE_REMOTE_PORT;
  let server: RunningRelayServer;
  try {
    server = await startRelayServer({ ...options, port: configuredPort });
  } catch (error) {
    logger.warn("[phone-remote] port taken, using another one", { port: configuredPort, error });
    server = await startRelayServer({ ...options, port: 0 });
  }
  logger.info("[phone-remote] listening", { port: server.port });
  return {
    relayWsUrl: loopback.url,
    // Resolved per pairing code: the Mac may have changed networks since start-up.
    remoteUrl: () =>
      `https://${resolvePhoneReachableAddress()}:${server.port}/remote?fp=${certificate.fingerprint}`,
    close: async () => {
      starting = undefined;
      await Promise.all([server.close(), loopback.close()]);
    },
  };
}
