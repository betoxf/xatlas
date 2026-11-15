/** The coding CLIs a swarm member can run in. */
export type SwarmAgent = "claude" | "codex" | "opencode" | "gemini";

export interface AvailableAgent {
  readonly agent: SwarmAgent;
  readonly installed: boolean;
  readonly ready: boolean;
  readonly detail: string;
  /**
   * Models to offer; the agent's default is always available too. Absent when the quick check
   * can't tell, as with Claude Code and Codex, whose models come with their account.
   */
  readonly models?: readonly string[];
}

/** One usage limit, as the agent reports it. */
export interface UsageWindow {
  /** 0 to 100. */
  readonly usedPercent: number;
  /** The window's length: 300 is the five-hour window, 10080 the weekly one. */
  readonly minutes?: number;
  /** ISO time when the window starts over. */
  readonly resetsAt?: string;
}

/** What an agent says about the account it's signed in with. */
export interface AgentAccount {
  readonly signedIn: boolean;
  /** The plan as people know it, e.g. "Max", "Pro Lite", or "API key". */
  readonly plan?: string;
  /** Empty when the plan has no limits to show, as with an API key. */
  readonly windows: readonly UsageWindow[];
  /**
   * Whether `windows` can be trusted: "known" when the agent reported its limits, "none" when
   * the plan has none (an API key), "unknown" when it couldn't say. Absent means unknown.
   */
  readonly limits?: "known" | "none" | "unknown";
  /** The models it offers right now; absent when it couldn't list them. */
  readonly models?: readonly string[];
  /** ISO time the agent was asked. */
  readonly checkedAt?: string;
}

/** How hard a model should think. Each CLI takes the levels it knows. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface SwarmMember {
  /** Unique within a swarm, e.g. "claude:opus". */
  readonly id: string;
  readonly agent: SwarmAgent;
  /** The agent's own model name; its default when absent. */
  readonly model?: string;
  /** The agent's default when absent. */
  readonly effort?: Effort;
  /** The model's fast mode, where it has one. */
  readonly fast?: boolean;
  /** How much this member's vote counts (default 1). */
  readonly weight?: number;
  /** A fresh voter: it proposes and debates nothing, and only ranks the plans (in a deliberation, it only amends the plan). */
  readonly votesOnly?: boolean;
}

export type SwarmPhase = "propose" | "debate" | "vote";

/** How the swarm reaches a plan: a contest of whole plans (`runSwarm`), or a discussion that agrees on one plan and never votes (`runDeliberation`). */
export type SwarmMode = "contest" | "deliberate";

/**
 * Which step of a deliberation an event belongs to; contest events have none. Each maps onto
 * a phase: the opening, writing, the revision and a split's positions are "propose"; the
 * discussion rounds, the amendments and the recheck are "debate" (a deliberation has no vote).
 */
export type SwarmStep = "opening" | "discuss" | "write" | "amend" | "revise" | "recheck" | "position";

/** A per-member option that not every CLI can take. */
export type SwarmMemberOption = "effort" | "fast";

/** Asks one member something and returns its final answer. */
export type AskMember = (
  member: SwarmMember,
  prompt: string,
  options: { readonly cwd: string; readonly signal?: AbortSignal },
) => Promise<string>;

export interface SwarmOptions {
  readonly task: string;
  /** The project the members can read while planning. */
  readonly cwd: string;
  readonly members: readonly SwarmMember[];
  /** Rounds where members read each other's plans and revise their own (default 1). */
  readonly rounds?: number;
  readonly signal?: AbortSignal;
  /**
   * Outside models asked, in this order, only when the members' vote ends level at the top (or a
   * deliberation splits between two positions): the first two together, then one more at a time
   * until they settle it (see `askAdvisors`).
   */
  readonly advisors?: readonly SwarmAdvisor[];
}

/**
 * An outside model that breaks a level vote or a deliberation's split. It is sent the task, the
 * level plans and the members' ballots (or what they said about the two positions) as text, and
 * nothing else: no repository and no tools.
 */
export interface SwarmAdvisor {
  /** Shown in the report, e.g. "openrouter:google/gemini-4-argon" or "claude:opus+high". */
  readonly id: string;
  readonly ask: (prompt: string, options: { readonly signal?: AbortSignal }) => Promise<string>;
}

/** What one advisor answered about a level vote: a `ranking` of the level plans, or the `error` that kept it from giving one. */
export interface SwarmAdvice {
  readonly id: string;
  readonly ranking?: readonly string[];
  readonly reason?: string;
  readonly error?: string;
}

export type SwarmEvent =
  | { readonly type: "phase"; readonly phase: SwarmPhase; readonly round: number; readonly step?: SwarmStep }
  | {
      readonly type: "message";
      readonly phase: SwarmPhase;
      readonly round: number;
      readonly memberId: string;
      /** The member's plan letter in a contest ("A", "B", …), or its letter in a deliberation; a contest's fresh voter has none. */
      readonly letter?: string;
      readonly text: string;
      readonly step?: SwarmStep;
    }
  | { readonly type: "dropped"; readonly phase: SwarmPhase; readonly memberId: string; readonly error: string }
  /** Sent once per member and option, before the run starts, when the member's CLI has no way to take it. */
  | { readonly type: "unsupported"; readonly memberId: string; readonly option: SwarmMemberOption; readonly detail: string }
  /** The vote ended level (or a deliberation split) between `tied` and one advisor (`memberId`) was asked; one event per advisor asked. It gave a `ranking`, or an `error`. */
  | { readonly type: "advisor"; readonly memberId: string; readonly tied: readonly string[]; readonly ranking?: readonly string[]; readonly reason?: string; readonly error?: string };

export interface SwarmBallot {
  readonly voterId: string;
  /** Plan letters, best first; never the voter's own. */
  readonly ranking: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
  /** The voter's weight; absent means 1. */
  readonly weight?: number;
}

export interface SwarmScore {
  readonly letter: string;
  readonly memberId: string;
  /** Borda count: each voter gives its first choice (plans ranked − 1) points, its last 1. */
  readonly points: number;
  readonly firstPlaces: number;
  /**
   * First places, each counted with its voter's weight; breaks ties on points. `points` is
   * scaled by weight too, and a fresh voter ranks every plan (see `tallyBallots`).
   */
  readonly weightedFirstPlaces?: number;
}

export interface SwarmResult {
  readonly task: string;
  /** Final plan of each member still in the swarm, by letter. */
  readonly plans: ReadonlyArray<{ readonly letter: string; readonly memberId: string; readonly plan: string }>;
  /** Every critique, round by round. */
  readonly debate: ReadonlyArray<{ readonly round: number; readonly memberId: string; readonly critique: string }>;
  readonly ballots: readonly SwarmBallot[];
  /** Best first. */
  readonly scores: readonly SwarmScore[];
  readonly winner?: SwarmScore;
  readonly dropped: ReadonlyArray<{ readonly memberId: string; readonly phase: SwarmPhase; readonly error: string }>;
  /** The members as they were given, fresh voters included. */
  readonly members?: readonly SwarmMember[];
  /** Options a member asked for that its CLI can't take. */
  readonly unsupported?: ReadonlyArray<{ readonly memberId: string; readonly option: SwarmMemberOption; readonly detail: string }>;
  /**
   * The plans level on points at the top of the members' vote, when it could not decide; in a
   * deliberation, the two positions it split between. Unless the advisors chose
   * (`advisorOrder`), the choice belongs to a person: in a contest `winner` is then first only
   * by first places and letter, and a deliberation's split has no `winner`.
   */
  readonly tied?: readonly string[];
  /** Each advisor asked about the level vote or the split, in the order given, with its answer; absent when none was asked. */
  readonly advisors?: readonly SwarmAdvice[];
  /**
   * The level plans in the advisors' combined order, best first, when it puts one plan alone at
   * the top (`combineAdvice`: first choices, then Borda); absent when they left it level.
   */
  readonly advisorOrder?: readonly string[];
  /** The advisors given but not asked, because the ones before them had already chosen. */
  readonly advisorsNotNeeded?: readonly string[];
  /** Why the advisors were not asked about a deliberation's split, when they were given; the choice is then the person's. */
  readonly advisorsSkipped?: string;
  /** What a deliberation (`runDeliberation`) produced; absent for a contest. */
  readonly deliberation?: SwarmDeliberation;
}

/** One approach in a deliberation's pool. Prompts show it by label and its proposer's letter, never by name. */
export interface SwarmApproach {
  /** "1", "2", … in the order they joined the pool. */
  readonly label: string;
  /** Who proposed it. */
  readonly memberId: string;
  readonly name: string;
  readonly idea: string;
  readonly tradeoff: string;
  /** For a merged approach, the discussion round it was offered in. */
  readonly round?: number;
}

/** Something a member found, and where. The engine shows the source as text and never opens it. */
export interface SwarmFinding {
  readonly fact: string;
  /** A file path in the project or a URL, as the member wrote it; may be empty. */
  readonly source: string;
}

/**
 * A deliberation, step by step: a discussion that never votes. When the plan stood, `plans`
 * holds it under its writer's letter and `winner` is a score whose points are the weight with
 * no block left (the writer's included) and whose first places count those members. When it
 * split, `plans` holds the two positions under their writers' letters, `tied` names both, and
 * there is a `winner` only when the advisors chose. `ballots` is always empty.
 */
export interface SwarmDeliberation {
  /** Each member's letter, kept for the whole run: the proposers first, then the fresh readers. */
  readonly voices: ReadonlyArray<{ readonly memberId: string; readonly letter: string }>;
  readonly approaches: readonly SwarmApproach[];
  /**
   * What each member said. Round 0 is its opening, where `stand` is its pick among its own
   * approaches; later rounds are the discussion. A turn with nothing but its round and member
   * could not be read.
   */
  readonly turns: ReadonlyArray<{
    readonly round: number;
    readonly memberId: string;
    /** The approach it backs. */
    readonly stand?: string;
    readonly why?: string;
    readonly findings?: readonly SwarmFinding[];
    readonly questions?: readonly string[];
    /** What it said to each other member, by letter. */
    readonly replies?: ReadonlyArray<{ readonly to: string; readonly point: string }>;
    /** The label of the merged approach it offered. */
    readonly merged?: string;
    /** Ideas beyond the request, kept apart for the person. */
    readonly beyond?: string;
  }>;
  /** The approach more than half of the proposers' weight backed after the last round. */
  readonly majority?: string;
  /** Who wrote the plan for the majority approach. */
  readonly writer?: string;
  /** Each answer to that plan; the writer is not listed. `read: false`: it said nothing readable, so no block. */
  readonly amendments: ReadonlyArray<{
    readonly memberId: string;
    readonly read: boolean;
    readonly onRequest?: boolean;
    readonly drift?: string;
    readonly amendments?: readonly string[];
    readonly block?: string;
  }>;
  /** Present when the writer revised the plan once; `answers` is what it said to each letter. */
  readonly revision?: { readonly answers: string };
  /** Each member that blocked, asked once after the revision. `read: false`: its block stands. */
  readonly rechecks: ReadonlyArray<{
    readonly memberId: string;
    readonly read: boolean;
    readonly stillBlocks: boolean;
    readonly block?: string;
  }>;
  /** The blocks left at the end. When the plan stands anyway, this is the dissent it carries. */
  readonly dissent: ReadonlyArray<{ readonly memberId: string; readonly block: string }>;
  /** Whether the plan stood: a majority approach, and more than half of the weight with no block left. */
  readonly agreed: boolean;
  /**
   * Why it split: no approach had a majority, no backer of the majority wrote a plan, or the
   * plan still had too much blocking after the revision.
   */
  readonly split?: "no-majority" | "no-plan" | "blocked";
}
