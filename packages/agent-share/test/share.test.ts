import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeHubSeed,
  isComputerUseServer,
  planShare,
  readHub,
  readShareState,
  ShareApplier,
  withSeed,
  writeHubSeed,
  type AgentId,
  type ShareAction,
} from "../src/index.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const memoryServer = { type: "stdio" as const, command: "/usr/bin/node", args: ["/opt/memory.mjs"] };

async function write(home: string, path: string, content: string) {
  await mkdir(join(home, path, ".."), { recursive: true });
  await writeFile(join(home, path), content);
}

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), "xatlas-share-"));
  homes.push(home);
  await write(
    home,
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        docs: { type: "http", url: "https://docs.example/mcp" },
        "codex-cu": { type: "stdio", command: "/py", args: ["proxy.py", "--", "/node", "cua-repl.mjs"], timeout: 300000 },
      },
    }),
  );
  await write(
    home,
    ".codex/config.toml",
    'model = "x"\n[mcp_servers.blender]\ncommand = "uvx"\nargs = ["blender-mcp"]\n[mcp_servers.node_repl]\ncommand = "/node_repl"\n[mcp_servers.off]\ncommand = "x"\nenabled = false\n',
  );
  await write(home, ".gemini/settings.json", JSON.stringify({ security: { auth: {} } }));
  await write(home, ".config/opencode/opencode.json", JSON.stringify({ mcp: {} }));
  await write(home, ".claude/CLAUDE.md", "# My rules\n\nBe brief.\n");
  await write(home, ".codex/AGENTS.md", "");
  await write(home, ".agents/skills/release-notes/SKILL.md", "---\nname: release-notes\n---\n");
  await write(home, ".claude/skills/release-notes/SKILL.md", "own copy");
  return home;
}

async function preview(home: string, agents: readonly AgentId[]) {
  const seed = await computeHubSeed(home, { memoryServer });
  const hub = withSeed(await readHub(home), seed);
  const plan = await planShare({
    home,
    hub,
    state: await readShareState(hub.root),
    agents,
    ...(seed.instructionsFrom ? { instructionsFrom: seed.instructionsFrom } : {}),
  });
  return { seed, hub, plan };
}

describe("sharing agents' configuration", () => {
  it("seeds the shared folder from what the agents already have", async () => {
    const home = await fakeHome();
    const { seed } = await preview(home, []);

    expect(Object.keys(seed.mcp ?? {}).sort()).toEqual(["blender", "codex-cu", "docs", "xatlas-memory"]);
    // Codex has its own computer use, and its internal REPL only works inside Codex.
    expect(seed.mcp?.["codex-cu"]?.except).toEqual(["codex"]);
    expect(seed.instructionsFrom).toBe("claude");
    expect(seed.instructions).toContain("Be brief.");
    expect(seed.instructions).toContain("xatlas-memory");
  });

  it("plans each agent's changes without writing anything", async () => {
    const home = await fakeHome();
    const { plan } = await preview(home, ["claude", "codex", "gemini", "opencode"]);
    const kinds = (agent: AgentId) =>
      plan.actions.filter((action) => action.agent === agent).map((action) => `${action.kind}:${"name" in action ? action.name : ""}`);

    expect(kinds("claude")).toEqual(["mcp-set:blender", "mcp-set:xatlas-memory", "instructions-import:"]);
    expect(kinds("codex")).toEqual(["mcp-set:docs", "mcp-set:xatlas-memory", "skill-link:release-notes", "instructions-link:"]);
    expect(kinds("gemini")).toContain("mcp-set:codex-cu");
    expect(plan.notes.find((note) => note.agent === "claude")?.kind).toBe("own-copy");
    await expect(lstat(join(home, ".agents/mcp.json"))).rejects.toThrow();
  });

  it("applies the plan with backups, then has nothing left to do", async () => {
    const home = await fakeHome();
    const commands: string[] = [];
    const { seed, hub, plan } = await preview(home, ["claude", "codex", "gemini", "opencode", "xatlas"]);
    await writeHubSeed(home, seed);
    const results = await new ShareApplier(home, hub.root, async (command, args) => {
      commands.push(`${command} ${args.slice(0, 3).join(" ")}`);
    }).apply(plan.actions);

    expect(results.filter((result) => result.error)).toEqual([]);
    expect(commands).toContain("claude mcp add-json blender");
    expect(commands).toContain("codex mcp add docs");
    const gemini = JSON.parse(await readFile(join(home, ".gemini/settings.json"), "utf8"));
    expect(gemini.mcpServers["codex-cu"]).toMatchObject({ command: "/py", timeout: 300000 });
    expect(gemini.security).toEqual({ auth: {} });
    const opencode = JSON.parse(await readFile(join(home, ".config/opencode/opencode.json"), "utf8"));
    expect(opencode.mcp.docs).toEqual({ type: "remote", url: "https://docs.example/mcp", enabled: true });
    expect(opencode.instructions).toEqual(["~/.agents/AGENTS.md"]);
    expect(await readFile(join(home, ".claude/CLAUDE.md"), "utf8")).toContain("@~/.agents/AGENTS.md");
    expect(await readFile(join(home, ".claude/CLAUDE.md"), "utf8")).not.toContain("Be brief.");
    expect(await readlink(join(home, ".codex/AGENTS.md"))).toBe(join(home, ".agents/AGENTS.md"));
    expect(await readlink(join(home, ".codex/skills/release-notes"))).toBe(join(home, ".agents/skills/release-notes"));
    const xatlas = JSON.parse(await readFile(join(home, ".zcode/cli/config.json"), "utf8"));
    expect(xatlas.mcp.servers.docs).toEqual({ type: "http", url: "https://docs.example/mcp" });

    const backups = await readFile(join(hub.root, "backups", (await import("node:fs")).readdirSync(join(hub.root, "backups"))[0]!, ".claude/CLAUDE.md"), "utf8");
    expect(backups).toContain("Be brief.");

    // Gemini, OpenCode and xatlas are written directly, so a second pass sees them in sync.
    const again = await preview(home, ["gemini", "opencode", "xatlas"]);
    expect(again.plan.actions).toEqual([]);
  });

  it("removes only what it added when a server stops being shared", async () => {
    const home = await fakeHome();
    await write(home, ".agents/mcp.json", JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example/mcp" } } }));
    const first = await preview(home, ["gemini"]);
    await new ShareApplier(home, first.hub.root, async () => {}).apply(first.plan.actions);
    const settings = JSON.parse(await readFile(join(home, ".gemini/settings.json"), "utf8"));
    settings.mcpServers.mine = { command: "mine" };
    await writeFile(join(home, ".gemini/settings.json"), JSON.stringify(settings));

    await write(home, ".agents/mcp.json", JSON.stringify({ mcpServers: {} }));
    const second = await preview(home, ["gemini"]);
    expect(second.plan.actions).toEqual<ShareAction[]>([{ kind: "mcp-remove", agent: "gemini", name: "docs" }]);
    await new ShareApplier(home, second.hub.root, async () => {}).apply(second.plan.actions);
    expect(Object.keys(JSON.parse(await readFile(join(home, ".gemini/settings.json"), "utf8")).mcpServers)).toEqual(["mine"]);
  });

  it("leaves an agent's own differing server alone", async () => {
    const home = await fakeHome();
    await write(home, ".agents/mcp.json", JSON.stringify({ mcpServers: { blender: { type: "stdio", command: "other" } } }));
    const { plan } = await preview(home, ["codex"]);
    expect(plan.actions.some((action) => action.kind === "mcp-set")).toBe(false);
    expect(plan.notes.some((note) => note.kind === "conflict" && note.message.includes("blender"))).toBe(true);
  });
});

describe("computer use servers", () => {
  it("recognizes UCU, which Codex doesn't need", () => {
    expect(isComputerUseServer("ucu", { type: "stdio", command: "python3" })).toBe(true);
    expect(
      isComputerUseServer("renamed", { type: "stdio", command: "python3", args: ["-I", "/x/ucu-proxy.py"] }),
    ).toBe(true);
    expect(isComputerUseServer("github", { type: "stdio", command: "gh-mcp" })).toBe(false);
  });
});
