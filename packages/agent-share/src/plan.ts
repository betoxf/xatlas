import { lstat, readFile, readlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { readAgentRawServers, sameServer, toSharedServer } from "./agentConfig.js";
import { agentPaths } from "./paths.js";
import type { AgentId, Hub, ShareAction, ShareNote, SharePlan, ShareState } from "./types.js";

/** How agents refer to the shared instructions; `~` keeps it portable. */
export function hubInstructionsReference(home: string, hub: Hub): string {
  const path = hub.instructionsPath ?? join(hub.root, "AGENTS.md");
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

async function linkStatus(path: string, target: string): Promise<"missing" | "linked" | "other"> {
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) return "other";
    const pointsTo = resolve(dirname(path), await readlink(path));
    return pointsTo === resolve(target) ? "linked" : "other";
  } catch {
    return "missing";
  }
}

async function fileText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function planMcp(home: string, hub: Hub, state: ShareState, agent: AgentId, out: ShareAction[], notes: ShareNote[]) {
  const current = await readAgentRawServers(home, agent);
  const managed = new Set(state.mcp[agent] ?? []);
  const wanted = Object.entries(hub.mcp).filter(([, server]) => !server.except?.includes(agent));
  for (const [name, server] of wanted) {
    if (!(name in current)) {
      out.push({ kind: "mcp-set", agent, name, server, replace: false });
      continue;
    }
    const existing = toSharedServer(agent, current[name]);
    if (existing && sameServer(existing, server)) continue;
    if (managed.has(name)) {
      out.push({ kind: "mcp-set", agent, name, server, replace: true });
    } else {
      notes.push({ agent, kind: "conflict", message: `has its own "${name}" MCP server that differs from the shared one; left as it is` });
    }
  }
  const wantedNames = new Set(wanted.map(([name]) => name));
  for (const name of managed) {
    if (!wantedNames.has(name) && name in current) out.push({ kind: "mcp-remove", agent, name });
  }
}

async function planSkills(hub: Hub, state: ShareState, agent: AgentId, skillsDir: string, out: ShareAction[], notes: ShareNote[]) {
  const ownCopies: string[] = [];
  for (const name of hub.skills) {
    const link = join(skillsDir, name);
    const target = join(hub.root, "skills", name);
    const status = await linkStatus(link, target);
    if (status === "missing") out.push({ kind: "skill-link", agent, name, link, target });
    else if (status === "other") ownCopies.push(name);
  }
  if (ownCopies.length > 0) {
    notes.push({
      agent,
      kind: "own-copy",
      message: `keeps its own copy of ${ownCopies.length} shared skill${ownCopies.length === 1 ? "" : "s"} (${ownCopies.slice(0, 4).join(", ")}${ownCopies.length > 4 ? ", …" : ""}); those copies aren't updated`,
    });
  }
  for (const name of state.skills[agent] ?? []) {
    if (hub.skills.includes(name)) continue;
    const link = join(skillsDir, name);
    if ((await linkStatus(link, join(hub.root, "skills", name))) === "linked") {
      out.push({ kind: "skill-unlink", agent, name, link });
    }
  }
}

async function planInstructions(
  home: string,
  hub: Hub,
  agent: AgentId,
  options: { instructionsFrom?: AgentId },
  out: ShareAction[],
  notes: ShareNote[],
) {
  if (!hub.instructionsPath) return;
  const reference = hubInstructionsReference(home, hub);
  const { instructionsFile, mcpFile } = agentPaths(home, agent);
  if (agent === "claude") {
    const content = (await fileText(instructionsFile)) ?? "";
    if (!content.split("\n").some((line) => line.trim() === `@${reference}`)) {
      out.push({
        kind: "instructions-import",
        agent,
        path: instructionsFile,
        line: `@${reference}`,
        replace: options.instructionsFrom === "claude",
      });
    }
    return;
  }
  if (agent === "opencode") {
    let entries: unknown;
    try {
      entries = (JSON.parse((await fileText(mcpFile)) ?? "{}") as { instructions?: unknown }).instructions;
    } catch {
      entries = undefined;
    }
    if (!Array.isArray(entries) || !entries.includes(reference)) {
      out.push({ kind: "instructions-entry", agent, path: mcpFile, entry: reference });
    }
    if ((await fileText(instructionsFile))?.trim()) {
      notes.push({
        agent,
        kind: "manual",
        message: `also loads its own ${instructionsFile.replace(home, "~")}; move what's unique there into ${reference} and empty it`,
      });
    }
    return;
  }
  const status = await linkStatus(instructionsFile, hub.instructionsPath);
  if (status === "linked") return;
  const content = await fileText(instructionsFile);
  if (status === "missing" || !content?.trim()) {
    out.push({ kind: "instructions-link", agent, path: instructionsFile, target: hub.instructionsPath });
  } else {
    notes.push({
      agent,
      kind: "manual",
      message: `has its own ${instructionsFile.replace(home, "~")}; merge it into ${reference}, then remove it so xatlas can link the shared one`,
    });
  }
}

/** Everything needed to bring the agents in line with the hub. Reads only. */
export async function planShare(input: {
  home: string;
  hub: Hub;
  state: ShareState;
  agents: readonly AgentId[];
  instructionsFrom?: AgentId;
}): Promise<SharePlan> {
  const actions: ShareAction[] = [];
  const notes: ShareNote[] = [];
  for (const agent of input.agents) {
    await planMcp(input.home, input.hub, input.state, agent, actions, notes);
    if (agent !== "xatlas") {
      await planSkills(input.hub, input.state, agent, agentPaths(input.home, agent).skillsDir, actions, notes);
    }
    await planInstructions(input.home, input.hub, agent, { instructionsFrom: input.instructionsFrom }, actions, notes);
  }
  return { actions, notes };
}
