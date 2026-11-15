import {
  RUN_MOVES,
  TASK_MOVES,
  type LedgerEntry,
  type Run,
  type RunState,
  type Task,
  type TaskState,
} from "../types.js";
import { LedgerCorruptError, LedgerRuleError } from "./errors.js";

/** What replaying a project's ledger gives. Lists keep the order things were created in. */
export interface ProjectState {
  readonly tasks: readonly Task[];
  readonly runs: readonly Run[];
  /** The last entry's seq; 0 for an empty ledger. */
  readonly seq: number;
}

interface Building {
  readonly tasks: Map<string, Task>;
  readonly runs: Map<string, Run>;
  seq: number;
}

/** Once merged (or cancelled) a task takes no more runs and keeps its route. */
const CLOSED: ReadonlySet<TaskState> = new Set(["merged", "deployed", "checked", "cancelled"]);
const FINAL_RUN: ReadonlySet<RunState> = new Set(["done", "failed", "stopped"]);

/**
 * Tasks and runs from a ledger. Entries must be numbered 1, 2, 3… and each must follow the
 * rules; the first that doesn't throws a `LedgerCorruptError` naming its place.
 */
export function replay(entries: readonly LedgerEntry[]): ProjectState {
  const state: Building = { tasks: new Map(), runs: new Map(), seq: 0 };
  entries.forEach((entry, index) => {
    if (entry.seq !== state.seq + 1) {
      throw new LedgerCorruptError(`seq ${entry.seq} follows ${state.seq}`, index + 1);
    }
    try {
      step(state, entry);
    } catch (error) {
      if (error instanceof LedgerRuleError) {
        throw new LedgerCorruptError(
          `entry ${entry.id} (${entry.kind}): ${error.message}`,
          index + 1,
        );
      }
      throw error;
    }
  });
  return settle(state);
}

/** The state after one more entry. Throws a `LedgerRuleError` when the entry breaks a rule. */
export function applyEntry(state: ProjectState, entry: LedgerEntry): ProjectState {
  const next: Building = {
    tasks: new Map(state.tasks.map((task) => [task.id, task])),
    runs: new Map(state.runs.map((run) => [run.id, run])),
    seq: state.seq,
  };
  step(next, entry);
  return settle(next);
}

function settle(state: Building): ProjectState {
  return { tasks: [...state.tasks.values()], runs: [...state.runs.values()], seq: state.seq };
}

function step(state: Building, entry: LedgerEntry): void {
  const { at } = entry;
  switch (entry.kind) {
    case "task.created": {
      if (state.tasks.has(entry.taskId)) {
        throw new LedgerRuleError("task-exists", `Task ${entry.taskId} already exists`);
      }
      const { parentId, dependsOn, owns } = entry.data;
      if (parentId !== undefined) taskOf(state, parentId);
      state.tasks.set(entry.taskId, {
        id: entry.taskId,
        projectKey: entry.projectKey,
        title: entry.data.title,
        brief: entry.data.brief,
        state: "idea",
        route: entry.data.route,
        ...(parentId === undefined ? {} : { parentId }),
        dependsOn: [...(dependsOn ?? [])],
        owns: [...(owns ?? [])],
        createdAt: at,
        updatedAt: at,
      });
      break;
    }
    case "task.moved": {
      const task = taskOf(state, entry.taskId);
      const { from, to } = entry.data;
      // `from` is what the writer saw; a stale one means someone else moved the task first.
      if (from !== task.state || !TASK_MOVES[task.state].includes(to)) {
        throw new LedgerRuleError(
          "illegal-move",
          `Task ${task.id} is ${task.state}; it can't move from ${from} to ${to}`,
        );
      }
      state.tasks.set(task.id, { ...task, state: to, updatedAt: at });
      break;
    }
    case "task.rerouted": {
      const task = openTask(state, entry.taskId);
      const { from, to } = entry.data;
      if (from !== task.route || to === task.route) {
        throw new LedgerRuleError(
          "illegal-move",
          `Task ${task.id} goes ${task.route}; it can't be rerouted from ${from} to ${to}`,
        );
      }
      state.tasks.set(task.id, { ...task, route: to, updatedAt: at });
      break;
    }
    case "run.started": {
      if (state.runs.has(entry.runId)) {
        throw new LedgerRuleError("run-exists", `Run ${entry.runId} already exists`);
      }
      openTask(state, entry.taskId);
      state.runs.set(entry.runId, {
        id: entry.runId,
        taskId: entry.taskId,
        role: entry.data.role,
        choice: entry.data.choice,
        state: "starting",
        ...details(entry.data),
        startedAt: at,
      });
      break;
    }
    case "run.updated": {
      const run = runOf(state, entry.runId, entry.taskId);
      if (FINAL_RUN.has(run.state)) {
        throw new LedgerRuleError("run-ended", `Run ${run.id} is ${run.state} and can't change`);
      }
      const to = entry.data.state;
      if (to !== undefined && !RUN_MOVES[run.state].includes(to)) {
        throw new LedgerRuleError(
          "illegal-move",
          `Run ${run.id} can't move from ${run.state} to ${to}`,
        );
      }
      state.runs.set(run.id, {
        ...run,
        ...details(entry.data),
        ...(to === undefined ? {} : { state: to }),
        ...(to !== undefined && FINAL_RUN.has(to) ? { endedAt: at } : {}),
      });
      break;
    }
    case "review.decided": {
      // The verdict is about an executor's run of this task, by a reviewer's run of the same task.
      const reviewed = runOf(state, entry.runId, entry.taskId);
      if (reviewed.role !== "executor") {
        throw new LedgerRuleError("wrong-run", `Run ${reviewed.id} is not an executor's`);
      }
      const reviewerRunId = entry.data.reviewerRunId;
      if (reviewerRunId !== undefined) {
        const reviewer = runOf(state, reviewerRunId, entry.taskId);
        if (reviewer.role !== "reviewer") {
          throw new LedgerRuleError("wrong-run", `Run ${reviewer.id} is not a reviewer's`);
        }
      }
      break;
    }
    case "chair.ruled": {
      // A ruling belongs to the job; the run it is about is the job's or one of its steps'.
      const job = taskOf(state, entry.taskId);
      if (entry.runId !== undefined) {
        const run = runOf(state, entry.runId, undefined);
        const task = taskOf(state, run.taskId);
        if (task.id !== job.id && task.parentId !== job.id) {
          throw new LedgerRuleError(
            "wrong-task",
            `Run ${run.id} belongs to task ${task.id}, which is not part of job ${job.id}`,
          );
        }
      }
      break;
    }
    default: {
      // Triage, parliament, division and notes change no task or run, but what they name must exist.
      if (entry.taskId !== undefined) taskOf(state, entry.taskId);
      if (entry.runId !== undefined) runOf(state, entry.runId, entry.taskId);
    }
  }
  state.seq = entry.seq;
}

function taskOf(state: Building, taskId: string): Task {
  const task = state.tasks.get(taskId);
  if (!task) throw new LedgerRuleError("unknown-task", `No task ${taskId}`);
  return task;
}

function openTask(state: Building, taskId: string): Task {
  const task = taskOf(state, taskId);
  if (CLOSED.has(task.state)) {
    throw new LedgerRuleError("task-closed", `Task ${taskId} is ${task.state}`);
  }
  return task;
}

function runOf(state: Building, runId: string, taskId: string | undefined): Run {
  const run = state.runs.get(runId);
  if (!run) throw new LedgerRuleError("unknown-run", `No run ${runId}`);
  if (taskId !== undefined && taskId !== run.taskId) {
    throw new LedgerRuleError(
      "wrong-task",
      `Run ${runId} belongs to task ${run.taskId}, not ${taskId}`,
    );
  }
  return run;
}

/** The optional run details an entry sets, without copying absent ones as `undefined`. */
function details(data: {
  readonly account?: string;
  readonly conversationId?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
}): Partial<Pick<Run, "account" | "conversationId" | "worktreePath" | "branch">> {
  const out: { account?: string; conversationId?: string; worktreePath?: string; branch?: string } =
    {};
  if (data.account !== undefined) out.account = data.account;
  if (data.conversationId !== undefined) out.conversationId = data.conversationId;
  if (data.worktreePath !== undefined) out.worktreePath = data.worktreePath;
  if (data.branch !== undefined) out.branch = data.branch;
  return out;
}
