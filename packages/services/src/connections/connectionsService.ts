import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ShareApplier,
  UCU_SERVER_NAME,
  hubRoot,
  readAgentRawServers,
  readShareState,
  sameServer,
  toSharedServer,
  type AgentId,
  type ShareAction,
} from "@zcode/agent-share";
import {
  checkAgent,
  forgetAgentAccount,
  listAvailableAgents,
  readAgentAccount,
  runCliText,
  startCodexSignIn,
  type AgentAccount,
  type AvailableAgent,
} from "@zcode/swarm";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { syncCliAgentProviders, type CliAgentProviderSettings } from "./cliAgentProviders.js";
import type { ConnectionId, ConnectionStatus, IConnectionsService } from "./connections.js";

const logger = createServiceLogger("connections");

const UCU_REPOSITORY = "https://github.com/betoxf/universal-computer-use";
const UCU_FOLDER = "$HOME/.local/share/universal-computer-use";
/** Agents that take UCU when it's on everywhere; Codex has the same engine built in. */
const UCU_AGENTS: readonly AgentId[] = ["gemini", "opencode", "xatlas"];

interface ConnectionTarget {
  readonly name: string;
  readonly command: string;
  readonly downloadUrl: string;
}

const CONNECTIONS: Record<ConnectionId, ConnectionTarget> = {
  claude: {
    name: "Claude Code",
    command: "claude auth login",
    downloadUrl: "https://claude.com/claude-code",
  },
  codex: {
    name: "Codex",
    command: "codex login",
    downloadUrl: "https://developers.openai.com/codex/cli",
  },
  // Gemini CLI has no login command; its first run offers Google sign-in.
  gemini: {
    name: "Gemini CLI",
    command: "gemini",
    downloadUrl: "https://github.com/google-gemini/gemini-cli",
  },
  opencode: {
    name: "OpenCode",
    command: "opencode auth login",
    downloadUrl: "https://opencode.ai",
  },
  github: {
    name: "GitHub",
    command: "gh auth login",
    downloadUrl: "https://cli.github.com",
  },
  ucu: {
    name: "UCU",
    command:
      `git -C "${UCU_FOLDER}" pull --ff-only 2>/dev/null || ` +
      `git clone ${UCU_REPOSITORY}.git "${UCU_FOLDER}"; ` +
      // The installer lives in the repository's `ucu` folder, not at its root.
      `cd "${UCU_FOLDER}/ucu" && ./ucu install && ./ucu doctor`,
    downloadUrl: UCU_REPOSITORY,
  },
};

/** Sign-ins live under the real home; the sandboxed dev app moves HOME. */
function userHome(): string {
  return process.env.XATLAS_GH_HOME?.trim() || homedir();
}

/**
 * Terminal runs a `.command` file without Automation access, and the file holds only the
 * tool's own command, run in the user's login shell so its PATH applies.
 */
async function openInTerminal(target: ConnectionTarget): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const file = join(await mkdtemp(join(tmpdir(), "xatlas-")), "Connect to xatlas.command");
  const quoted = `'${target.command.replaceAll("'", `'\\''`)}'`;
  await writeFile(
    file,
    [
      "#!/bin/sh",
      "clear",
      `echo "Connecting ${target.name} to xatlas."`,
      "echo",
      `"\${SHELL:-/bin/zsh}" -ilc ${quoted}`,
      "echo",
      'echo "You can close this window and go back to xatlas."',
      'rm -f "$0"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await promisify(execFile)("open", [file]);
  return true;
}

async function checkGitHub(): Promise<
  Pick<ConnectionStatus, "installed" | "connected" | "detail">
> {
  try {
    await runCliText("gh", ["auth", "status"]);
    return { installed: true, connected: true, detail: "signed in" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { installed: false, connected: false, detail: "not installed" }
      : { installed: true, connected: false, detail: "run `gh auth login`" };
  }
}

async function checkUcu(): Promise<ConnectionStatus> {
  const home = userHome();
  const claudeServers = await readAgentRawServers(home, "claude");
  const opencodeServers = await readAgentRawServers(home, "opencode");
  const installed = UCU_SERVER_NAME in claudeServers || UCU_SERVER_NAME in opencodeServers;
  const state = await readShareState(hubRoot(home));
  const everywhere = UCU_AGENTS.some((agent) => state.mcp[agent]?.includes(UCU_SERVER_NAME));
  return {
    id: "ucu",
    installed,
    connected: installed,
    detail: installed ? "set up" : "not set up",
    command: CONNECTIONS.ucu.command,
    downloadUrl: CONNECTIONS.ucu.downloadUrl,
    everywhere,
  };
}

/** The actions that put UCU in, or take it out of, every agent that can use it. */
async function ucuShareActions(home: string, enabled: boolean): Promise<ShareAction[]> {
  // The sandboxed dev app has its own agent config, which isn't under the real home.
  const agents = process.env.XATLAS_GH_HOME
    ? UCU_AGENTS.filter((id) => id !== "xatlas")
    : UCU_AGENTS;
  const actions: ShareAction[] = [];
  const state = await readShareState(hubRoot(home));
  if (!enabled) {
    for (const agent of agents) {
      if (state.mcp[agent]?.includes(UCU_SERVER_NAME)) {
        actions.push({ kind: "mcp-remove", agent, name: UCU_SERVER_NAME });
      }
    }
    return actions;
  }
  const server = toSharedServer(
    "claude",
    (await readAgentRawServers(home, "claude"))[UCU_SERVER_NAME],
  );
  if (!server) throw new Error("Set up UCU first: it isn't registered in Claude Code yet.");
  for (const agent of agents) {
    const raw = (await readAgentRawServers(home, agent))[UCU_SERVER_NAME];
    const existing = raw === undefined ? undefined : toSharedServer(agent, raw);
    if (existing && sameServer(existing, server)) continue;
    actions.push({
      kind: "mcp-set",
      agent,
      name: UCU_SERVER_NAME,
      server,
      replace: raw !== undefined,
    });
  }
  return actions;
}

function agentStatus(agent: AvailableAgent): ConnectionStatus {
  const { command, downloadUrl } = CONNECTIONS[agent.agent];
  return {
    id: agent.agent,
    installed: agent.installed,
    connected: agent.ready,
    detail: agent.detail,
    command,
    downloadUrl,
  };
}

async function githubStatus(): Promise<ConnectionStatus> {
  const { command, downloadUrl } = CONNECTIONS.github;
  return { id: "github", ...(await checkGitHub()), command, downloadUrl };
}

const isCliAgent = (id: ConnectionId): id is AvailableAgent["agent"] =>
  id !== "github" && id !== "ucu";

export interface ConnectionsServiceDependencies {
  readonly providerSettings: CliAgentProviderSettings;
  readonly listAgents?: typeof listAvailableAgents;
  readonly checkAgent?: typeof checkAgent;
  readonly readAccount?: (
    agent: AvailableAgent["agent"],
    options: { readonly maxAgeMs?: number },
  ) => Promise<AgentAccount> | undefined;
  readonly startCodexSignIn?: typeof startCodexSignIn;
  readonly openTerminal?: (target: ConnectionTarget) => Promise<boolean>;
}

export function createConnectionsService(
  dependencies: ConnectionsServiceDependencies,
): IConnectionsService {
  const listAgents = dependencies.listAgents ?? listAvailableAgents;
  const checkOneAgent = dependencies.checkAgent ?? checkAgent;
  const openTerminal = dependencies.openTerminal ?? openInTerminal;
  const readAccount = dependencies.readAccount ?? readAgentAccount;
  const startBrowserSignIn = dependencies.startCodexSignIn ?? startCodexSignIn;
  /** The last sign-in state seen per agent, so a change drops its saved account. */
  const lastReady = new Map<ConnectionId, boolean>();
  const noteReady = (agent: AvailableAgent) => {
    if (lastReady.has(agent.agent) && lastReady.get(agent.agent) !== agent.ready) {
      forgetAgentAccount(agent.agent);
    }
    lastReady.set(agent.agent, agent.ready);
  };
  // One sync at a time: two at once could both create a CLI's provider.
  let syncs: Promise<unknown> = Promise.resolve();

  const sync = (agents: readonly AvailableAgent[]) => {
    const run = syncs.then(() => syncCliAgentProviders(dependencies.providerSettings, agents));
    syncs = run.catch((error: unknown) => {
      // A failed sync leaves the picker as it was; the rows still show the truth.
      logger.warn(undefined, "CLI 模型同步失败", { error });
    });
    return syncs;
  };

  const service: IConnectionsService = {
    async list() {
      const [agents, github, ucu] = await Promise.all([listAgents(), githubStatus(), checkUcu()]);
      agents.forEach(noteReady);
      // A CLI with many models takes a while to add, and the rows shouldn't wait for it.
      void sync(agents);
      // Claude Code and Codex list their models with their account, so ask them in the background.
      for (const agent of agents) {
        if (agent.ready && !agent.models)
          void service.account({ id: agent.agent }).catch(() => null);
      }
      return [...agents.map(agentStatus), github, ucu];
    },
    async check({ id }) {
      if (id === "github") return githubStatus();
      if (id === "ucu") return checkUcu();
      const agent = await checkOneAgent(id);
      noteReady(agent);
      void sync([agent]);
      return agentStatus(agent);
    },
    async account({ id, refresh }) {
      if (!isCliAgent(id)) return null;
      const pending = readAccount(id, refresh ? { maxAgeMs: 0 } : {});
      if (!pending) return null;
      const account = await pending;
      // The agent's own list replaces whatever the picker had for it.
      if (account.signedIn && account.models) {
        void sync([
          {
            agent: id,
            installed: true,
            ready: true,
            detail: "",
            models: account.models,
          },
        ]);
      }
      return {
        ...account,
        checkedAt: account.checkedAt ?? new Date().toISOString(),
      };
    },
    async signIn({ id }) {
      if (id === "codex") {
        try {
          const { authUrl, finished } = await startBrowserSignIn();
          void finished.then(() => forgetAgentAccount("codex"));
          return { opened: true, url: authUrl };
        } catch (error) {
          // An older Codex without the app server's sign-in still has `codex login`.
          logger.warn(undefined, "Codex 浏览器登录启动失败", { error });
        }
      }
      return { opened: await openTerminal(CONNECTIONS[id]) };
    },
    async setUcuEverywhere({ enabled }) {
      const home = userHome();
      await mkdir(hubRoot(home), { recursive: true });
      const actions = await ucuShareActions(home, enabled);
      const results = await new ShareApplier(home, hubRoot(home)).apply(actions);
      const failed = results.find((result) => result.error);
      if (failed) throw new Error(failed.error);
      return checkUcu();
    },
  };
  return service;
}
