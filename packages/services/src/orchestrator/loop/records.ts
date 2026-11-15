import type { LedgerDraft, LedgerEntry } from "@zcode/orchestrator/types";
import { replay } from "@zcode/orchestrator/tasks";
import type { OrchestratorDecision } from "../orchestrator.js";
import { option } from "./options.js";

/**
 * The loop's own records in the ledger. The contracts have no kind for a decision that waits on
 * the person, its answer, the level plans' texts or the commit a run started from, so each is a
 * `note` whose `from` starts with "xatlas:". The board digest leaves such notes out (it shows
 * notes from the person, the orchestrator and runs only), and the job view hides them.
 */

export const HIDDEN_PREFIX = "xatlas:";
const DECISION_FROM = "xatlas:decision";
const ANSWER_FROM = "xatlas:answer";
const PLAN_FROM = "xatlas:plan";
const BASE_FROM = "xatlas:run-base";
const REVIEW_ASK_FROM = "xatlas:review-ask";
const WATCHER_FROM = "xatlas:watcher-call";
const FINAL_SENT_FROM = "xatlas:final-sent";

/** The option a decision is closed with when the loop no longer needs it (its step stopped). */
export const CLOSED_OPTION = "closed";

/** What the loop does again when the person says "try again". */
export type RetryStage =
  | "plan"
  | "divide"
  | "start"
  | "turn"
  | "review"
  | "final-read"
  | "final-send";

/** Why a decision was opened; it tells `decide` what each option means. */
export type DecisionAbout =
  | "clarify"
  | "level-vote"
  | "retry"
  | "paused"
  | "asked"
  | "turn"
  | "chair-step"
  | "dispute"
  | "final-read"
  | "watcher"
  | "stuck"
  | "stop-failed";

export interface DecisionRecord extends OrchestratorDecision {
  readonly about: DecisionAbout;
  readonly stage?: RetryStage;
  /** The run it is about. */
  readonly runId?: string;
  readonly findingId?: string;
  /** For "paused": the paths outside what the step owns. */
  readonly paths?: readonly string[];
  /** For a run that waits: the role of the run it is about. */
  readonly role?: "executor" | "reviewer";
}

export function isHiddenNote(from: string): boolean {
  return from.startsWith(HIDDEN_PREFIX);
}

type NoteEntry = Extract<LedgerEntry, { kind: "note" }>;

function notes(entries: readonly LedgerEntry[], from: string, taskId?: string): NoteEntry[] {
  return entries.filter(
    (entry): entry is NoteEntry =>
      entry.kind === "note" &&
      entry.data.from === from &&
      (taskId === undefined || entry.taskId === taskId),
  );
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function decisionNote(jobId: string, record: DecisionRecord): LedgerDraft {
  return {
    id: `decision:${jobId}:${record.id}`,
    kind: "note",
    taskId: jobId,
    data: { from: DECISION_FROM, text: JSON.stringify(record) },
  };
}

export function answerNote(jobId: string, decisionId: string, optionId: string): LedgerDraft {
  return {
    id: `answer:${jobId}:${decisionId}`,
    kind: "note",
    taskId: jobId,
    data: { from: ANSWER_FROM, text: JSON.stringify({ decisionId, optionId }) },
  };
}

/** Every decision opened on a job, oldest first, each with its answer when it has one. */
export function decisionsOf(
  entries: readonly LedgerEntry[],
  jobId: string,
): Array<{ readonly record: DecisionRecord; readonly answer?: string; readonly seq: number }> {
  const answers = new Map<string, string>();
  for (const entry of notes(entries, ANSWER_FROM, jobId)) {
    const value = parse(entry.data.text);
    if (typeof value?.decisionId === "string" && typeof value.optionId === "string") {
      answers.set(value.decisionId, value.optionId);
    }
  }
  return notes(entries, DECISION_FROM, jobId).flatMap((entry) => {
    const value = parse(entry.data.text);
    if (typeof value?.id !== "string" || typeof value.about !== "string") return [];
    const record = value as unknown as DecisionRecord;
    const answer = answers.get(record.id);
    return [{ record, seq: entry.seq, ...(answer === undefined ? {} : { answer }) }];
  });
}

export function openDecisions(entries: readonly LedgerEntry[], jobId: string): DecisionRecord[] {
  return decisionsOf(entries, jobId)
    .filter((decision) => decision.answer === undefined)
    .map((decision) => decision.record);
}

/** The commit a run's worktree started from, as the loop resolved it before starting it. */
export function baseNote(taskId: string, runId: string, sha: string): LedgerDraft {
  return {
    id: `base:${runId}`,
    kind: "note",
    taskId,
    runId,
    data: { from: BASE_FROM, text: sha },
  };
}

export function runBase(entries: readonly LedgerEntry[], runId: string): string | undefined {
  return notes(entries, BASE_FROM).find((entry) => entry.runId === runId)?.data.text;
}

/** One of the plans a level vote left to the person. */
export interface PlanOption {
  readonly letter: string;
  readonly seat: string;
  readonly plan: string;
}

export function planNote(jobId: string, id: string, option: PlanOption): LedgerDraft {
  return {
    id: `plan:${jobId}:${id}`,
    kind: "note",
    taskId: jobId,
    data: { from: PLAN_FROM, text: JSON.stringify(option) },
  };
}

/** The latest text recorded for each level plan of a job, by letter. */
export function planOptions(
  entries: readonly LedgerEntry[],
  jobId: string,
): ReadonlyMap<string, PlanOption> {
  const options = new Map<string, PlanOption>();
  for (const entry of notes(entries, PLAN_FROM, jobId)) {
    const value = parse(entry.data.text);
    if (
      typeof value?.letter === "string" &&
      typeof value.seat === "string" &&
      typeof value.plan === "string"
    ) {
      options.set(value.letter, value as unknown as PlanOption);
    }
  }
  return options;
}

/** The task each run belongs to. */
function runTasks(entries: readonly LedgerEntry[]): Map<string, string> {
  return new Map(replay(entries).runs.map((run) => [run.id, run.taskId]));
}

/**
 * Findings of one step the chair ruled on (`ruling` given: only those it ruled that way), by
 * the ruling's run. Finding ids are unique within a step only, so this is per step.
 */
function chairRuled(
  entries: readonly LedgerEntry[],
  jobId: string,
  taskId: string,
  ruling?: string,
): string[] {
  const tasks = runTasks(entries);
  return entries.flatMap((entry) =>
    entry.kind === "chair.ruled" &&
    entry.taskId === jobId &&
    entry.data.findingId &&
    entry.runId !== undefined &&
    tasks.get(entry.runId) === taskId &&
    (ruling === undefined || entry.data.ruling === ruling)
      ? [entry.data.findingId]
      : [],
  );
}

/** The step's findings the chair or the person dropped. */
export function droppedFindings(
  entries: readonly LedgerEntry[],
  jobId: string,
  taskId: string,
): Set<string> {
  const dropped = new Set(chairRuled(entries, jobId, taskId, "drop"));
  for (const decision of decisionsOf(entries, jobId)) {
    if (
      decision.record.about === "dispute" &&
      decision.record.taskId === taskId &&
      decision.answer === option("drop-finding") &&
      decision.record.findingId
    ) {
      dropped.add(decision.record.findingId);
    }
  }
  return dropped;
}

/** The step's findings already ruled on, by the chair or the person, so none is ruled twice. */
export function ruledFindings(
  entries: readonly LedgerEntry[],
  jobId: string,
  taskId: string,
): Set<string> {
  const ruled = new Set(chairRuled(entries, jobId, taskId));
  for (const { record } of decisionsOf(entries, jobId)) {
    if (record.about === "dispute" && record.taskId === taskId && record.findingId) {
      ruled.add(record.findingId);
    }
  }
  return ruled;
}

/** Paths outside what its step owns that the person let a run keep ("resume" on a pause). */
export function allowedPaths(
  entries: readonly LedgerEntry[],
  jobId: string,
  runId: string,
): Set<string> {
  const allowed = new Set<string>();
  for (const decision of decisionsOf(entries, jobId)) {
    if (
      decision.record.about === "paused" &&
      decision.record.runId === runId &&
      decision.answer === "resume"
    ) {
      for (const path of decision.record.paths ?? []) allowed.add(path);
    }
  }
  return allowed;
}

/** The reminder note's id: one per run, so writing it twice changes nothing. */
export function reminderId(runId: string): string {
  return `remind:${runId}`;
}

/** The commit a reviewer was asked to read, kept with the request. */
export function reviewAskNote(
  taskId: string,
  reviewerRunId: string,
  id: string,
  commit: string,
): LedgerDraft {
  return {
    id: `review-ask:${reviewerRunId}:${id}`,
    kind: "note",
    taskId,
    runId: reviewerRunId,
    data: { from: REVIEW_ASK_FROM, text: commit },
  };
}

export function askedCommit(
  entries: readonly LedgerEntry[],
  reviewerRunId: string,
): string | undefined {
  return notes(entries, REVIEW_ASK_FROM).findLast((entry) => entry.runId === reviewerRunId)?.data
    .text;
}

/** One call to the watcher about a run, written before it is asked, so a failed call counts too. */
export function watcherCallNote(taskId: string, runId: string, n: number): LedgerDraft {
  return {
    id: `watcher-call:${runId}:${n}`,
    kind: "note",
    taskId,
    runId,
    data: { from: WATCHER_FROM, text: String(n) },
  };
}

export function watcherCalls(entries: readonly LedgerEntry[], runId: string): number {
  return notes(entries, WATCHER_FROM).filter((entry) => entry.runId === runId).length;
}

/** That the final read's findings (the ruling entry `rulingId`) reached a step's executor. */
export function finalSentNote(jobId: string, rulingId: string, taskId: string): LedgerDraft {
  return {
    id: `final-sent:${rulingId}:${taskId}`,
    kind: "note",
    taskId: jobId,
    data: { from: FINAL_SENT_FROM, text: taskId },
  };
}

export function finalSentTo(entries: readonly LedgerEntry[], rulingId: string): Set<string> {
  const prefix = `final-sent:${rulingId}:`;
  return new Set(
    notes(entries, FINAL_SENT_FROM)
      .filter((entry) => entry.id.startsWith(prefix))
      .map((entry) => entry.data.text),
  );
}
