import type {
  LedgerData,
  LedgerDraft,
  LedgerEntry,
  ModelChoice,
  Run,
  RunRole,
  Task,
  TaskState,
} from "../types.js";
import { LedgerRuleError } from "./errors.js";
import type { Ledger, LedgerDraftBuilder } from "./ledger.js";
import { applyEntry, replay, type ProjectState } from "./replay.js";

export interface CreateTaskInput {
  readonly title: string;
  readonly brief: string;
  readonly route: Task["route"];
  readonly parentId?: string;
  /** May name tasks that don't exist yet; the task isn't ready until they do and are merged. */
  readonly dependsOn?: readonly string[];
  readonly owns?: readonly string[];
  /** Asking again with the same id returns the task that is there and writes nothing. */
  readonly id?: string;
}

export interface StartRunInput {
  readonly taskId: string;
  readonly role: RunRole;
  readonly choice: ModelChoice;
  readonly account?: string;
  readonly conversationId?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  /** Asking again with the same id returns the run that is there and writes nothing. */
  readonly id?: string;
}

/** One project's tasks and runs. Every command checks its rule inside the ledger's lock. */
export interface Project {
  state(): Promise<ProjectState>;
  createTask(input: CreateTaskInput): Promise<Task>;
  moveTask(taskId: string, to: TaskState, reason?: string): Promise<Task>;
  rerouteTask(taskId: string, to: Task["route"], reason: string): Promise<Task>;
  startRun(input: StartRunInput): Promise<Run>;
  updateRun(runId: string, patch: LedgerData["run.updated"]): Promise<Run>;
  /** Triage, parliament, division and notes; task and run entries pass the same rules. */
  record(draft: LedgerDraft): Promise<LedgerEntry>;
  /** Planned tasks whose `dependsOn` are all merged, deployed or checked. */
  readyTasks(): Promise<readonly Task[]>;
}

const DONE: ReadonlySet<TaskState> = new Set(["merged", "deployed", "checked"]);

export function openProject(ledger: Ledger, projectKey: string): Project {
  /**
   * Writes the entry the builder makes and returns the state just after it: the state the
   * builder saw plus the entry, or, when the entry was already there, the state as it was.
   */
  async function write(build: LedgerDraftBuilder): Promise<ProjectState> {
    let seen: ProjectState | undefined;
    const entry = await ledger.append(projectKey, (context) => {
      seen = context.state;
      return build(context);
    });
    const before = seen ?? replay([]);
    return entry.seq > before.seq ? applyEntry(before, entry) : before;
  }

  async function state(): Promise<ProjectState> {
    return replay(await ledger.read(projectKey));
  }

  return {
    state,

    async createTask(input) {
      let taskId = input.id;
      const after = await write(({ newId }) => {
        taskId ??= newId();
        return {
          id: `task:${taskId}`,
          kind: "task.created",
          taskId,
          data: {
            title: input.title,
            brief: input.brief,
            route: input.route,
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
            dependsOn: [...(input.dependsOn ?? [])],
            owns: [...(input.owns ?? [])],
          },
        };
      });
      return found(after.tasks, taskId);
    },

    async moveTask(taskId, to, reason) {
      const after = await write(({ state: now }) => ({
        kind: "task.moved",
        taskId,
        data: { from: taskIn(now, taskId).state, to, ...(reason === undefined ? {} : { reason }) },
      }));
      return found(after.tasks, taskId);
    },

    async rerouteTask(taskId, to, reason) {
      const after = await write(({ state: now }) => ({
        kind: "task.rerouted",
        taskId,
        data: { from: taskIn(now, taskId).route, to, reason },
      }));
      return found(after.tasks, taskId);
    },

    async startRun(input) {
      let runId = input.id;
      const after = await write(({ newId }) => {
        runId ??= newId();
        const { taskId, role, choice, account, conversationId, worktreePath, branch } = input;
        return {
          id: `run:${runId}`,
          kind: "run.started",
          taskId,
          runId,
          data: {
            role,
            choice,
            ...(account === undefined ? {} : { account }),
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(worktreePath === undefined ? {} : { worktreePath }),
            ...(branch === undefined ? {} : { branch }),
          },
        };
      });
      return found(after.runs, runId);
    },

    async updateRun(runId, patch) {
      const after = await write(({ state: now }) => {
        const run = now.runs.find((candidate) => candidate.id === runId);
        if (!run) throw new LedgerRuleError("unknown-run", `No run ${runId}`);
        return { kind: "run.updated", taskId: run.taskId, runId, data: patch };
      });
      return found(after.runs, runId);
    },

    record(draft) {
      return ledger.append(projectKey, draft);
    },

    async readyTasks() {
      const { tasks } = await state();
      const byId = new Map(tasks.map((task) => [task.id, task]));
      return tasks.filter(
        (task) =>
          task.state === "planned" &&
          task.dependsOn.every((id) => {
            const dependency = byId.get(id);
            return dependency !== undefined && DONE.has(dependency.state);
          }),
      );
    },
  };
}

function taskIn(state: ProjectState, taskId: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new LedgerRuleError("unknown-task", `No task ${taskId}`);
  return task;
}

function found<T extends { readonly id: string }>(items: readonly T[], id: string | undefined): T {
  const item = items.find((candidate) => candidate.id === id);
  // The entry was just written or was already there, so its task or run exists.
  if (!item) throw new Error(`Ledger entry for ${id} did not replay`);
  return item;
}
