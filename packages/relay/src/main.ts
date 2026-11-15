import { FileRelayRegistry, MemoryRelayRegistry } from "./registry.js";
import { startRelayServer } from "./server.js";

const env = process.env;
const dataFile = env.XATLAS_RELAY_DATA_FILE?.trim();
const registry = dataFile ? await FileRelayRegistry.open(dataFile) : new MemoryRelayRegistry();

const server = await startRelayServer({
  host: env.XATLAS_RELAY_HOST?.trim() || "127.0.0.1",
  port: Number(env.XATLAS_RELAY_PORT ?? 8787),
  registry,
  log: (event, fields) => console.log(`[relay] ${event}`, fields),
});
console.log(`xatlas relay listening on ${server.url}${dataFile ? "" : " (registrations kept in memory)"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
