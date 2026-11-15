import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { agentPaths } from "./paths.js";
import type { AgentId, SharedMcpServer } from "./types.js";

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Converts one agent's MCP entry to the shared shape; `undefined` for entries it can't express. */
export function toSharedServer(agent: AgentId, raw: unknown): SharedMcpServer | undefined {
  if (!isRecord(raw)) return undefined;
  if (agent === "opencode") {
    if (raw.type === "remote" && typeof raw.url === "string") {
      return { type: "http", url: raw.url, ...(stringMap(raw.headers) ? { headers: stringMap(raw.headers) } : {}) };
    }
    const command = strings(raw.command);
    if (!command?.[0]) return undefined;
    const env = stringMap(raw.environment);
    return { type: "stdio", command: command[0], args: command.slice(1), ...(env ? { env } : {}) };
  }
  const url = typeof raw.url === "string" ? raw.url : typeof raw.httpUrl === "string" ? raw.httpUrl : undefined;
  if (url) {
    const type = raw.type === "sse" ? "sse" : "http";
    const headers = stringMap(raw.headers) ?? stringMap(raw.http_headers);
    return { type, url, ...(headers ? { headers } : {}) };
  }
  if (typeof raw.command !== "string" || !raw.command) return undefined;
  const env = stringMap(raw.env);
  const timeout = typeof raw.timeout === "number" ? raw.timeout : undefined;
  return {
    type: "stdio",
    command: raw.command,
    args: strings(raw.args) ?? [],
    ...(env ? { env } : {}),
    ...(timeout ? { timeout } : {}),
  };
}

async function readJson(path: string): Promise<Raw | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The MCP servers an agent has configured globally, as raw entries by name. */
export async function readAgentRawServers(home: string, agent: AgentId): Promise<Raw> {
  const { mcpFile } = agentPaths(home, agent);
  if (agent === "codex") {
    try {
      const parsed = parseToml(await readFile(mcpFile, "utf8")) as Raw;
      return isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
    } catch {
      return {};
    }
  }
  const config = await readJson(mcpFile);
  if (!config) return {};
  const servers =
    agent === "opencode" ? config.mcp : agent === "xatlas" ? (isRecord(config.mcp) ? config.mcp.servers : undefined) : config.mcpServers;
  return isRecord(servers) ? servers : {};
}

/** Whether an entry is switched off in its agent's own config. */
export function isDisabled(raw: unknown): boolean {
  return isRecord(raw) && (raw.enabled === false || raw.disabled === true);
}

/** Equal for sharing purposes: same transport, target and environment. */
export function sameServer(a: SharedMcpServer, b: SharedMcpServer): boolean {
  const canonical = (server: SharedMcpServer) =>
    JSON.stringify({
      type: server.type === "sse" ? "sse" : server.url ? "http" : "stdio",
      command: server.command ?? null,
      args: server.args ?? [],
      env: Object.entries(server.env ?? {}).sort(),
      url: server.url ?? null,
      headers: Object.entries(server.headers ?? {}).sort(),
    });
  return canonical(a) === canonical(b);
}
