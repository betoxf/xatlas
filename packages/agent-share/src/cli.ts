import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readShareState, ShareApplier } from "./apply.js";
import { computeHubSeed, readHub, withSeed, writeHubSeed } from "./hub.js";
import { hubRoot } from "./paths.js";
import { planShare } from "./plan.js";
import { AGENT_IDS, type AgentId, type ShareAction } from "./types.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    agents: { type: "string" },
    home: { type: "string" },
  },
});

const home = values.home ?? homedir();
// xatlas's own agent reads ~/.zcode, which an installed ZCode also uses, so it's opt-in.
const DEFAULT_AGENTS: readonly AgentId[] = ["claude", "codex", "gemini", "opencode"];
const agents = (values.agents?.split(",").map((agent) => agent.trim()) ?? [...DEFAULT_AGENTS]) as AgentId[];
const unknown = agents.filter((agent) => !AGENT_IDS.includes(agent));
if (unknown.length > 0) {
  console.error(`Unknown agent(s): ${unknown.join(", ")}. Known: ${AGENT_IDS.join(", ")}`);
  process.exit(2);
}

const tilde = (path: string) => (path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path);

function describe(action: ShareAction): string {
  switch (action.kind) {
    case "mcp-set":
      return `${action.replace ? "update" : "add"} MCP server ${action.name}`;
    case "mcp-remove":
      return `remove MCP server ${action.name} (no longer shared)`;
    case "skill-link":
      return `link skill ${action.name}`;
    case "skill-unlink":
      return `unlink skill ${action.name} (no longer shared)`;
    case "instructions-link":
      return `link ${tilde(action.path)} to the shared instructions`;
    case "instructions-import":
      return action.replace
        ? `replace ${tilde(action.path)} with an import of the shared instructions (its content moves there; backup kept)`
        : `add an import of the shared instructions to ${tilde(action.path)}`;
    case "instructions-entry":
      return `add the shared instructions to ${tilde(action.path)}`;
  }
}

const memoryServer = {
  type: "stdio" as const,
  command: process.execPath,
  args: [fileURLToPath(new URL("./memoryServer.mjs", import.meta.url))],
};
const seed = await computeHubSeed(home, { memoryServer });
const hub = withSeed(await readHub(home), seed);
const plan = await planShare({
  home,
  hub,
  state: await readShareState(hub.root),
  agents,
  ...(seed.instructionsFrom ? { instructionsFrom: seed.instructionsFrom } : {}),
});

console.log(`Shared folder: ${tilde(hubRoot(home))}`);
if (seed.mcp) console.log(`  will create mcp.json with ${Object.keys(seed.mcp).length} servers: ${Object.keys(seed.mcp).join(", ")}`);
if (seed.instructions !== undefined) {
  console.log(`  will create AGENTS.md${seed.instructionsFrom ? ` from your ${seed.instructionsFrom} instructions` : ""}, plus a shared-memory section`);
}
console.log(`  ${hub.skills.length} shared skills, ${Object.keys(hub.mcp).length} MCP servers\n`);
for (const agent of agents) {
  const actions = plan.actions.filter((action) => action.agent === agent);
  const notes = plan.notes.filter((note) => note.agent === agent);
  console.log(`${agent}: ${actions.length === 0 ? "in sync" : `${actions.length} change${actions.length === 1 ? "" : "s"}`}`);
  const skillLinks = actions.filter((action) => action.kind === "skill-link").length;
  for (const action of actions.filter((action) => action.kind !== "skill-link")) console.log(`  - ${describe(action)}`);
  if (skillLinks > 0) console.log(`  - link ${skillLinks} shared skill${skillLinks === 1 ? "" : "s"}`);
  for (const note of notes) console.log(`  ! ${note.message}`);
}

if (!values.apply) {
  console.log("\nPreview only. Run again with --apply to make these changes (backups go to ~/.agents/backups).");
  process.exit(0);
}

const written = await writeHubSeed(home, seed);
for (const path of written) console.log(`created ${tilde(path)}`);
const results = await new ShareApplier(home, hub.root).apply(plan.actions);
const failures = results.filter((result) => result.error);
console.log(`\nApplied ${results.length - failures.length} of ${results.length} changes.`);
for (const failure of failures) console.log(`  ✗ ${failure.action.agent}: ${describe(failure.action)}: ${failure.error}`);
process.exit(failures.length > 0 ? 1 : 0);
