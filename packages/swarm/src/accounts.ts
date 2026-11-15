import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEnv } from "./runners.js";
import type { AgentAccount, AvailableAgent, SwarmAgent, UsageWindow } from "./types.js";

/** How long one account check may take before it's given up. */
const PROBE_TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A CLI's stdio protocol, one JSON object per line. */
interface JsonLinesSession {
  send(message: Json): void;
  end(): void;
}

/**
 * Runs a CLI that speaks JSON lines on stdio until `onLine` returns a result, the CLI exits or
 * the timeout passes. The CLI is always stopped before this returns.
 */
async function talk<T>(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number },
  start: (session: JsonLinesSession) => void,
  onLine: (line: Json, session: JsonLinesSession) => T | undefined,
): Promise<T> {
  const env = await cliEnv();
  return new Promise<T>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let settled = false;
    const finish = (outcome: { value: T } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if ("value" in outcome) resolve(outcome.value);
      else reject(outcome.error);
    };
    const timer = setTimeout(
      () => finish({ error: new Error(`${command} didn't answer in time`) }),
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    const session: JsonLinesSession = {
      send: (message) => {
        if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      end: () => child.stdin.end(),
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!raw.startsWith("{")) continue;
        let line: Json | undefined;
        try {
          line = record(JSON.parse(raw));
        } catch {
          continue;
        }
        if (!line) continue;
        try {
          const value = onLine(line, session);
          if (value !== undefined) finish({ value });
        } catch (error) {
          finish({
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => finish({ error }));
    child.on("close", (code) =>
      finish({
        error: new Error(`${command} stopped (${code ?? "signal"}) before answering`),
      }),
    );
    start(session);
  });
}

// ---------------------------------------------------------------- Codex

const CODEX_PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  team: "Team",
  business: "Business",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  enterprise: "Enterprise",
};

/** Codex's plan as people know it, e.g. `prolite` is Pro Lite. */
export function codexPlanName(planType: string | undefined): string | undefined {
  if (!planType || planType === "unknown") return undefined;
  if (CODEX_PLAN_NAMES[planType]) return CODEX_PLAN_NAMES[planType];
  if (planType.includes("business")) return "Business";
  if (planType.startsWith("ent")) return "Enterprise";
  return planType
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function codexWindow(value: unknown): UsageWindow | undefined {
  const window = record(value);
  const usedPercent = number(window?.usedPercent);
  if (usedPercent === undefined) return undefined;
  const minutes = number(window?.windowDurationMins);
  const resetsAt = number(window?.resetsAt);
  return {
    usedPercent,
    ...(minutes ? { minutes } : {}),
    ...(resetsAt ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}),
  };
}

/** What `codex app-server` reported: `account/read`, `account/rateLimits/read` and `model/list`. */
export function readCodexAccount(answers: {
  readonly account?: unknown;
  readonly rateLimits?: unknown;
  readonly models?: unknown;
}): AgentAccount {
  const account = record(record(answers.account)?.account);
  const snapshot = record(record(answers.rateLimits)?.rateLimits);
  const plan =
    account?.type === "apiKey"
      ? "API key"
      : codexPlanName(text(account?.planType) ?? text(snapshot?.planType));
  const windows = [codexWindow(snapshot?.primary), codexWindow(snapshot?.secondary)].filter(
    (window): window is UsageWindow => window !== undefined,
  );
  const listed = (record(answers.models)?.data as unknown[] | undefined) ?? [];
  const models = listed
    .map(record)
    .filter((model) => model && model.hidden !== true)
    .sort((a, b) => Number(b?.isDefault === true) - Number(a?.isDefault === true))
    .map((model) => text(model?.id))
    .filter((id): id is string => id !== undefined);
  return {
    signedIn: account !== undefined,
    ...(plan ? { plan } : {}),
    windows,
    limits: account?.type === "apiKey" ? "none" : windows.length > 0 ? "known" : "unknown",
    ...(listed.length > 0 ? { models } : {}),
  };
}

const CODEX_CLIENT = {
  clientInfo: { name: "xatlas", title: "xatlas", version: "1" },
  capabilities: { experimentalApi: true, requestAttestation: false },
};

/** Codex's own account, limits and models, from `codex app-server`. Nothing is sent to a model. */
export async function probeCodexAccount(): Promise<AgentAccount> {
  const answers: { account?: unknown; rateLimits?: unknown; models?: unknown } = {};
  let pending = 3;
  return talk(
    "codex",
    ["app-server"],
    {},
    (session) => session.send({ id: 0, method: "initialize", params: CODEX_CLIENT }),
    (line, session) => {
      if (line.id === 0) {
        if (line.error) throw new Error("Codex didn't start its app server");
        session.send({ method: "initialized" });
        session.send({ id: 1, method: "account/read", params: {} });
        session.send({
          id: 2,
          method: "account/rateLimits/read",
          params: null,
        });
        session.send({ id: 3, method: "model/list", params: {} });
        return undefined;
      }
      if (line.id !== 1 && line.id !== 2 && line.id !== 3) return undefined;
      // A failed limits or models read leaves that part out; the rest still counts.
      const result = line.error ? undefined : line.result;
      if (line.id === 1) answers.account = result;
      if (line.id === 2) answers.rateLimits = result;
      if (line.id === 3) answers.models = result;
      pending -= 1;
      return pending === 0 ? readCodexAccount(answers) : undefined;
    },
  );
}

/**
 * Codex's ChatGPT sign-in, in the browser instead of a terminal. The app server has to keep
 * running until the browser comes back to it, so it stays up until the sign-in finishes, fails
 * or `timeoutMs` passes.
 */
export async function startCodexSignIn(
  timeoutMs = 10 * 60_000,
): Promise<{ readonly authUrl: string; readonly finished: Promise<boolean> }> {
  let reportUrl!: (url: string) => void;
  let failUrl!: (error: Error) => void;
  const authUrl = new Promise<string>((resolve, reject) => {
    reportUrl = resolve;
    failUrl = reject;
  });
  const finished = talk<boolean>(
    "codex",
    ["app-server"],
    { timeoutMs },
    (session) => session.send({ id: 0, method: "initialize", params: CODEX_CLIENT }),
    (line, session) => {
      if (line.id === 0) {
        session.send({ method: "initialized" });
        session.send({
          id: 1,
          method: "account/login/start",
          params: { type: "chatgpt" },
        });
        return undefined;
      }
      if (line.id === 1) {
        const url = text(record(line.result)?.authUrl);
        if (!url) throw new Error("Codex didn't start a sign-in");
        reportUrl(url);
        return undefined;
      }
      if (line.method === "account/login/completed") {
        return record(line.params)?.success === true;
      }
      return undefined;
    },
  );
  finished.catch((error: unknown) =>
    failUrl(error instanceof Error ? error : new Error(String(error))),
  );
  return { authUrl: await authUrl, finished: finished.catch(() => false) };
}

// ---------------------------------------------------------------- Claude Code

/** Claude's plan as people know it: "Claude Ultra" is Ultra, `max` is Max. */
export function claudePlanName(subscription: string | undefined): string | undefined {
  if (!subscription) return undefined;
  const name = subscription.replace(/^claude\s+/i, "").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
}

function claudeWindow(value: unknown, minutes: number): UsageWindow | undefined {
  const window = record(value);
  const usedPercent = number(window?.utilization);
  if (usedPercent === undefined) return undefined;
  const resetsAt = text(window?.resets_at);
  return { usedPercent, minutes, ...(resetsAt ? { resetsAt } : {}) };
}

/** What Claude Code's `initialize` and `get_usage` control requests answered. */
export function readClaudeAccount(answers: {
  readonly initialize?: unknown;
  readonly usage?: unknown;
}): AgentAccount {
  const initialize = record(answers.initialize);
  const account = record(initialize?.account);
  const usage = record(answers.usage);
  const limits = record(usage?.rate_limits);
  const apiKey =
    text(account?.apiKeySource) !== undefined || text(account?.tokenSource) === "apiKey";
  const plan = apiKey
    ? "API key"
    : claudePlanName(text(account?.subscriptionType) ?? text(usage?.subscription_type));
  const windows =
    usage?.rate_limits_available === true
      ? [claudeWindow(limits?.five_hour, 300), claudeWindow(limits?.seven_day, 10_080)].filter(
          (window): window is UsageWindow => window !== undefined,
        )
      : [];
  const listed = (initialize?.models as unknown[] | undefined) ?? [];
  // `default` is the agent's own default, which the picker always offers anyway.
  const models = listed
    .map((model) => text(record(model)?.value))
    .filter((value): value is string => value !== undefined && value !== "default");
  return {
    signedIn: account !== undefined,
    ...(plan ? { plan } : {}),
    windows,
    limits: apiKey ? "none" : windows.length > 0 ? "known" : "unknown",
    ...(listed.length > 0 ? { models } : {}),
  };
}

/**
 * Claude Code's own account, limits and models, from its stream-json control requests. No
 * prompt is sent, so no model is called, and the run starts in an empty folder with no MCP
 * servers, hooks or saved session.
 */
export async function probeClaudeAccount(): Promise<AgentAccount> {
  const folder = await mkdtemp(join(tmpdir(), "xatlas-claude-"));
  const answers: { initialize?: unknown; usage?: unknown } = {};
  try {
    return await talk(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--settings",
        JSON.stringify({ disableAllHooks: true }),
      ],
      { cwd: folder },
      (session) =>
        session.send({
          type: "control_request",
          request_id: "initialize",
          request: { subtype: "initialize" },
        }),
      (line, session) => {
        if (line.type !== "control_response") return undefined;
        const response = record(line.response);
        const id = response?.request_id;
        const result = response?.subtype === "success" ? response.response : undefined;
        if (id === "initialize") {
          answers.initialize = result;
          session.send({
            type: "control_request",
            request_id: "usage",
            request: { subtype: "get_usage" },
          });
          return undefined;
        }
        if (id === "usage") {
          answers.usage = result;
          session.end();
          return readClaudeAccount(answers);
        }
        return undefined;
      },
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const PROBES: Partial<Record<SwarmAgent, () => Promise<AgentAccount>>> = {
  claude: probeClaudeAccount,
  codex: probeCodexAccount,
};

/** Accounts change slowly, and each check starts the CLI, so answers are reused this long. */
export const ACCOUNT_MAX_AGE_MS = 5 * 60_000;

const accounts = new Map<
  SwarmAgent,
  { readonly at: number; readonly account: Promise<AgentAccount> }
>();

/**
 * An agent's plan, limits and models, where the agent can report them itself; undefined for
 * agents that can't. An answer younger than `maxAgeMs` is reused, and a failed check isn't.
 */
export function readAgentAccount(
  agent: SwarmAgent,
  { maxAgeMs = ACCOUNT_MAX_AGE_MS }: { readonly maxAgeMs?: number } = {},
): Promise<AgentAccount> | undefined {
  const probe = PROBES[agent];
  if (!probe) return undefined;
  const cached = accounts.get(agent);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.account;
  const account = probe().then((answer) => ({
    ...answer,
    checkedAt: new Date().toISOString(),
  }));
  const entry = { at: Date.now(), account };
  accounts.set(agent, entry);
  account.catch(() => {
    if (accounts.get(agent) === entry) accounts.delete(agent);
  });
  return account;
}

/** Drops a reused answer, e.g. after signing in or out. */
export function forgetAgentAccount(agent: SwarmAgent): void {
  accounts.delete(agent);
}

/** Fills in the models of ready agents whose quick check couldn't list them. */
export async function withAccountModels(
  agents: readonly AvailableAgent[],
): Promise<AvailableAgent[]> {
  return Promise.all(
    agents.map(async (agent) => {
      if (!agent.ready || agent.models) return agent;
      const account = await readAgentAccount(agent.agent)?.catch(() => undefined);
      return account?.models ? { ...agent, models: account.models } : agent;
    }),
  );
}
