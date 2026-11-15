import type { AgentAccount, AvailableAgent, UsageWindow } from "@zcode/swarm/types";
import type {
  AgentId,
  AgentSnapshot,
  ModelChoice,
  ParliamentSeat,
  Role,
  RoleAssignment,
  RoleSettings,
} from "../types.js";

/**
 * Who holds each role. Quota is per agent (one sign-in per CLI), so every choice on the same
 * agent shares its windows. Everything here is pure: the snapshots and the time come in.
 */

/** What is known about one agent for `pickRole`, from its quick check and its account. */
export function snapshotOf(agent: AvailableAgent, account?: AgentAccount): AgentSnapshot {
  const models = account?.models?.length ? account.models : agent.models;
  return {
    agent: agent.agent,
    ready: agent.ready,
    ...(models?.length ? { models } : {}),
    limits: account?.limits ?? "unknown",
    windows: account?.windows ?? [],
    ...(account?.checkedAt ? { checkedAt: account.checkedAt } : {}),
  };
}

/**
 * How much room an agent has right now. "known": `left` is what the tightest window leaves
 * (0 to 100) and `exhausted` is true when that window is used up; "none": no limits;
 * "unknown": the agent couldn't say, which is never read as room.
 */
export type AgentRoom =
  | { readonly kind: "none" }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "known";
      readonly left: number;
      readonly exhausted: boolean;
      /** The window that decides; absent when the agent reported none. */
      readonly tightest?: UsageWindow;
    };

/** When a window starts over; never for a missing or unreadable time. */
function resetTime(window: UsageWindow | undefined): number {
  const resetsAt = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(resetsAt) ? resetsAt : Number.POSITIVE_INFINITY;
}

/** A window whose reset time has passed has started over. */
function hasReset(window: UsageWindow, now: Date): boolean {
  return now.getTime() > resetTime(window);
}

export function agentRoom(snapshot: AgentSnapshot, now: Date): AgentRoom {
  if (snapshot.limits === "none") return { kind: "none" };
  if (snapshot.limits !== "known") return { kind: "unknown" };
  let tightest: UsageWindow | undefined;
  let used = 0;
  for (const window of snapshot.windows) {
    if (!Number.isFinite(window.usedPercent)) continue;
    const windowUsed = hasReset(window, now) ? 0 : window.usedPercent;
    // Between two used-up windows, the one free last decides when the agent is free again.
    const freeLater =
      windowUsed >= 100 && windowUsed === used && resetTime(window) > resetTime(tightest);
    if (!tightest || windowUsed > used || freeLater) {
      tightest = window;
      used = windowUsed;
    }
  }
  return {
    kind: "known",
    left: Math.max(0, Math.min(100, 100 - used)),
    exhausted: used >= 100,
    ...(tightest ? { tightest } : {}),
  };
}

const AGENT_NAMES: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
};

function agentName(agent: AgentId): string {
  return AGENT_NAMES[agent] ?? agent;
}

function label(choice: ModelChoice): string {
  return `${agentName(choice.agent)} ${choice.model ?? "with its default model"}`;
}

function windowName(window: UsageWindow | undefined): string {
  if (window?.minutes === 300) return "five-hour limit";
  if (window?.minutes === 1_440) return "daily limit";
  if (window?.minutes === 10_080) return "weekly limit";
  if (window?.minutes) return `${window.minutes}-minute limit`;
  return "usage limit";
}

type Check =
  | { readonly ok: true; readonly room: AgentRoom }
  | { readonly ok: false; readonly why: string };

/** Whether a choice can run now; `why` is a clause that names the agent. */
function check(choice: ModelChoice, agents: readonly AgentSnapshot[], now: Date): Check {
  const name = agentName(choice.agent);
  const snapshot = agents.find((candidate) => candidate.agent === choice.agent);
  if (!snapshot) return { ok: false, why: `${name} is not connected` };
  if (!snapshot.ready) return { ok: false, why: `${name} is not installed or not signed in` };
  // An agent that lists no models takes any, and a choice with no model asks for the default.
  if (choice.model && snapshot.models?.length && !snapshot.models.includes(choice.model)) {
    return { ok: false, why: `${name} does not offer ${choice.model}` };
  }
  const room = agentRoom(snapshot, now);
  if (room.kind === "known" && room.exhausted) {
    const until = Number.isFinite(resetTime(room.tightest))
      ? `until ${room.tightest!.resetsAt}`
      : "and gave no time it resets";
    return { ok: false, why: `${name} has used all of its ${windowName(room.tightest)} ${until}` };
  }
  return { ok: true, room };
}

function roomPhrase(room: AgentRoom): string {
  if (room.kind === "none") return "no usage limits";
  if (room.kind === "unknown") return "its limits are unknown";
  if (!room.tightest) return "no limits reported as used";
  return `${Math.floor(room.left)}% of its ${windowName(room.tightest)} left`;
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The first choice for a role that can run. Choices whose agent isn't ready, lacks the model,
 * or has used up a window are skipped. The rest are ordered by: another agent than `avoid`
 * first, even one with unknown limits, because an independent review is the point of a review;
 * then known room or no limits before unknown limits; then the order in the settings. Without
 * `avoid`, unknown limits never beat known room.
 */
export function pickRole(
  role: Exclude<Role, "parliament">,
  settings: RoleSettings,
  agents: readonly AgentSnapshot[],
  options: { now: Date; avoid?: AgentId },
): RoleAssignment {
  const choices = settings[role];
  if (choices.length === 0) return { ok: false, reason: `No model is set for the ${role} role.` };

  const checks = choices.map((choice) => check(choice, agents, options.now));
  const avoided = (index: number) =>
    options.avoid !== undefined && choices[index]!.agent === options.avoid;
  const rank = (index: number): number => {
    const result = checks[index]!;
    if (!result.ok) return Number.POSITIVE_INFINITY;
    return (avoided(index) ? 2 : 0) + (result.room.kind === "unknown" ? 1 : 0);
  };
  const order = choices.map((_, index) => index).sort((a, b) => rank(a) - rank(b) || a - b);
  const best = order[0]!;
  const picked = checks[best]!;

  if (!picked.ok) {
    const whys = [...new Set(checks.map((result) => (result.ok ? "" : result.why)))];
    return { ok: false, reason: `Nobody can take the ${role} role: ${whys.join("; ")}.` };
  }

  const choice = choices[best]!;
  const sameAgent = avoided(best);
  // The other agents' reasons, when the role falls back to the agent that wrote the change.
  const others = sameAgent
    ? [
        ...new Set(
          checks.flatMap((result, index) => (result.ok || avoided(index) ? [] : [result.why])),
        ),
      ]
    : [];
  // Another agent with unknown limits beat the author's agent: an independent review comes first.
  const independent =
    !sameAgent &&
    picked.room.kind === "unknown" &&
    checks.some((result, index) => result.ok && avoided(index));
  const passed = checks.slice(0, best).flatMap((result, index) => {
    if (sameAgent && !avoided(index)) return [];
    if (independent && avoided(index)) return [];
    const why = !result.ok
      ? result.why
      : avoided(index) && !sameAgent
        ? `${agentName(choices[index]!.agent)} wrote the change`
        : `${agentName(choices[index]!.agent)}'s limits are unknown`;
    return [`${label(choices[index]!)} was passed over because ${why}`];
  });
  const parts = [
    independent
      ? `${label(choice)} takes the ${role} role although its limits are unknown, because the change was written by ${agentName(options.avoid!)}`
      : `${label(choice)} takes the ${role} role (${roomPhrase(picked.room)})`,
    sameAgent
      ? `, although ${agentName(choice.agent)} wrote the change, because no other agent can${others.length > 0 ? `: ${others.join("; ")}` : ""}`
      : "",
    ...passed.map((text) => `; ${text}`),
  ];
  return { ok: true, choice, reason: sentence(parts.join("")) };
}

/**
 * Seats every parliament member that can run under the rules of `pickRole`; unknown limits
 * still sit. Two members that propose (not `votesOnly`) are the minimum.
 */
export function pickParliament(
  settings: RoleSettings,
  agents: readonly AgentSnapshot[],
  options: { now: Date },
): {
  seats: readonly ParliamentSeat[];
  skipped: ReadonlyArray<{ seat: ParliamentSeat; reason: string }>;
  enough: boolean;
} {
  const seats: ParliamentSeat[] = [];
  const skipped: Array<{ seat: ParliamentSeat; reason: string }> = [];
  for (const seat of settings.parliament) {
    const result = check(seat, agents, options.now);
    if (result.ok) seats.push(seat);
    else
      skipped.push({ seat, reason: sentence(`${label(seat)} cannot sit because ${result.why}`) });
  }
  return { seats, skipped, enough: seats.filter((seat) => !seat.votesOnly).length >= 2 };
}
