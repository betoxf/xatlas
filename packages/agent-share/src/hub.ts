import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDisabled, readAgentRawServers, toSharedServer } from "./agentConfig.js";
import { agentPaths, hubRoot } from "./paths.js";
import type { AgentId, Hub, SharedMcpServer } from "./types.js";

export const HUB_MCP_FILE = "mcp.json";
export const HUB_INSTRUCTIONS_FILE = "AGENTS.md";
export const MEMORY_SERVER_NAME = "xatlas-memory";

/** Seed priority: the first agent that has a server name wins. */
const SEED_ORDER: readonly AgentId[] = ["claude", "codex", "opencode", "gemini"];
/** Codex-internal servers that only work inside Codex. */
const CODEX_ONLY_SERVERS = new Set(["node_repl", "computer-use"]);

export const MEMORY_INSTRUCTIONS = `
## Shared memory

Every coding agent on this machine (Claude Code, Codex, Gemini CLI, OpenCode, xatlas) shares
one memory through the \`${MEMORY_SERVER_NAME}\` MCP server. Check \`memory_list\` at the start
of a task and \`memory_search\` when something might have come up before. Save durable facts
(how the user likes to work, project decisions, environment quirks) with \`memory_write\`;
don't save what the code or git history already records.
`;

export const UCU_SERVER_NAME = "ucu";

/** Computer use through the ChatGPT app's engine, which Codex already has built in. */
export function isComputerUseServer(name: string, server: SharedMcpServer): boolean {
  return (
    name === UCU_SERVER_NAME ||
    name === "codex-cu" ||
    (server.args ?? []).some((arg) => arg.includes("cua-repl") || arg.includes("ucu-proxy"))
  );
}

export async function readHub(home: string): Promise<Hub> {
  const root = hubRoot(home);
  let mcp: Record<string, SharedMcpServer> = {};
  try {
    const parsed = JSON.parse(await readFile(join(root, HUB_MCP_FILE), "utf8")) as {
      mcpServers?: Record<string, SharedMcpServer>;
    };
    mcp = parsed.mcpServers ?? {};
  } catch {
    // No shared servers yet.
  }
  let skills: string[] = [];
  try {
    const entries = await readdir(join(root, "skills"), { withFileTypes: true });
    skills = entries
      .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .filter((entry) => existsSync(join(root, "skills", entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No shared skills yet.
  }
  const instructions = join(root, HUB_INSTRUCTIONS_FILE);
  return { root, mcp, skills, ...(existsSync(instructions) ? { instructionsPath: instructions } : {}) };
}

export interface HubSeed {
  /** The MCP list to create, when the hub has none. */
  readonly mcp?: Record<string, SharedMcpServer>;
  /** AGENTS.md content to create, when the hub has none. */
  readonly instructions?: string;
  /** The agent whose instruction file becomes the shared one, if any. */
  readonly instructionsFrom?: AgentId;
}

/**
 * What the hub would start with, built from what the agents already have: their MCP
 * servers and Claude's CLAUDE.md. Only for hub files that don't exist yet; writes nothing.
 */
export async function computeHubSeed(
  home: string,
  options: { memoryServer: SharedMcpServer },
): Promise<HubSeed> {
  const root = hubRoot(home);
  let mcp: Record<string, SharedMcpServer> | undefined;
  if (!existsSync(join(root, HUB_MCP_FILE))) {
    mcp = {};
    for (const agent of SEED_ORDER) {
      for (const [name, raw] of Object.entries(await readAgentRawServers(home, agent))) {
        if (name in mcp || isDisabled(raw) || (agent === "codex" && CODEX_ONLY_SERVERS.has(name))) continue;
        const server = toSharedServer(agent, raw);
        if (!server) continue;
        const isComputerUse = isComputerUseServer(name, server);
        // Codex has computer use built in.
        mcp[name] = isComputerUse ? { ...server, except: ["codex"] } : server;
      }
    }
    mcp[MEMORY_SERVER_NAME] = options.memoryServer;
  }

  let instructions: string | undefined;
  let instructionsFrom: AgentId | undefined;
  if (!existsSync(join(root, HUB_INSTRUCTIONS_FILE))) {
    let content = "";
    try {
      content = await readFile(agentPaths(home, "claude").instructionsFile, "utf8");
      if (content.trim()) instructionsFrom = "claude";
    } catch {
      // Start from the memory section alone.
    }
    instructions = `${content.trimEnd()}\n${MEMORY_INSTRUCTIONS}`;
  }
  return {
    ...(mcp ? { mcp } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(instructionsFrom ? { instructionsFrom } : {}),
  };
}

/** The hub as it will be once the seed is written. */
export function withSeed(hub: Hub, seed: HubSeed): Hub {
  return {
    ...hub,
    mcp: seed.mcp ?? hub.mcp,
    ...(seed.instructions !== undefined ? { instructionsPath: join(hub.root, HUB_INSTRUCTIONS_FILE) } : {}),
  };
}

export async function writeHubSeed(home: string, seed: HubSeed): Promise<string[]> {
  const root = hubRoot(home);
  await mkdir(join(root, "memory"), { recursive: true });
  const written: string[] = [];
  if (seed.mcp) {
    const path = join(root, HUB_MCP_FILE);
    await writeFile(path, `${JSON.stringify({ mcpServers: seed.mcp }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    written.push(path);
  }
  if (seed.instructions !== undefined) {
    const path = join(root, HUB_INSTRUCTIONS_FILE);
    await writeFile(path, seed.instructions, { flag: "wx" });
    written.push(path);
  }
  return written;
}
