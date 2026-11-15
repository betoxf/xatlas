import type { Effort, SwarmAgent, UsageWindow } from "@zcode/swarm/types";

/**
 * The words every part of the orchestrator shares. The design is docs/xatlas/orchestrator-wiring.md
 * ("The team, as the parliament decided it"); the rules each module keeps are in
 * docs/xatlas/orchestrator-engines.md. Modules import from here and not from each other.
 */

/** A coding CLI that can do work. */
export type AgentId = SwarmAgent;

export type { Effort };

/** One agent, one of its models, and how hard it should think. */
export interface ModelChoice {
  readonly agent: AgentId;
  /** The agent's own model name; its default when absent. */
  readonly model?: string;
  /** The agent's default when absent. */
  readonly effort?: Effort;
  /** The model's fast mode, where it has one. */
  readonly fast?: boolean;
}

/** A seat at the parliament: a model, how much its vote counts, and whether it only votes. */
export interface ParliamentSeat extends ModelChoice {
  /** How much this seat's vote counts (default 1). */
  readonly weight?: number;
  /** A fresh voter: it proposes and debates nothing, and only ranks the plans. */
  readonly votesOnly?: boolean;
}

/**
 * An outside model that is never given the repository: over HTTP through OpenRouter, or Claude
 * Code run with every tool turned off in an empty folder.
 */
export interface AdvisorChoice {
  readonly via: "openrouter" | "claude";
  /** The provider's own model id, e.g. "google/gemini-4-argon", or Claude Code's, e.g. "opus". */
  readonly model: string;
  readonly effort?: Effort;
}

/**
 * The outside advisors: extra heads asked only when the parliament splits between two plans, at
 * most once each per job. The first two are asked together and the next only while they have not
 * settled it, so with the default panel Gemini is asked only when Opus and Mythos disagree.
 * On by default, as the owner asked: the two Claude Code advisors run on the person's own
 * sign-in, and the OpenRouter one bills their key, and sends the level plans to OpenRouter and
 * Google, only when the first two don't agree (they disagree, or one fails or gives no
 * readable answer).
 */
export interface AdvisorSettings {
  readonly enabled: boolean;
  /** In the order they are asked. */
  readonly choices: readonly AdvisorChoice[];
}

/** The jobs a model can hold in a project. */
export type Role = "triage" | "parliament" | "executor" | "reviewer" | "watcher";

/**
 * Who holds each role. Every parliament seat sits; for the other roles the list is an order
 * of preference and the first one that can run takes the job.
 */
export interface RoleSettings {
  readonly triage: readonly ModelChoice[];
  readonly parliament: readonly ParliamentSeat[];
  readonly executor: readonly ModelChoice[];
  readonly reviewer: readonly ModelChoice[];
  readonly watcher: readonly ModelChoice[];
  readonly advisor: AdvisorSettings;
}

/** The defaults named on 2026-11-15; triage and watcher are fast, cheap models. */
export const DEFAULT_ROLES: RoleSettings = {
  triage: [
    { agent: "claude", model: "haiku" },
    { agent: "codex", model: "gpt-6-luna" },
  ],
  parliament: [
    { agent: "claude", model: "claude-mythos-5-2" },
    { agent: "claude", model: "fable" },
    { agent: "codex", model: "gpt-6-astra" },
    // Last, so the single planner (the first seat that can run) stays Mythos.
    { agent: "claude", model: "opus", effort: "high" },
  ],
  executor: [{ agent: "claude", model: "opus", effort: "high" }],
  reviewer: [
    { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
    { agent: "claude", model: "opus", effort: "high" },
  ],
  watcher: [
    { agent: "claude", model: "haiku" },
    { agent: "codex", model: "gpt-6-luna" },
  ],
  // Opus at high effort, a second Mythos that holds no seat, then Gemini (Google's flagship
  // reasoning model on OpenRouter when this was written; Carbon is newer).
  advisor: {
    enabled: true,
    choices: [
      { via: "claude", model: "opus", effort: "high" },
      { via: "claude", model: "claude-mythos-5-2" },
      { via: "openrouter", model: "google/gemini-4-argon" },
    ],
  },
};

/** A reviewer gets at most this many rounds with an executor before the chair is asked. */
export const MAX_REVIEW_ROUNDS = 3;

/** The chair rules at most this many times in one job; after that the person decides. */
export const MAX_CHAIR_RULINGS = 2;

/**
 * A `note` whose `from` starts with this is the orchestrator's own bookkeeping (a decision that
 * waits on the person, its answer). It is on nobody's board: no digest shows it.
 */
export const RESERVED_NOTE_PREFIX = "xatlas:";

/** The most a step's digest of the board may hold, in words. */
export const MAX_DIGEST_WORDS = 1500;

/** What is known about one connected agent when roles are picked. */
export interface AgentSnapshot {
  readonly agent: AgentId;
  /** Installed and signed in. */
  readonly ready: boolean;
  /** The models it offers; absent when it couldn't list them, and then any model may be asked for. */
  readonly models?: readonly string[];
  /** "known": `windows` is what the agent reported; "none": no limits; "unknown": it couldn't say. */
  readonly limits: "known" | "none" | "unknown";
  readonly windows: readonly UsageWindow[];
  /** ISO time the agent was asked. */
  readonly checkedAt?: string;
}

/** Who got a role and why, or why nobody could take it. */
export type RoleAssignment =
  | { readonly ok: true; readonly choice: ModelChoice; readonly reason: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Where a message goes: answered in the conversation, straight to an executor, or through the
 * orchestrator (parliament, division, executors, reviewer).
 */
export type Route = "chat" | "direct" | "orchestrated";

/** What the person chose in the composer. "auto" lets triage decide. */
export type RoutePreference = "auto" | "direct" | "orchestrated";

/**
 * Who plans an orchestrated job. Size and doubt are two questions: "one" when the way is clear
 * and the job is only big, so one top model writes the plan; "parliament" when there is a real
 * choice between approaches or a mistake would be costly to undo, so the top models discuss it.
 */
export type PlanBy = "one" | "parliament";

/** What triage made of a message: where it goes, and what the person meant. */
export interface TriageDecision {
  readonly route: Route;
  /** One plain sentence, shown to the person. */
  readonly reason: string;
  /** False when the model wasn't sure or its answer couldn't be read. */
  readonly confident: boolean;
  /**
   * The request in the model's own words, one or two sentences. It is shown to the person, so a
   * misreading is caught before any agent is spent.
   */
  readonly understood?: string;
  /**
   * What has to be asked first, when the message can be read in ways that lead to different
   * work. Absent when it is clear. An orchestrated job with questions waits for the person.
   */
  readonly questions?: readonly string[];
  /** For an orchestrated job. Absent or unsure means "one": the lighter way. */
  readonly planBy?: PlanBy;
}

/**
 * One step of a divided plan, before it becomes a task. A big job is always divided, and every
 * step that is ready runs at once with its own executor.
 */
export interface PlanStep {
  /** Short and unique within the plan, e.g. "api" or "settings-ui". */
  readonly key: string;
  readonly title: string;
  /** What to do and how to tell it is done. */
  readonly brief: string;
  /** Keys of the steps that must be merged before this one starts. */
  readonly dependsOn: readonly string[];
  /** The files or folders this step alone may change, so steps running together can't collide. */
  readonly owns: readonly string[];
}

export type TaskState =
  | "idea"
  | "planned"
  | "working"
  | "in_review"
  | "queued"
  | "merged"
  | "deployed"
  | "checked"
  | "cancelled";

/**
 * The moves a task may make. A review or a conflict sends it back to `working`; nothing is
 * cancelled once it is merged.
 */
export const TASK_MOVES: Readonly<Record<TaskState, readonly TaskState[]>> = {
  idea: ["planned", "working", "cancelled"],
  planned: ["working", "cancelled"],
  working: ["in_review", "cancelled"],
  in_review: ["working", "queued", "cancelled"],
  queued: ["working", "merged", "cancelled"],
  merged: ["deployed", "checked"],
  deployed: ["checked"],
  checked: [],
  cancelled: [],
};

/** One piece of work in a project. */
export interface Task {
  readonly id: string;
  /** `workspaceIdentity?.trim() || workspacePath`, as everywhere else in the app. */
  readonly projectKey: string;
  readonly title: string;
  /** What to do and how to tell it is done. */
  readonly brief: string;
  readonly state: TaskState;
  readonly route: Exclude<Route, "chat">;
  /** The task this one was split from. */
  readonly parentId?: string;
  /** Tasks that must be merged before this one starts. */
  readonly dependsOn: readonly string[];
  /** The files or folders this task alone may change. */
  readonly owns: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RunRole = "parliament" | "executor" | "reviewer";

export type RunState = "starting" | "working" | "waiting" | "done" | "failed" | "stopped";

/** The moves a run may make; `done`, `failed` and `stopped` are final. */
export const RUN_MOVES: Readonly<Record<RunState, readonly RunState[]>> = {
  starting: ["working", "failed", "stopped"],
  working: ["waiting", "done", "failed", "stopped"],
  waiting: ["working", "done", "failed", "stopped"],
  done: [],
  failed: [],
  stopped: [],
};

/** One agent working on one task. */
export interface Run {
  readonly id: string;
  readonly taskId: string;
  readonly role: RunRole;
  readonly choice: ModelChoice;
  readonly state: RunState;
  /** The plan the agent is signed in with, e.g. "Ultra", as shown to the person. */
  readonly account?: string;
  /** The conversation the person can open to watch and type. */
  readonly conversationId?: string;
  /** Set for executors: each has its own worktree and branch. */
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
}

/**
 * What xatlas stamps on a run's branch, commits and pull request, so the release queue can
 * tell which agent a change came from.
 */
export interface RunIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly agent: AgentId;
  readonly model?: string;
  readonly account?: string;
  readonly conversationId?: string;
}

/** One thing a reviewer found, pinned to where it was found. */
export interface ReviewFinding {
  /** Unique within the task, so a later round can say it is the same finding. */
  readonly id: string;
  /** "blocker" must be fixed before the step passes; "should-fix" and "note" are the executor's call. */
  readonly severity: "blocker" | "should-fix" | "note";
  /** The lens that found it, e.g. "reuse" or "design"; absent for plain correctness. */
  readonly lens?: string;
  readonly file?: string;
  readonly line?: number;
  readonly text: string;
  /** The id of the earlier finding this one repeats, when the fix did not land. */
  readonly repeats?: string;
}

/** What each kind of ledger entry carries. */
export interface LedgerData {
  "task.created": {
    readonly title: string;
    readonly brief: string;
    readonly route: Task["route"];
    readonly parentId?: string;
    readonly dependsOn?: readonly string[];
    readonly owns?: readonly string[];
  };
  "task.moved": { readonly from: TaskState; readonly to: TaskState; readonly reason?: string };
  /** A direct job that turned out bigger goes to the orchestrator, or the person overrules. */
  "task.rerouted": {
    readonly from: Task["route"];
    readonly to: Task["route"];
    readonly reason: string;
  };
  "run.started": {
    readonly role: RunRole;
    readonly choice: ModelChoice;
    readonly account?: string;
    readonly conversationId?: string;
    readonly worktreePath?: string;
    readonly branch?: string;
  };
  "run.updated": {
    /** Absent when only the details below changed. */
    readonly state?: RunState;
    readonly conversationId?: string;
    readonly worktreePath?: string;
    readonly branch?: string;
    readonly reason?: string;
  };
  "triage.decided": {
    readonly decision: TriageDecision;
    readonly preference: RoutePreference;
    readonly conversationId?: string;
  };
  "parliament.decided": {
    readonly seats: readonly ParliamentSeat[];
    /** The winning plan, in full. */
    readonly plan: string;
    /** The seat that wrote it, e.g. "claude:fable"; absent when nobody won. */
    readonly winner?: string;
    /** Where the saved debate is, for whoever wants to read it. */
    readonly runRef?: string;
    /** The seats whose plans the parliament split between, when it could not decide. */
    readonly tied?: readonly string[];
    /**
     * Every outside advisor asked about the split, in the order asked, with its answer: a
     * `ranking` (seats, best first) or the `error` that kept it from giving one.
     */
    readonly advisors?: ReadonlyArray<{
      readonly choice: AdvisorChoice;
      readonly ranking?: readonly string[];
      readonly reason?: string;
      readonly error?: string;
    }>;
    /**
     * The level plans in the advisors' combined order (seats, best first), when it put one plan
     * alone at the top and so settled the split; without it the choice went to the person.
     */
    readonly advisorOrder?: readonly string[];
  };
  "plan.divided": {
    readonly steps: readonly PlanStep[];
    /** How the divider split the work, or why it couldn't be split. */
    readonly note?: string;
  };
  /**
   * The shared board: a note from the person, the orchestrator or a run (its id). Everyone on
   * the job can read it. `to` names the task it is meant for, and then that task's executor is
   * shown it in its digest; agents never message each other any other way.
   */
  note: { readonly from: string; readonly text: string; readonly to?: string };
  /** A reviewer's verdict on a run's work. `runId` is the run that was reviewed. */
  "review.decided": {
    /** 1 to `MAX_REVIEW_ROUNDS`. */
    readonly round: number;
    /**
     * What the reviewer said. The step passes when no finding is a "blocker", whatever this
     * word is: a "findings" verdict may hold only notes. A "pass" never holds a blocker.
     */
    readonly verdict: "pass" | "findings";
    /** The commit the reviewer read, so every finding is pinned to it. */
    readonly commit: string;
    /** The lenses the review carried besides correctness. */
    readonly lenses: readonly string[];
    readonly findings: readonly ReviewFinding[];
    /** The reviewer's own run. */
    readonly reviewerRunId?: string;
  };
  /** A check the host made in code when a run's turn ended. No model is asked for these. */
  "oversight.flagged": {
    /**
     * "outside-owns": the run changed files its step does not own. "no-commit": the turn ended
     * with nothing committed. "empty-review": a reviewer passed a large diff with no findings.
     */
    readonly check: "outside-owns" | "no-commit" | "empty-review";
    /** "paused": the run is held until someone rules. "flagged": recorded and shown only. */
    readonly action: "paused" | "flagged";
    readonly detail: string;
    /** The paths outside what the step owns. */
    readonly paths?: readonly string[];
  };
  /** The watcher (a fast model, read-only) looked at a run that is stuck. */
  "watcher.advised": {
    /** "waiting": the run waits on someone. "repeated-finding": a finding came back in round two. */
    readonly trigger: "waiting" | "repeated-finding";
    /** "note": it posted a note for the run. "stop" and "reassign" are advice for the chair or the person. */
    readonly advice: "note" | "stop" | "reassign";
    readonly text: string;
    readonly choice: ModelChoice;
  };
  /**
   * The chair ruled: a parliament seat that neither wrote the winning plan nor shares the
   * executor's agent. `taskId` is the job, and `runId` the run the ruling is about, if any.
   */
  "chair.ruled": {
    /**
     * "round-three-failed": the last review round still had blockers. "finding-disputed": the
     * executor says a finding is wrong. "final-read": the one read of every branch against the
     * plan when the job's steps are done, which is how the reviewer is reviewed.
     */
    readonly trigger: "round-three-failed" | "finding-disputed" | "final-read";
    /**
     * "fix": the executor fixes it. "drop": the finding is dropped. "reassign": another executor
     * takes the step. "redivide": the steps not yet started are divided again. "pass": the final
     * read found the work matches the plan. "owner": the person decides.
     */
    readonly ruling: "fix" | "drop" | "reassign" | "redivide" | "pass" | "owner";
    readonly text: string;
    /** The seat that ruled, e.g. "claude:claude-mythos-5-2". */
    readonly chair: string;
    readonly findingId?: string;
  };
}

export type LedgerKind = keyof LedgerData;

/** The ids each kind of entry must carry; any entry may carry the others too. */
interface LedgerRefs {
  "task.created": "taskId";
  "task.moved": "taskId";
  "task.rerouted": "taskId";
  "run.started": "taskId" | "runId";
  "run.updated": "taskId" | "runId";
  "triage.decided": never;
  "parliament.decided": "taskId";
  "plan.divided": "taskId";
  note: never;
  "review.decided": "taskId" | "runId";
  "oversight.flagged": "taskId" | "runId";
  "watcher.advised": "taskId" | "runId";
  "chair.ruled": "taskId";
}

interface Refs {
  readonly taskId: string;
  readonly runId: string;
}

/**
 * One line of a project's ledger. The ledger only grows, and it is the truth: tasks and runs
 * are what replaying it gives.
 */
export type LedgerEntry = {
  [K in LedgerKind]: {
    /** Unique. Writing an `id` that is already there changes nothing. */
    readonly id: string;
    /** 1, 2, 3… within a project, in the order written, with no gaps. */
    readonly seq: number;
    readonly at: string;
    readonly projectKey: string;
    readonly kind: K;
    readonly data: LedgerData[K];
  } & Pick<Refs, LedgerRefs[K]> &
    Partial<Refs>;
}[LedgerKind];

/** An entry before the ledger gives it `seq`, `at` and `projectKey`; `id` is made up when absent. */
export type LedgerDraft = {
  [K in LedgerKind]: {
    readonly id?: string;
    readonly kind: K;
    readonly data: LedgerData[K];
  } & Pick<Refs, LedgerRefs[K]> &
    Partial<Refs>;
}[LedgerKind];
