import { openProject, replay, type Ledger, type Project } from "@zcode/orchestrator/tasks";
import type { LedgerEntry, Run, Task } from "@zcode/orchestrator/types";
import type { OrchestratorHost } from "../host.js";
import type { OrchestratorDecision, OrchestratorProject } from "../orchestrator.js";
import { OPTION_LABELS, type OptionId } from "./options.js";
import type { SerialQueues } from "./queue.js";
import {
  answerNote,
  CLOSED_OPTION,
  decisionNote,
  openDecisions,
  type DecisionAbout,
  type DecisionRecord,
  type RetryStage,
} from "./records.js";
import type { RolesStore } from "./rolesStore.js";

/** What every part of the loop shares: the port, the ledger, and the little it keeps in memory. */
export interface Loop {
  readonly host: OrchestratorHost;
  readonly ledger: Ledger;
  readonly roles: RolesStore;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly queues: SerialQueues;
  /** One per job; `stopJob` aborts it, which ends the job's model asks and turn waits. */
  readonly controllers: Map<string, AbortController>;
  /** The last reply handled per conversation: a turn with no text may hand back the one before. */
  readonly lastText: Map<string, string>;
  /** Conversations the loop interrupted: their "failed" turn is a stop, not a failure. */
  readonly interrupted: Set<string>;
  /**
   * The token the last message to each reviewer asked it to echo, and whether that message was
   * already the one "ask again". A reply handed back from an earlier turn lacks the token.
   */
  readonly reviewAsks: Map<string, { readonly token: string; readonly again: boolean }>;
  /** This instance, as a job's owner is recorded in the ledger. */
  readonly instanceId: string;
  /** Whether a recorded owner is still running; only a gone owner's job may be taken over. */
  readonly ownerAlive: (owner: JobOwner) => boolean;
}

/** Who runs a job: one service instance, in one process. */
export interface JobOwner {
  readonly instance: string;
  readonly pid: number;
}

export interface JobRef {
  readonly project: OrchestratorProject;
  /** `workspaceIdentity?.trim() || workspacePath`, as everywhere else in the app. */
  readonly key: string;
  readonly jobId: string;
}

export function projectKeyOf(project: OrchestratorProject): string {
  return project.workspaceIdentity?.trim() || project.workspacePath;
}

export function projectOnly(project: OrchestratorProject): OrchestratorProject {
  return {
    projectId: project.projectId,
    workspacePath: project.workspacePath,
    ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
  };
}

export function jobRef(project: OrchestratorProject, jobId: string): JobRef {
  return { project: projectOnly(project), key: projectKeyOf(project), jobId };
}

export function ledgerOf(loop: Loop, job: JobRef): Project {
  return openProject(loop.ledger, job.key);
}

export function entriesOf(loop: Loop, job: JobRef): Promise<readonly LedgerEntry[]> {
  return loop.ledger.read(job.key);
}

export function signalOf(loop: Loop, job: JobRef): AbortSignal {
  const id = `${job.key}\0${job.jobId}`;
  let controller = loop.controllers.get(id);
  if (!controller) {
    controller = new AbortController();
    loop.controllers.set(id, controller);
  }
  return controller.signal;
}

export function abortJob(loop: Loop, job: JobRef): void {
  signalOf(loop, job);
  loop.controllers.get(`${job.key}\0${job.jobId}`)?.abort(new Error("The job was stopped."));
}

/** Work on the job itself (planning, starting steps, the final read), one item at a time. */
export function inJob<T>(loop: Loop, job: JobRef, work: () => Promise<T>): Promise<T> {
  return loop.queues.run(`job\0${job.key}\0${job.jobId}`, work);
}

/** Work on one step (its turns, its reviews), one item at a time. */
export function inStep<T>(
  loop: Loop,
  job: JobRef,
  taskId: string,
  work: () => Promise<T>,
): Promise<T> {
  return loop.queues.run(`step\0${job.key}\0${taskId}`, work);
}

/** The job's chair: rulings are counted per job, so two steps never ask it at once. */
export function inChair<T>(loop: Loop, job: JobRef, work: () => Promise<T>): Promise<T> {
  return loop.queues.run(`chair\0${job.key}\0${job.jobId}`, work);
}

export function taskIn(entries: readonly LedgerEntry[], taskId: string): Task | undefined {
  return replay(entries).tasks.find((task) => task.id === taskId);
}

/** Cancelled or finished: nothing more may happen to the job. */
export function jobClosed(entries: readonly LedgerEntry[], jobId: string): boolean {
  const state = taskIn(entries, jobId)?.state;
  return state === undefined || state === "cancelled" || state === "queued" || state === "merged";
}

export function runIn(entries: readonly LedgerEntry[], runId: string): Run | undefined {
  return replay(entries).runs.find((run) => run.id === runId);
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().replace(/\.$/, "") || "an unknown error";
}

export interface OpenDecisionInput {
  readonly about: DecisionAbout;
  readonly kind: OrchestratorDecision["kind"];
  readonly question: string;
  readonly options: ReadonlyArray<OptionId | { readonly id: string; readonly label: string }>;
  readonly taskId?: string;
  readonly stage?: RetryStage;
  readonly runId?: string;
  readonly findingId?: string;
  readonly paths?: readonly string[];
  readonly role?: "executor" | "reviewer";
}

/** Records a decision for the person, unless the job is closed. */
export async function openDecision(
  loop: Loop,
  job: JobRef,
  input: OpenDecisionInput,
): Promise<void> {
  const record: DecisionRecord = {
    id: loop.newId(),
    about: input.about,
    kind: input.kind,
    question: input.question,
    options: input.options.map((option) =>
      typeof option === "string" ? { id: option, label: OPTION_LABELS[option] } : option,
    ),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.findingId === undefined ? {} : { findingId: input.findingId }),
    ...(input.paths === undefined ? {} : { paths: input.paths }),
    ...(input.role === undefined ? {} : { role: input.role }),
  };
  if (jobClosed(await entriesOf(loop, job), job.jobId)) return;
  await ledgerOf(loop, job).record(decisionNote(job.jobId, record));
}

/** Closes the open decisions about a step (or the whole job) that nobody needs any more. */
export async function closeDecisions(loop: Loop, job: JobRef, taskId?: string): Promise<void> {
  const entries = await entriesOf(loop, job);
  for (const record of openDecisions(entries, job.jobId)) {
    if (taskId !== undefined && record.taskId !== taskId) continue;
    await ledgerOf(loop, job).record(answerNote(job.jobId, record.id, CLOSED_OPTION));
  }
}

/**
 * Runs part of the loop in the background. Any failure ends as a decision the person can see,
 * with "try again" going back to `stage`; nothing escapes to stop another job. A stopped job's
 * work is dropped quietly.
 */
export function background(
  loop: Loop,
  job: JobRef,
  where: { readonly stage: RetryStage; readonly taskId?: string; readonly what: string },
  work: () => Promise<void>,
): void {
  void work().catch(async (error: unknown) => {
    try {
      if (signalOf(loop, job).aborted) return;
      if (jobClosed(await entriesOf(loop, job), job.jobId)) return;
      await openDecision(loop, job, {
        about: "retry",
        kind: "blocked",
        stage: where.stage,
        ...(where.taskId ? { taskId: where.taskId } : {}),
        question: `Something went wrong while ${where.what}: ${errorText(error)}. Try again, or stop it.`,
        options: ["retry", where.taskId ? "stop-step" : "stop-job"],
      });
    } catch {
      // The ledger itself failed; there is nowhere left to say so.
    }
  });
}
