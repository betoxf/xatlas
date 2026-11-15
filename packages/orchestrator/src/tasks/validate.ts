import { combineAdvice } from "@zcode/swarm/vote";
import {
  MAX_REVIEW_ROUNDS,
  type AdvisorChoice,
  type AgentId,
  type Effort,
  type LedgerData,
  type LedgerKind,
  type PlanBy,
  type ReviewFinding,
  type Route,
  type RoutePreference,
  type RunRole,
  type RunState,
  type TaskState,
} from "../types.js";

/**
 * The one shape check for ledger entries. The reader runs it on every finished line and the
 * writer on every entry before it is written, so nothing can be written that wouldn't read
 * back. Each function returns what is wrong in a few words, or `undefined` when all is well.
 */

/** Ids are written on one line of JSON and compared as text, so they stay short and on one line. */
// Deliberately enforced on read too: no ledger predates this rule, and the writer refuses the same ids.
const MAX_ID_LENGTH = 256;

// Records rather than lists, so the compiler says when a contract gains a value.
const KINDS: Record<LedgerKind, true> = {
  "task.created": true,
  "task.moved": true,
  "task.rerouted": true,
  "run.started": true,
  "run.updated": true,
  "triage.decided": true,
  "parliament.decided": true,
  "plan.divided": true,
  note: true,
  "review.decided": true,
  "oversight.flagged": true,
  "watcher.advised": true,
  "chair.ruled": true,
};
const TASK_STATES: Record<TaskState, true> = {
  idea: true,
  planned: true,
  working: true,
  in_review: true,
  queued: true,
  merged: true,
  deployed: true,
  checked: true,
  cancelled: true,
};
const RUN_STATES: Record<RunState, true> = {
  starting: true,
  working: true,
  waiting: true,
  done: true,
  failed: true,
  stopped: true,
};
const ROUTES: Record<Route, true> = { chat: true, direct: true, orchestrated: true };
const PLAN_BY: Record<PlanBy, true> = { one: true, parliament: true };
const TASK_ROUTES: Record<Exclude<Route, "chat">, true> = { direct: true, orchestrated: true };
const PREFERENCES: Record<RoutePreference, true> = { auto: true, direct: true, orchestrated: true };
const RUN_ROLES: Record<RunRole, true> = { parliament: true, executor: true, reviewer: true };
const AGENTS: Record<AgentId, true> = { claude: true, codex: true, opencode: true, gemini: true };
const VERDICTS: Record<LedgerData["review.decided"]["verdict"], true> = {
  pass: true,
  findings: true,
};
const SEVERITIES: Record<ReviewFinding["severity"], true> = {
  blocker: true,
  "should-fix": true,
  note: true,
};
const CHECKS: Record<LedgerData["oversight.flagged"]["check"], true> = {
  "outside-owns": true,
  "no-commit": true,
  "empty-review": true,
};
const CHECK_ACTIONS: Record<LedgerData["oversight.flagged"]["action"], true> = {
  paused: true,
  flagged: true,
};
const WATCHER_TRIGGERS: Record<LedgerData["watcher.advised"]["trigger"], true> = {
  waiting: true,
  "repeated-finding": true,
};
const WATCHER_ADVICE: Record<LedgerData["watcher.advised"]["advice"], true> = {
  note: true,
  stop: true,
  reassign: true,
};
const CHAIR_TRIGGERS: Record<LedgerData["chair.ruled"]["trigger"], true> = {
  "round-three-failed": true,
  "finding-disputed": true,
  "final-read": true,
};
const CHAIR_RULINGS: Record<LedgerData["chair.ruled"]["ruling"], true> = {
  fix: true,
  drop: true,
  reassign: true,
  redivide: true,
  pass: true,
  owner: true,
};
const ADVISOR_VIA: Record<AdvisorChoice["via"], true> = { openrouter: true, claude: true };
const EFFORTS: Record<Effort, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/** Which ids each kind must carry, as in the contract's `LedgerRefs`. */
const REFS: Record<LedgerKind, readonly ("taskId" | "runId")[]> = {
  "task.created": ["taskId"],
  "task.moved": ["taskId"],
  "task.rerouted": ["taskId"],
  "run.started": ["taskId", "runId"],
  "run.updated": ["taskId", "runId"],
  "triage.decided": [],
  "parliament.decided": ["taskId"],
  "plan.divided": ["taskId"],
  note: [],
  "review.decided": ["taskId", "runId"],
  "oversight.flagged": ["taskId", "runId"],
  "watcher.advised": ["taskId", "runId"],
  "chair.ruled": ["taskId"],
};

type Fields = Record<string, unknown>;
type Problem = string | undefined;

export function idProblem(value: unknown, name = "id"): Problem {
  if (typeof value !== "string" || value === "") return `${name} is not non-empty text`;
  if (value.length > MAX_ID_LENGTH) return `${name} is longer than ${MAX_ID_LENGTH} characters`;
  if (/[\r\n]/.test(value)) return `${name} has a line break`;
  return undefined;
}

export function projectKeyProblem(value: unknown): Problem {
  return typeof value === "string" && value !== "" ? undefined : "projectKey is not non-empty text";
}

/** Checks a whole entry: its stamps, the ids its kind needs, and every field of its data. */
export function entryProblem(value: unknown): Problem {
  if (!isFields(value)) return "not an object";
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind))
    return `unknown kind ${String(kind)}`;
  const known = kind as LedgerKind;
  return (
    idProblem(value.id) ??
    (Number.isInteger(value.seq) && (value.seq as number) > 0
      ? undefined
      : "seq is not 1 or more") ??
    (typeof value.at === "string" && value.at !== "" ? undefined : "no time") ??
    projectKeyProblem(value.projectKey) ??
    refsProblem(value, known) ??
    (isFields(value.data) ? dataProblem(known, value.data) : "data is not an object")
  );
}

function refsProblem(entry: Fields, kind: LedgerKind): Problem {
  for (const ref of ["taskId", "runId"] as const) {
    const required = REFS[kind].includes(ref);
    if (!required && entry[ref] === undefined) continue;
    const problem = idProblem(entry[ref], ref);
    if (problem) return problem;
  }
  return undefined;
}

function dataProblem(kind: LedgerKind, data: Fields): Problem {
  switch (kind) {
    case "task.created":
      return (
        text(data, "title") ??
        text(data, "brief") ??
        oneOf(data, "route", TASK_ROUTES) ??
        optional(data, "parentId", (value) => idProblem(value, "parentId")) ??
        optional(data, "dependsOn", (value) => textList(value, "dependsOn")) ??
        optional(data, "owns", (value) => textList(value, "owns"))
      );
    case "task.moved":
      return (
        oneOf(data, "from", TASK_STATES) ??
        oneOf(data, "to", TASK_STATES) ??
        optionalText(data, "reason")
      );
    case "task.rerouted":
      return (
        oneOf(data, "from", TASK_ROUTES) ?? oneOf(data, "to", TASK_ROUTES) ?? text(data, "reason")
      );
    case "run.started":
      return (
        oneOf(data, "role", RUN_ROLES) ??
        choiceProblem(data.choice, "choice") ??
        optionalText(data, "account") ??
        runDetailsProblem(data)
      );
    case "run.updated":
      return (
        optional(data, "state", (value) => member(value, "state", RUN_STATES)) ??
        runDetailsProblem(data) ??
        optionalText(data, "reason")
      );
    case "triage.decided": {
      const decision = data.decision;
      if (!isFields(decision)) return "decision is not an object";
      return (
        oneOf(decision, "route", ROUTES) ??
        text(decision, "reason") ??
        (typeof decision.confident === "boolean" ? undefined : "confident is not true or false") ??
        optionalText(decision, "understood") ??
        optional(decision, "questions", (value) => textList(value, "questions")) ??
        optional(decision, "planBy", (value) => member(value, "planBy", PLAN_BY)) ??
        oneOf(data, "preference", PREFERENCES) ??
        optionalText(data, "conversationId")
      );
    }
    case "parliament.decided":
      return (
        list(data.seats, "seats", (seat, name) => seatProblem(seat, name)) ??
        text(data, "plan") ??
        optionalText(data, "winner") ??
        optionalText(data, "runRef") ??
        optional(data, "tied", (value) => textList(value, "tied")) ??
        optional(data, "advisors", (value) =>
          list(value, "advisors", (advisor, name) => {
            if (!isFields(advisor)) return `${name} is not an object`;
            return (
              advisorChoiceProblem(advisor.choice, `${name}.choice`) ??
              optional(advisor, "ranking", (ranking) => textList(ranking, `${name}.ranking`)) ??
              optionalText(advisor, "reason") ??
              optionalText(advisor, "error")
            );
          }),
        ) ??
        optional(data, "advisorOrder", (value) => textList(value, "advisorOrder")) ??
        advisorOrderProblem(data)
      );
    case "plan.divided":
      return list(data.steps, "steps", (step, name) => {
        if (!isFields(step)) return `${name} is not an object`;
        return (
          text(step, "key") ??
          text(step, "title") ??
          text(step, "brief") ??
          textList(step.dependsOn, `${name}.dependsOn`) ??
          textList(step.owns, `${name}.owns`)
        );
      });
    case "note":
      return (
        text(data, "from") ??
        text(data, "text") ??
        optional(data, "to", (value) => idProblem(value, "to"))
      );
    case "review.decided":
      return (
        (Number.isInteger(data.round) &&
        (data.round as number) >= 1 &&
        (data.round as number) <= MAX_REVIEW_ROUNDS
          ? undefined
          : `round is not 1 to ${MAX_REVIEW_ROUNDS}`) ??
        oneOf(data, "verdict", VERDICTS) ??
        text(data, "commit") ??
        textList(data.lenses, "lenses") ??
        list(data.findings, "findings", findingProblem) ??
        verdictProblem(data.verdict as string, data.findings as readonly Fields[]) ??
        optional(data, "reviewerRunId", (value) => idProblem(value, "reviewerRunId"))
      );
    case "oversight.flagged":
      return (
        oneOf(data, "check", CHECKS) ??
        oneOf(data, "action", CHECK_ACTIONS) ??
        text(data, "detail") ??
        optional(data, "paths", (value) => textList(value, "paths"))
      );
    case "watcher.advised":
      return (
        oneOf(data, "trigger", WATCHER_TRIGGERS) ??
        oneOf(data, "advice", WATCHER_ADVICE) ??
        text(data, "text") ??
        choiceProblem(data.choice, "choice")
      );
    case "chair.ruled":
      return (
        oneOf(data, "trigger", CHAIR_TRIGGERS) ??
        oneOf(data, "ruling", CHAIR_RULINGS) ??
        text(data, "text") ??
        text(data, "chair") ??
        optional(data, "findingId", (value) => idProblem(value, "findingId"))
      );
  }
}

/** A verdict must agree with its findings: "pass" holds no blocker, and "findings" holds at least one. */
function verdictProblem(verdict: string, findings: readonly Fields[]): Problem {
  if (verdict === "pass" && findings.some((finding) => finding.severity === "blocker")) {
    return "verdict is pass but a finding is a blocker";
  }
  if (verdict === "findings" && findings.length === 0)
    return "verdict is findings but none is listed";
  return undefined;
}

/**
 * An `advisorOrder` says the advisors chose. It must be the order their recorded rankings give
 * over the level plans, and its first seat must be the winner: a row can't claim a choice the
 * advisors did not make.
 */
function advisorOrderProblem(data: Fields): Problem {
  const order = data.advisorOrder as readonly string[] | undefined;
  if (order === undefined) return undefined;
  const tied = (data.tied as readonly string[] | undefined) ?? [];
  if (tied.length < 2) return "advisorOrder without a level vote";
  const rankings = ((data.advisors as readonly Fields[] | undefined) ?? [])
    .map((advisor) => advisor.ranking as readonly string[] | undefined)
    .filter((ranking): ranking is readonly string[] => ranking !== undefined);
  const chosen = combineAdvice(rankings, tied);
  if (!chosen) return "advisorOrder, but the advisors' rankings leave the top level";
  if (chosen.length !== order.length || chosen.some((seat, index) => seat !== order[index])) {
    return "advisorOrder is not the order the advisors' rankings give";
  }
  return data.winner === order[0] ? undefined : "winner is not the advisors' first choice";
}

function findingProblem(value: unknown, name: string): Problem {
  if (!isFields(value)) return `${name} is not an object`;
  return (
    idProblem(value.id, `${name}.id`) ??
    member(value.severity, `${name}.severity`, SEVERITIES) ??
    optionalText(value, "lens") ??
    optionalText(value, "file") ??
    optional(value, "line", (line) =>
      Number.isInteger(line) && (line as number) > 0 ? undefined : `${name}.line is not 1 or more`,
    ) ??
    text(value, "text") ??
    optional(value, "repeats", (repeats) => idProblem(repeats, `${name}.repeats`))
  );
}

function advisorChoiceProblem(value: unknown, name: string): Problem {
  if (!isFields(value)) return `${name} is not an object`;
  return (
    member(value.via, `${name}.via`, ADVISOR_VIA) ??
    text(value, "model") ??
    optional(value, "effort", (effort) => member(effort, `${name}.effort`, EFFORTS))
  );
}

function runDetailsProblem(data: Fields): Problem {
  return (
    optionalText(data, "conversationId") ??
    optionalText(data, "worktreePath") ??
    optionalText(data, "branch")
  );
}

function choiceProblem(value: unknown, name: string): Problem {
  if (!isFields(value)) return `${name} is not an object`;
  return (
    member(value.agent, `${name}.agent`, AGENTS) ??
    optionalText(value, "model") ??
    optional(value, "effort", (effort) => member(effort, `${name}.effort`, EFFORTS)) ??
    optional(value, "fast", (fast) =>
      typeof fast === "boolean" ? undefined : `${name}.fast is not true or false`,
    )
  );
}

function seatProblem(value: unknown, name: string): Problem {
  return (
    choiceProblem(value, name) ??
    optional(value as Fields, "weight", (weight) =>
      typeof weight === "number" && Number.isFinite(weight)
        ? undefined
        : `${name}.weight is not a number`,
    ) ??
    optional(value as Fields, "votesOnly", (only) =>
      typeof only === "boolean" ? undefined : `${name}.votesOnly is not true or false`,
    )
  );
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(fields: Fields, key: string): Problem {
  return typeof fields[key] === "string" ? undefined : `${key} is not text`;
}

function optionalText(fields: Fields, key: string): Problem {
  return optional(fields, key, () => text(fields, key));
}

/** A field that may be absent; JSON drops `undefined`, so absent and `undefined` are the same. */
function optional(fields: Fields, key: string, check: (value: unknown) => Problem): Problem {
  return fields[key] === undefined ? undefined : check(fields[key]);
}

function oneOf(fields: Fields, key: string, allowed: Record<string, true>): Problem {
  return member(fields[key], key, allowed);
}

function member(value: unknown, name: string, allowed: Record<string, true>): Problem {
  return typeof value === "string" && Object.hasOwn(allowed, value)
    ? undefined
    : `${name} is not one of ${Object.keys(allowed).join(", ")}`;
}

function textList(value: unknown, name: string): Problem {
  return list(value, name, (item, itemName) =>
    typeof item === "string" ? undefined : `${itemName} is not text`,
  );
}

function list(
  value: unknown,
  name: string,
  check: (item: unknown, name: string) => Problem,
): Problem {
  if (!Array.isArray(value)) return `${name} is not a list`;
  for (const [index, item] of value.entries()) {
    const problem = check(item, `${name}[${index}]`);
    if (problem) return problem;
  }
  return undefined;
}
