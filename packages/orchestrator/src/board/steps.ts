import type {
  LedgerData,
  LedgerEntry,
  ModelChoice,
  ReviewFinding,
  Run,
  RunState,
  Task,
  TaskState,
} from "../types.js";
import { replay } from "../tasks/replay.js";

/** Where a step that can start begins: a commit to branch from and the commits to merge in. */
export interface StepStart {
  readonly taskId: string;
  /** The first dependency's reviewed commit; null when the step waits on nothing (the project's current commit). */
  readonly startFrom: string | null;
  /** The other dependencies' reviewed commits, in the order the step names them. */
  readonly mergeIn: readonly string[];
}

/** One step of a job as the UI shows it: who has it, how its review went, what was flagged. */
export interface JobStep {
  readonly taskId: string;
  readonly title: string;
  readonly brief: string;
  readonly state: TaskState;
  readonly owns: readonly string[];
  /** The task ids of the steps this one waits for. */
  readonly dependsOn: readonly string[];
  /** The latest executor run, once one started. */
  readonly run?: {
    readonly runId: string;
    readonly choice: ModelChoice;
    readonly state: RunState;
    readonly conversationId?: string;
    readonly worktreePath?: string;
    readonly branch?: string;
  };
  /** The latest review of the step. */
  readonly review?: {
    /** The run that was reviewed. */
    readonly runId: string;
    readonly round: number;
    /** Judged by the findings: "pass" when none is a blocker, whatever word the review used. */
    readonly verdict: "pass" | "findings";
    readonly commit: string;
    readonly lenses: readonly string[];
    readonly findings: readonly ReviewFinding[];
    readonly reviewerRunId?: string;
    /** The reviewer's conversation, from its run. */
    readonly conversationId?: string;
    readonly at: string;
  };
  /** What the host's own checks flagged on this step, oldest first. */
  readonly flags: ReadonlyArray<
    LedgerData["oversight.flagged"] & { readonly at: string; readonly runId: string }
  >;
}

type ReviewEntry = Extract<LedgerEntry, { kind: "review.decided" }>;

/** A dependency in one of these states has passed review and been queued, or gone further. */
const SETTLED: ReadonlySet<TaskState> = new Set(["queued", "merged", "deployed", "checked"]);

/** A step's task id: `<jobId>.<key>`. */
export function stepTaskId(jobId: string, key: string): string {
  return `${jobId}.${key}`;
}

/**
 * The job's steps that can start now, in the order they were created: planned, no run yet,
 * and every task they depend on is queued or later and its latest executor run's latest review
 * passed (it has no blocker). That review's commit is the one used. `entries` is the whole
 * ledger, from seq 1.
 */
export function stepsToStart(entries: readonly LedgerEntry[], jobId: string): readonly StepStart[] {
  const { tasks, runs } = replay(entries);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const started = new Set(runs.map((run) => run.taskId));
  const reviews = latestReviews(entries, (entry) => entry.runId);
  const ready: StepStart[] = [];
  for (const task of stepsOf(tasks, jobId)) {
    if (task.state !== "planned" || started.has(task.id)) continue;
    const commits: string[] = [];
    for (const id of task.dependsOn) {
      const dependency = byId.get(id);
      const run = latestExecutor(runs, id);
      const review = run === undefined ? undefined : reviews.get(run.id);
      if (!dependency || !SETTLED.has(dependency.state) || !review || !passes(review)) break;
      commits.push(review.data.commit);
    }
    if (commits.length < task.dependsOn.length) continue;
    ready.push({ taskId: task.id, startFrom: commits[0] ?? null, mergeIn: commits.slice(1) });
  }
  return ready;
}

/**
 * The job's steps in the order they were created, each with its latest executor run, its
 * latest review and what oversight flagged. `entries` is the whole ledger, from seq 1.
 */
export function jobSteps(entries: readonly LedgerEntry[], jobId: string): readonly JobStep[] {
  const { tasks, runs } = replay(entries);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const reviews = latestReviews(entries, (entry) => entry.taskId);
  return stepsOf(tasks, jobId).map((task) => {
    const run = latestExecutor(runs, task.id);
    const review = reviews.get(task.id);
    const reviewer =
      review?.data.reviewerRunId === undefined
        ? undefined
        : runsById.get(review.data.reviewerRunId);
    const flags = entries.flatMap((entry) =>
      entry.kind === "oversight.flagged" && entry.taskId === task.id
        ? [{ ...entry.data, at: entry.at, runId: entry.runId }]
        : [],
    );
    return {
      taskId: task.id,
      title: task.title,
      brief: task.brief,
      state: task.state,
      owns: task.owns,
      dependsOn: task.dependsOn,
      ...(run === undefined
        ? {}
        : {
            run: {
              runId: run.id,
              choice: run.choice,
              state: run.state,
              ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
              ...(run.worktreePath === undefined ? {} : { worktreePath: run.worktreePath }),
              ...(run.branch === undefined ? {} : { branch: run.branch }),
            },
          }),
      ...(review === undefined
        ? {}
        : {
            review: {
              runId: review.runId,
              round: review.data.round,
              verdict: passes(review) ? "pass" : "findings",
              commit: review.data.commit,
              lenses: review.data.lenses,
              findings: review.data.findings,
              ...(review.data.reviewerRunId === undefined
                ? {}
                : { reviewerRunId: review.data.reviewerRunId }),
              ...(reviewer?.conversationId === undefined
                ? {}
                : { conversationId: reviewer.conversationId }),
              at: review.at,
            },
          }),
      flags,
    };
  });
}

/** The tasks split from `jobId`, in the order they were created. */
export function stepsOf(tasks: readonly Task[], jobId: string): Task[] {
  return tasks.filter((task) => task.parentId === jobId);
}

/** The last executor run started on a task. */
export function latestExecutor(runs: readonly Run[], taskId: string): Run | undefined {
  return runs.findLast((run) => run.taskId === taskId && run.role === "executor");
}

/** The last `review.decided` for each task or run (`key` says which), by ledger order. */
function latestReviews(
  entries: readonly LedgerEntry[],
  key: (entry: ReviewEntry) => string,
): Map<string, ReviewEntry> {
  const reviews = new Map<string, ReviewEntry>();
  for (const entry of entries) if (entry.kind === "review.decided") reviews.set(key(entry), entry);
  return reviews;
}

/** A round passes when it has no blocker, whatever word its verdict uses. */
function passes(review: ReviewEntry): boolean {
  return !review.data.findings.some((finding) => finding.severity === "blocker");
}
