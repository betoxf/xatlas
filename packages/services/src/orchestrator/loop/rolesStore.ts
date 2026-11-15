import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_ROLES,
  type AdvisorSettings,
  type ModelChoice,
  type ParliamentSeat,
  type RoleSettings,
} from "@zcode/orchestrator/types";

/** Who holds each role, per project, in a small JSON file under the data folder. */
export interface RolesStore {
  get(projectKey: string): Promise<RoleSettings>;
  set(projectKey: string, roles: RoleSettings): Promise<void>;
}

const AGENTS = new Set(["claude", "codex", "opencode", "gemini"]);
const ADVISOR_VIAS = new Set(["openrouter", "claude"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function rolesPath(dataDir: string, projectKey: string): string {
  const hash = createHash("sha256").update(projectKey).digest("hex");
  return join(dataDir, "roles", `${hash}.json`);
}

function choiceProblem(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null) return `${name} is not a model choice`;
  const choice = value as Record<string, unknown>;
  if (typeof choice.agent !== "string" || !AGENTS.has(choice.agent))
    return `${name} names no known agent`;
  if (choice.model !== undefined && (typeof choice.model !== "string" || !choice.model.trim()))
    return `${name} has an empty model`;
  if (choice.effort !== undefined && !EFFORTS.has(choice.effort as string))
    return `${name} has an unknown effort`;
  if (choice.fast !== undefined && typeof choice.fast !== "boolean")
    return `${name} has a fast setting that is not true or false`;
  return undefined;
}

function listProblem(value: unknown, name: string): string | undefined {
  if (!Array.isArray(value)) return `${name} is not a list`;
  for (const [index, item] of value.entries()) {
    const problem = choiceProblem(item, `${name}[${index}]`);
    if (problem) return problem;
  }
  return undefined;
}

/** What is wrong with role settings, in words, or undefined when they can be kept. */
export function rolesProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "the roles are not an object";
  const roles = value as Record<string, unknown>;
  for (const role of ["triage", "parliament", "executor", "reviewer", "watcher"] as const) {
    const problem = listProblem(roles[role], role);
    if (problem) return problem;
  }
  const advisor = roles.advisor as Record<string, unknown> | undefined;
  if (typeof advisor !== "object" || advisor === null) return "advisor is missing";
  if (typeof advisor.enabled !== "boolean") return "advisor.enabled is not true or false";
  if (!Array.isArray(advisor.choices)) return "advisor.choices is not a list";
  for (const [index, value] of advisor.choices.entries()) {
    const choice = value as Record<string, unknown> | null;
    if (
      typeof choice !== "object" ||
      choice === null ||
      !ADVISOR_VIAS.has(choice.via as string) ||
      typeof choice.model !== "string" ||
      !choice.model.trim()
    )
      return `advisor.choices[${index}] is not an OpenRouter or Claude Code model`;
    if (choice.effort !== undefined && !EFFORTS.has(choice.effort as string))
      return `advisor.choices[${index}] has an unknown effort`;
  }
  return undefined;
}

/**
 * Roles saved before the advisors became a panel held one `advisor.choice`; they read as a
 * panel of that one, on or off as saved. Anything else is returned as it is.
 */
function upgraded(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const advisor = (value as { advisor?: unknown }).advisor;
  if (typeof advisor !== "object" || advisor === null) return value;
  const { choice, ...rest } = advisor as { choice?: unknown; choices?: unknown };
  if (rest.choices !== undefined || choice === undefined) return value;
  return { ...value, advisor: { ...rest, choices: [choice] } };
}

function copy(roles: RoleSettings): RoleSettings {
  const choice = (item: ModelChoice): ModelChoice => ({
    agent: item.agent,
    ...(item.model ? { model: item.model } : {}),
    ...(item.effort ? { effort: item.effort } : {}),
    ...(item.fast !== undefined ? { fast: item.fast } : {}),
  });
  const seat = (item: ParliamentSeat): ParliamentSeat => ({
    ...choice(item),
    ...(item.weight !== undefined ? { weight: item.weight } : {}),
    ...(item.votesOnly !== undefined ? { votesOnly: item.votesOnly } : {}),
  });
  const advisor: AdvisorSettings = {
    enabled: roles.advisor.enabled,
    choices: roles.advisor.choices.map((item) => ({
      via: item.via,
      model: item.model,
      ...(item.effort ? { effort: item.effort } : {}),
    })),
  };
  return {
    triage: roles.triage.map(choice),
    parliament: roles.parliament.map(seat),
    executor: roles.executor.map(choice),
    reviewer: roles.reviewer.map(choice),
    watcher: roles.watcher.map(choice),
    advisor,
  };
}

export function createRolesStore(dataDir: string): RolesStore {
  return {
    async get(projectKey) {
      let text: string;
      try {
        text = await readFile(rolesPath(dataDir, projectKey), "utf8");
      } catch {
        return DEFAULT_ROLES;
      }
      try {
        const saved = upgraded((JSON.parse(text) as { roles?: unknown }).roles);
        // A file that no longer reads as roles falls back to the defaults rather than failing every job.
        return rolesProblem(saved) === undefined ? copy(saved as RoleSettings) : DEFAULT_ROLES;
      } catch {
        return DEFAULT_ROLES;
      }
    },

    async set(projectKey, roles) {
      const problem = rolesProblem(roles);
      if (problem) throw new Error(`These roles can't be saved: ${problem}.`);
      const file = rolesPath(dataDir, projectKey);
      await mkdir(dirname(file), { recursive: true });
      // Written whole and renamed into place, so a reader never sees half a file.
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, projectKey, roles: copy(roles) }, null, 2)}\n`,
      );
      await rename(temporary, file);
    },
  };
}
