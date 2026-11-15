import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { agentPaths } from "./paths.js";
import type { AgentId, ShareAction, SharedMcpServer, ShareState } from "./types.js";

export const STATE_FILE = ".xatlas-share.json";

/** Runs an agent's own CLI; injected so tests don't touch real configs. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<void>;

export const runCommand: CommandRunner = async (command, args) => {
  await promisify(execFile)(command, [...args], { timeout: 60_000 });
};

export interface ApplyResult {
  readonly action: ShareAction;
  readonly error?: string;
}

export async function readShareState(hubRoot: string): Promise<ShareState> {
  try {
    const parsed = JSON.parse(await readFile(join(hubRoot, STATE_FILE), "utf8")) as Partial<ShareState>;
    return { mcp: parsed.mcp ?? {}, skills: parsed.skills ?? {} };
  } catch {
    return { mcp: {}, skills: {} };
  }
}

function track(list: Partial<Record<AgentId, string[]>>, agent: AgentId, name: string, present: boolean) {
  const names = new Set(list[agent] ?? []);
  if (present) names.add(name);
  else names.delete(name);
  list[agent] = [...names].sort();
}

/** The entry each agent's own config format expects. */
function formatServer(agent: AgentId, server: SharedMcpServer): Record<string, unknown> {
  const remote = server.type !== "stdio" && server.url;
  const env = server.env && Object.keys(server.env).length > 0 ? server.env : undefined;
  const headers = server.headers && Object.keys(server.headers).length > 0 ? server.headers : undefined;
  switch (agent) {
    case "opencode":
      return remote
        ? { type: "remote", url: server.url, ...(headers ? { headers } : {}), enabled: true }
        : { type: "local", command: [server.command, ...(server.args ?? [])], ...(env ? { environment: env } : {}), enabled: true };
    case "gemini":
      return remote
        ? { ...(server.type === "sse" ? { url: server.url } : { httpUrl: server.url }), ...(headers ? { headers } : {}) }
        : { command: server.command, args: server.args ?? [], ...(env ? { env } : {}), ...(server.timeout ? { timeout: server.timeout } : {}) };
    case "claude":
      return remote
        ? { type: server.type, url: server.url, ...(headers ? { headers } : {}) }
        : { type: "stdio", command: server.command, args: server.args ?? [], ...(env ? { env } : {}), ...(server.timeout ? { timeout: server.timeout } : {}) };
    default:
      return remote
        ? { type: server.type, url: server.url, ...(headers ? { headers } : {}) }
        : { type: "stdio", command: server.command, args: server.args ?? [], ...(env ? { env } : {}) };
  }
}

export class ShareApplier {
  private readonly stamp = new Date().toISOString().replace(/[:.]/g, "-");
  private readonly backedUp = new Set<string>();

  constructor(
    private readonly home: string,
    private readonly hubRoot: string,
    private readonly run: CommandRunner = runCommand,
  ) {}

  /** Applies each action in order; one failing doesn't stop the rest. */
  async apply(actions: readonly ShareAction[]): Promise<ApplyResult[]> {
    const state = await readShareState(this.hubRoot);
    const results: ApplyResult[] = [];
    for (const action of actions) {
      try {
        await this.applyOne(action, state);
        results.push({ action });
      } catch (error) {
        results.push({ action, error: error instanceof Error ? error.message : String(error) });
      }
      await writeFile(join(this.hubRoot, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    }
    return results;
  }

  private async applyOne(action: ShareAction, state: ShareState): Promise<void> {
    switch (action.kind) {
      case "mcp-set":
        await this.setServer(action.agent, action.name, action.server, action.replace);
        track(state.mcp, action.agent, action.name, true);
        return;
      case "mcp-remove":
        await this.removeServer(action.agent, action.name);
        track(state.mcp, action.agent, action.name, false);
        return;
      case "skill-link":
        await mkdir(dirname(action.link), { recursive: true });
        await symlink(action.target, action.link, "dir");
        track(state.skills, action.agent, action.name, true);
        return;
      case "skill-unlink":
        await unlink(action.link);
        track(state.skills, action.agent, action.name, false);
        return;
      case "instructions-link":
        await this.backup(action.path);
        await mkdir(dirname(action.path), { recursive: true });
        await rm(action.path, { force: true });
        await symlink(action.target, action.path);
        return;
      case "instructions-import": {
        await this.backup(action.path);
        const block = `<!-- Shared with every coding agent on this machine; edit it there. -->\n${action.line}\n`;
        const current = existsSync(action.path) ? await readFile(action.path, "utf8") : "";
        // `replace`: the content moved into the shared file, so only the import stays here.
        await this.writeText(action.path, action.replace || !current.trim() ? block : `${current.trimEnd()}\n\n${block}`);
        return;
      }
      case "instructions-entry":
        await this.editJson(action.path, (config) => {
          const entries = Array.isArray(config.instructions) ? config.instructions : [];
          config.instructions = [...entries, action.entry];
        });
        return;
    }
  }

  private async setServer(agent: AgentId, name: string, server: SharedMcpServer, replace: boolean) {
    await this.backup(agentPaths(this.home, agent).mcpFile);
    if (agent === "claude") {
      if (replace) await this.run("claude", ["mcp", "remove", name, "-s", "user"]);
      await this.run("claude", ["mcp", "add-json", name, JSON.stringify(formatServer(agent, server)), "-s", "user"]);
      return;
    }
    if (agent === "codex") {
      if (server.type !== "stdio" && server.headers && Object.keys(server.headers).length > 0) {
        throw new Error("Codex's `mcp add` can't set HTTP headers; add this server to ~/.codex/config.toml by hand");
      }
      if (replace) await this.run("codex", ["mcp", "remove", name]);
      const args =
        server.type !== "stdio" && server.url
          ? ["mcp", "add", name, "--url", server.url]
          : [
              "mcp",
              "add",
              name,
              ...Object.entries(server.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
              "--",
              server.command ?? "",
              ...(server.args ?? []),
            ];
      await this.run("codex", args);
      return;
    }
    await this.editServers(agent, (servers) => {
      servers[name] = formatServer(agent, server);
    });
  }

  private async removeServer(agent: AgentId, name: string) {
    await this.backup(agentPaths(this.home, agent).mcpFile);
    if (agent === "claude") return this.run("claude", ["mcp", "remove", name, "-s", "user"]);
    if (agent === "codex") return this.run("codex", ["mcp", "remove", name]);
    await this.editServers(agent, (servers) => {
      delete servers[name];
    });
  }

  private async editServers(agent: AgentId, edit: (servers: Record<string, unknown>) => void) {
    await this.editJson(agentPaths(this.home, agent).mcpFile, (config) => {
      if (agent === "xatlas") {
        const mcp = (config.mcp ??= {}) as Record<string, unknown>;
        edit((mcp.servers ??= {}) as Record<string, unknown>);
      } else {
        edit((config[agent === "opencode" ? "mcp" : "mcpServers"] ??= {}) as Record<string, unknown>);
      }
    });
  }

  private async editJson(path: string, edit: (config: Record<string, unknown>) => void) {
    await this.backup(path);
    const config = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>) : {};
    edit(config);
    await this.writeText(path, `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Writes through a temporary file, keeping the original's permissions. */
  private async writeText(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true });
    const mode = existsSync(path) ? (await stat(path)).mode & 0o777 : 0o644;
    const temporary = `${path}.xatlas-tmp`;
    await writeFile(temporary, text, { mode });
    await rename(temporary, path);
  }

  /** Copies a file once per run into `<hub>/backups/<time>/` before it's changed. */
  private async backup(path: string) {
    if (this.backedUp.has(path) || !existsSync(path)) return;
    this.backedUp.add(path);
    const relative = path.startsWith(`${this.home}/`) ? path.slice(this.home.length + 1) : path.replace(/^\//, "");
    const destination = join(this.hubRoot, "backups", this.stamp, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(path, destination);
  }
}
