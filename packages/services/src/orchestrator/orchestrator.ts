import type {
  LedgerData,
  ModelChoice,
  ReviewFinding,
  RoleSettings,
  RoutePreference,
  RunState,
  TaskState,
  TriageDecision,
} from "@zcode/orchestrator/types";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type {
  AdvisorSettings,
  LedgerData,
  ModelChoice,
  ReviewFinding,
  RoleSettings,
  Route,
  RoutePreference,
  RunState,
  TaskState,
  TriageDecision,
} from "@zcode/orchestrator/types";

/** The project a message or a job belongs to, as the composer knows it. */
export interface OrchestratorProject {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

export interface OrchestratorRouteRequest extends OrchestratorProject {
  readonly text: string;
  /** "auto" lets triage decide; the other two are the person overruling it. */
  readonly preference: RoutePreference;
  /** The conversation the message was typed in. */
  readonly conversationId?: string;
}

/**
 * What became of a message. "chat" and "direct" go on in the conversation they were typed in,
 * so the composer sends them as it always has; "orchestrated" became a job.
 */
export interface OrchestratorRouteResult {
  readonly decision: TriageDecision;
  /** Set when the message became a job. */
  readonly jobId?: string;
  /** Why the full route can't run here and the message went direct (no Git repository, a remote workspace). */
  readonly note?: string;
}

/**
 * Where a job stands. "waiting" means a decision is the person's (see `decisions`); the steps
 * that don't depend on it keep going.
 */
export type OrchestratorJobPhase =
  | "deliberating"
  | "dividing"
  | "working"
  | "final-read"
  | "waiting"
  | "done"
  | "failed"
  | "stopped";

/** One step of a job: who has it and how its review went. */
export interface OrchestratorStepView {
  readonly taskId: string;
  readonly title: string;
  readonly state: TaskState;
  readonly owns: readonly string[];
  /** The task ids of the steps this one waits for. */
  readonly dependsOn: readonly string[];
  /** The executor's run, once one started. Its conversation can be opened and typed into. */
  readonly run?: {
    readonly runId: string;
    readonly choice: ModelChoice;
    readonly state: RunState;
    readonly conversationId?: string;
    readonly branch?: string;
  };
  /** The latest review. */
  readonly review?: {
    readonly round: number;
    readonly verdict: "pass" | "findings";
    readonly findings: readonly ReviewFinding[];
    /** The reviewer's conversation. */
    readonly conversationId?: string;
  };
  /** What the host's own checks flagged on this step, oldest first. */
  readonly flags: ReadonlyArray<LedgerData["oversight.flagged"] & { readonly at: string }>;
}

/** Something only the person can settle. */
export interface OrchestratorDecision {
  readonly id: string;
  /**
   * "clarify": triage has questions and the job waits for the person's answer, given as a note
   * on the board. "level-vote": the parliament split between two plans and the advisors did not settle it. "paused-run": a
   * run changed files outside what its step owns. "chair": the chair passed a ruling to the
   * person, or has no rulings left. "blocked": the job can't go on (no executor can run, the
   * plan could not be divided).
   */
  readonly kind: "clarify" | "level-vote" | "paused-run" | "chair" | "blocked";
  /** One plain question. */
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** The step it is about, if any. */
  readonly taskId?: string;
}

/** A note on the job's board. */
export interface OrchestratorNote {
  readonly at: string;
  /** "person", "orchestrator", "watcher", or a run's id. */
  readonly from: string;
  /** The step it is for; everyone when absent. */
  readonly to?: string;
  readonly text: string;
}

export interface OrchestratorJobView {
  readonly jobId: string;
  readonly title: string;
  readonly phase: OrchestratorJobPhase;
  /** One plain sentence on where the job stands. */
  readonly status: string;
  /** The plan the parliament chose. */
  readonly plan?: {
    /** The seat that wrote it, e.g. "claude:fable". */
    readonly winner?: string;
    readonly text: string;
    readonly tied?: readonly string[];
    /** Every outside advisor asked about a level vote, with its answer. */
    readonly advisors?: LedgerData["parliament.decided"]["advisors"];
    /** The advisors' combined order (seats, best first), when they settled the vote. */
    readonly advisorOrder?: readonly string[];
  };
  readonly steps: readonly OrchestratorStepView[];
  /** What waits on the person, oldest first. */
  readonly decisions: readonly OrchestratorDecision[];
  /** The board, oldest first. */
  readonly notes: readonly OrchestratorNote[];
  /** What the chair ruled, oldest first. */
  readonly rulings: ReadonlyArray<LedgerData["chair.ruled"] & { readonly at: string }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrchestratorJobsSnapshot {
  /** The project's ledger position. The same number as last time means nothing happened. */
  readonly seq: number;
  /**
   * Every job of the project, newest first, whenever anything changed. Empty only when
   * `sinceSeq` was the current position: then the caller keeps what it has.
   */
  readonly jobs: readonly OrchestratorJobView[];
}

/**
 * The orchestrator: it decides where a message goes, and runs big jobs through the parliament,
 * the division into steps, several executors at once, review and oversight. It is the only
 * thing that writes a project's tasks and runs; the UI reads through it.
 */
export interface IOrchestratorService {
  route(params: OrchestratorRouteRequest): Promise<OrchestratorRouteResult>;
  listJobs(
    params: OrchestratorProject & { readonly sinceSeq?: number },
  ): Promise<OrchestratorJobsSnapshot>;
  /** The person's answer to one of a job's `decisions`. */
  decide(
    params: OrchestratorProject & {
      readonly jobId: string;
      readonly decisionId: string;
      readonly optionId: string;
    },
  ): Promise<void>;
  /** A note on the board from the person: for one step when `to` is set, for everyone otherwise. */
  postNote(
    params: OrchestratorProject & {
      readonly jobId: string;
      readonly to?: string;
      readonly text: string;
    },
  ): Promise<void>;
  /** Stops every run of the job. Its branches and worktrees stay. */
  stopJob(params: OrchestratorProject & { readonly jobId: string }): Promise<void>;
  /** Who holds each role in this project, and whether the outside advisors are on. */
  getRoles(params: OrchestratorProject): Promise<RoleSettings>;
  setRoles(params: OrchestratorProject & { readonly roles: RoleSettings }): Promise<void>;
}

export const IOrchestratorService = createServiceDescriptor<IOrchestratorService>(
  ServiceChannels.Orchestrator,
);
