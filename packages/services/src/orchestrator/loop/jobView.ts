import { jobSteps } from "@zcode/orchestrator/board";
import { replay } from "@zcode/orchestrator/tasks";
import type { LedgerData, LedgerEntry, Task } from "@zcode/orchestrator/types";
import type {
  OrchestratorDecision,
  OrchestratorJobPhase,
  OrchestratorJobView,
  OrchestratorNote,
  OrchestratorStepView,
} from "../orchestrator.js";
import { isHiddenNote, openDecisions, type DecisionRecord } from "./records.js";

/** The reason a job's task is cancelled with when the person stops it. */
export const STOPPED_REASON = "Stopped by the person.";

type Decided = LedgerData["parliament.decided"];

/** A job is a task the orchestrator made for a message: orchestrated, and split from nothing. */
export function jobTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.route === "orchestrated" && task.parentId === undefined);
}

/** The job's triage, when it was recorded with the job. */
export function triageOf(
  entries: readonly LedgerEntry[],
  jobId: string,
): LedgerData["triage.decided"] | undefined {
  const found = entries.find((entry) => entry.kind === "triage.decided" && entry.taskId === jobId);
  return found?.kind === "triage.decided" ? found.data : undefined;
}

/** The job's latest `parliament.decided`, and the latest one that has a winner. */
export function decidedOf(
  entries: readonly LedgerEntry[],
  jobId: string,
): { readonly latest?: Decided; readonly won?: Decided } {
  let latest: Decided | undefined;
  let won: Decided | undefined;
  for (const entry of entries) {
    if (entry.kind !== "parliament.decided" || entry.taskId !== jobId) continue;
    latest = entry.data;
    if (entry.data.winner !== undefined) won = entry.data;
  }
  return { ...(latest ? { latest } : {}), ...(won ? { won } : {}) };
}

export function isDivided(entries: readonly LedgerEntry[], jobId: string): boolean {
  return entries.some((entry) => entry.kind === "plan.divided" && entry.taskId === jobId);
}

/** A decision as the UI sees it, without the loop's own fields. */
function shown(record: DecisionRecord): OrchestratorDecision {
  return {
    id: record.id,
    kind: record.kind,
    question: record.question,
    options: record.options.map((option) => ({ id: option.id, label: option.label })),
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
  };
}

function phaseOf(
  job: Task,
  entries: readonly LedgerEntry[],
  waiting: boolean,
  stopReason: string | undefined,
): OrchestratorJobPhase {
  if (job.state === "cancelled") return stopReason === STOPPED_REASON ? "stopped" : "failed";
  if (job.state === "queued" || job.state === "merged") return "done";
  if (waiting) return "waiting";
  if (!decidedOf(entries, job.id).won) return "deliberating";
  if (!isDivided(entries, job.id)) return "dividing";
  if (job.state === "in_review") return "final-read";
  return "working";
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function statusOf(
  phase: OrchestratorJobPhase,
  steps: readonly OrchestratorStepView[],
  decisions: readonly OrchestratorDecision[],
  stopReason: string | undefined,
): string {
  const passed = steps.filter((step) => step.state === "queued").length;
  const live = steps.filter((step) => step.state !== "cancelled").length;
  switch (phase) {
    case "stopped":
      return "Stopped. Its branches and worktrees are kept.";
    case "failed":
      return stopReason ?? "The job could not go on.";
    case "done":
      return `Done: ${count(passed, "step")} passed review and the chair's final read. The branches wait for the release queue.`;
    case "waiting":
      return `Waiting on you: ${decisions[0]?.question ?? "a decision"}`;
    case "deliberating":
      return "The plan is being written.";
    case "dividing":
      return "The plan is being divided into steps.";
    case "final-read":
      return "Every step passed review; the chair is reading the whole work against the plan.";
    case "working": {
      const working = steps.filter(
        (step) => step.state === "working" || step.state === "in_review",
      ).length;
      return `${passed} of ${count(live, "step")} passed review; ${working} in progress.`;
    }
  }
}

/** One job's view, from the ledger alone. `entries` is the whole ledger. */
export function jobView(entries: readonly LedgerEntry[], job: Task): OrchestratorJobView {
  const steps: OrchestratorStepView[] = jobSteps(entries, job.id).map((step) => ({
    taskId: step.taskId,
    title: step.title,
    state: step.state,
    owns: step.owns,
    dependsOn: step.dependsOn,
    ...(step.run
      ? {
          run: {
            runId: step.run.runId,
            choice: step.run.choice,
            state: step.run.state,
            ...(step.run.conversationId ? { conversationId: step.run.conversationId } : {}),
            ...(step.run.branch ? { branch: step.run.branch } : {}),
          },
        }
      : {}),
    ...(step.review
      ? {
          review: {
            round: step.review.round,
            verdict: step.review.verdict,
            findings: step.review.findings,
            ...(step.review.conversationId ? { conversationId: step.review.conversationId } : {}),
          },
        }
      : {}),
    flags: step.flags,
  }));
  const inJob = new Set([job.id, ...steps.map((step) => step.taskId)]);
  const closed = job.state === "cancelled" || job.state === "queued" || job.state === "merged";
  const decisions = closed ? [] : openDecisions(entries, job.id).map(shown);
  const notes: OrchestratorNote[] = entries.flatMap((entry) =>
    entry.kind === "note" &&
    entry.taskId !== undefined &&
    inJob.has(entry.taskId) &&
    !isHiddenNote(entry.data.from)
      ? [
          {
            at: entry.at,
            from: entry.data.from,
            ...(entry.data.to === undefined ? {} : { to: entry.data.to }),
            text: entry.data.text,
          },
        ]
      : [],
  );
  const rulings = entries.flatMap((entry) =>
    entry.kind === "chair.ruled" && entry.taskId === job.id
      ? [{ ...entry.data, at: entry.at }]
      : [],
  );
  const { latest, won } = decidedOf(entries, job.id);
  const plan = won ?? latest;
  let stopReason: string | undefined;
  let updatedAt = job.updatedAt;
  for (const entry of entries) {
    if (entry.taskId === undefined || !inJob.has(entry.taskId)) continue;
    updatedAt = entry.at;
    if (entry.kind === "task.moved" && entry.taskId === job.id && entry.data.to === "cancelled") {
      stopReason = entry.data.reason;
    }
  }
  const phase = phaseOf(job, entries, decisions.length > 0, stopReason);
  return {
    jobId: job.id,
    title: job.title,
    phase,
    status: statusOf(phase, steps, decisions, stopReason),
    ...(plan
      ? {
          plan: {
            ...(plan.winner ? { winner: plan.winner } : {}),
            text: plan.plan,
            ...(plan.tied ? { tied: plan.tied } : {}),
            ...(plan.advisors ? { advisors: plan.advisors } : {}),
            ...(plan.advisorOrder ? { advisorOrder: plan.advisorOrder } : {}),
          },
        }
      : {}),
    steps,
    decisions,
    notes,
    rulings,
    createdAt: job.createdAt,
    updatedAt,
  };
}

/** Every job of the project, newest first. */
export function jobViews(entries: readonly LedgerEntry[]): OrchestratorJobView[] {
  const { tasks } = replay(entries);
  return jobTasks(tasks)
    .map((job) => jobView(entries, job))
    .reverse();
}
