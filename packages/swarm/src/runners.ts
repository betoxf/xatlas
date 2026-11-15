import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeAdvisorCommand, memberCommand } from "./commands.js";
import { askOpenRouter } from "./openrouter.js";
import { checkWeight } from "./vote.js";
import type { AskMember, AvailableAgent, Effort, SwarmAdvisor, SwarmAgent, SwarmMember } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/**
 * The agents' sign-ins live under the user's real home. The sandboxed dev app moves HOME
 * and passes the real one as XATLAS_GH_HOME (see scripts/dev-desktop-sandbox.sh).
 */
function realHome(): string | undefined {
  return process.env["XATLAS_GH_HOME"]?.trim() || undefined;
}

let loginPath: Promise<string | undefined> | undefined;

/**
 * The PATH of the user's login shell. An app started from the Dock gets a minimal PATH, and
 * CLIs that are Node scripts (`#!/usr/bin/env node`) then run under whichever `node` that
 * finds; the terminal's PATH is the one the user has made work.
 */
function resolveLoginPath(): Promise<string | undefined> {
  loginPath ??= new Promise((resolve) => {
    const shell = process.env["SHELL"] || "/bin/zsh";
    const home = realHome();
    execFile(
      shell,
      ["-ilc", "printf '%s' \"$PATH\""],
      { timeout: 10_000, env: home ? { ...process.env, HOME: home } : process.env },
      (error, stdout) => resolve(error ? undefined : stdout.trim().split("\n").pop()?.trim() || undefined),
    );
  });
  return loginPath;
}

export async function cliEnv(): Promise<NodeJS.ProcessEnv> {
  const home = realHome();
  const path = await resolveLoginPath();
  return { ...process.env, ...(home ? { HOME: home } : {}), ...(path ? { PATH: path } : {}) };
}

/** Runs a command with the prompt on stdin and returns stdout. */
async function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; input?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const env = await cliEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code ?? "a signal"}: ${(stderr || stdout).trim().slice(-400)}`));
    });
    child.stdin.end(options.input ?? "");
  });
}

/** Text of an OpenCode `--format json` run: its `text` parts, or the error it reported. */
export function readOpenCodeEvents(output: string): string {
  const texts: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; part?: { text?: string }; error?: { data?: { message?: string } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "error") throw new Error(event.error?.data?.message ?? "OpenCode reported an error");
    if (event.type === "text" && typeof event.part?.text === "string") texts.push(event.part.text);
  }
  return texts.join("").trim();
}

/** Each agent's headless mode, read-only where the agent supports it. The arguments come from `memberCommand`. */
export const askMember: AskMember = async (member, prompt, { cwd, signal }) => {
  const runIt = (replyFile: string) => {
    const { command, args, stdin } = memberCommand(member, prompt, replyFile);
    return run(command, args, { cwd, ...(stdin !== undefined ? { input: stdin } : {}), ...(signal ? { signal } : {}) });
  };
  switch (member.agent) {
    case "claude":
    case "gemini":
      return (await runIt("")).trim();
    case "codex": {
      const dir = await mkdtemp(join(tmpdir(), "xatlas-swarm-"));
      try {
        const out = join(dir, "reply.md");
        await runIt(out);
        return (await readFile(out, "utf8")).trim();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    case "opencode":
      return readOpenCodeEvents(await runIt(""));
  }
};

/** stdout and stderr together: some CLIs (codex login status) report on stderr. */
export const runCliText = async (command: string, args: readonly string[]) => {
  const { stdout, stderr } = await promisify(execFile)(command, [...args], { timeout: 20_000, env: await cliEnv() });
  return `${stdout}${stderr}`;
};

interface AgentProbe {
  readonly ready: boolean;
  readonly detail: string;
  readonly models?: readonly string[];
}

const AGENT_PROBES: Record<SwarmAgent, () => Promise<AgentProbe>> = {
  claude: async () => {
    const output = await runCliText("claude", ["auth", "status"]);
    const status = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as { loggedIn?: boolean };
    return {
      ready: status.loggedIn === true,
      detail: status.loggedIn ? "signed in" : "run `claude` and /login",
    };
  },
  codex: async () => {
    const status = await runCliText("codex", ["login", "status"]).catch((error: { code?: unknown; stdout?: string; stderr?: string }) => {
      if (error.code === "ENOENT") throw error;
      return `${error.stdout ?? ""}${error.stderr ?? ""}`;
    });
    const ready = /logged in/i.test(status) && !/not logged in/i.test(status);
    return { ready, detail: ready ? status.trim().split("\n")[0]! : "run `codex login`" };
  },
  opencode: async () => {
    const models = (await runCliText("opencode", ["models"])).split("\n").map((line) => line.trim()).filter(Boolean);
    return { ready: models.length > 0, detail: `${models.length} models (sign-ins are checked when a run starts)`, models };
  },
  gemini: async () => {
    await runCliText("gemini", ["--version"]);
    // Without a sign-in Gemini CLI waits forever instead of failing, so this has to be checked first.
    const env = await cliEnv();
    const home = env["HOME"] ?? "";
    const settings = await readFile(join(home, ".gemini", "settings.json"), "utf8").catch(() => "{}");
    const authType = (JSON.parse(settings) as { security?: { auth?: { selectedType?: string } } }).security?.auth?.selectedType;
    const hasKey = Boolean(env["GEMINI_API_KEY"]);
    const hasGoogleSignIn = await readFile(join(home, ".gemini", "oauth_creds.json"), "utf8").then(() => true, () => false);
    if (hasKey || (authType !== "gemini-api-key" && hasGoogleSignIn)) {
      return { ready: true, detail: "signed in", models: ["gemini-2.5-pro", "gemini-2.5-flash"] };
    }
    return { ready: false, detail: "set GEMINI_API_KEY, or run `gemini` and choose Google sign-in" };
  },
};

/** Whether one agent CLI is installed and signed in. */
export async function checkAgent(agent: SwarmAgent): Promise<AvailableAgent> {
  try {
    const { ready, detail, models } = await AGENT_PROBES[agent]();
    return { agent, installed: true, ready, detail, ...(models ? { models } : {}) };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { agent, installed: !missing, ready: false, detail: missing ? "not installed" : "couldn't check its sign-in" };
  }
}

/** Which agent CLIs are installed and signed in. */
export function listAvailableAgents(): Promise<AvailableAgent[]> {
  return Promise.all((Object.keys(AGENT_PROBES) as SwarmAgent[]).map(checkAgent));
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * A member from `agent[:model][+option…]`, e.g. `claude:claude-mythos-5-2+max+w2` or
 * `claude:opus+vote`. Options: an effort (low, medium, high, xhigh, max), `fast`, `vote`
 * (a fresh voter that only ranks the plans) and `w<number>` (vote weight, e.g. `w2`, `w0.5`).
 * The whole spec is the member's id, so the same model can sit twice with different options.
 */
export function parseMember(spec: string): SwarmMember {
  const [base = "", ...options] = spec.split("+");
  const [agent, ...rest] = base.split(":");
  if (!agent || !["claude", "codex", "opencode", "gemini"].includes(agent)) {
    throw new Error(`Unknown agent in "${spec}"; use claude, codex, opencode or gemini, optionally with :model and +options`);
  }
  const model = rest.join(":").trim();
  let member: SwarmMember = { id: spec, agent: agent as SwarmAgent, ...(model ? { model } : {}) };
  for (const raw of options) {
    const option = raw.trim().toLowerCase();
    if ((EFFORTS as readonly string[]).includes(option)) member = { ...member, effort: option as Effort };
    else if (option === "fast") member = { ...member, fast: true };
    else if (option === "vote") member = { ...member, votesOnly: true };
    else if (/^w\d*\.?\d+$/.test(option)) {
      const weight = Number(option.slice(1));
      checkWeight(weight, `"${spec}"`);
      member = { ...member, weight };
    } else {
      throw new Error(`Unknown option "${raw}" in "${spec}"; use ${EFFORTS.join(", ")}, fast, vote or w<weight>`);
    }
  }
  return member;
}

/**
 * Asks Claude Code as an outside advisor: no tools, no MCP servers, no skills (see
 * `claudeAdvisorCommand`), in an empty folder made for the call and removed after it. It runs
 * on the person's own sign-in and gets the prompt alone, on stdin.
 */
export async function askClaudeAdvisor(
  prompt: string,
  options: { readonly model: string; readonly effort?: Effort; readonly signal?: AbortSignal },
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xatlas-advisor-"));
  try {
    const { command, args, stdin } = claudeAdvisorCommand(prompt, options);
    const reply = (await run(command, args, { cwd: dir, ...(stdin !== undefined ? { input: stdin } : {}), ...(options.signal ? { signal: options.signal } : {}) })).trim();
    if (!reply) throw new Error(`Claude Code gave no answer from ${options.model}.`);
    return reply;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ADVISOR_VIAS = ["openrouter", "claude"] as const;

/**
 * An outside advisor from `openrouter:<model>[+effort]` or `claude:<model>[+effort]`, e.g.
 * `openrouter:google/gemini-4-argon` or `claude:opus+high`. Either gets the prompt alone: no
 * repository and no tools. OpenRouter is an HTTP call; Claude Code runs with every tool turned
 * off in an empty folder (`askClaudeAdvisor`). Codex, OpenCode and Gemini CLI can't be advisors:
 * even in an empty folder they keep their file tools and the real home, so a plan that names a
 * path could lead them into the project.
 */
export function parseAdvisor(spec: string): SwarmAdvisor {
  const via = ADVISOR_VIAS.find((name) => spec.startsWith(`${name}:`));
  if (!via) {
    throw new Error(`"${spec}" can't be the advisor: only openrouter:<model>[+effort] or claude:<model>[+effort] can (e.g. openrouter:google/gemini-4-argon or claude:opus+high), because the advisor must see no project and use no tools. Claude Code can run with every tool turned off; Codex, OpenCode and Gemini CLI keep their file tools even in an empty folder.`);
  }
  const [rawModel = "", ...options] = spec.slice(via.length + 1).split("+");
  const model = rawModel.trim();
  if (!model) throw new Error(`No model in "${spec}"; use ${via}:<model>, e.g. ${via === "openrouter" ? "openrouter:google/gemini-4-argon" : "claude:opus"}`);
  let effort: Effort | undefined;
  for (const raw of options) {
    const option = raw.trim().toLowerCase();
    if (!(EFFORTS as readonly string[]).includes(option)) throw new Error(`Unknown option "${raw}" in "${spec}"; an advisor takes only an effort (${EFFORTS.join(", ")})`);
    effort = option as Effort;
  }
  const ask = via === "openrouter" ? askOpenRouter : askClaudeAdvisor;
  return {
    id: spec,
    ask: (prompt, { signal }) => ask(prompt, { model, ...(effort ? { effort } : {}), ...(signal ? { signal } : {}) }),
  };
}
