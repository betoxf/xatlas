import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepTaskId } from "../../src/board/index.js";
import { openLedger, openProject, type Ledger, type Project } from "../../src/tasks/index.js";
import type { LedgerData, LedgerEntry, ModelChoice } from "../../src/types.js";

export const projectKey = "/work/xatlas";
export const opus = { agent: "claude", model: "opus", effort: "high" } as const;
export const sol = { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true } as const;

export interface StepInput {
  readonly key: string;
  readonly title?: string;
  readonly dependsOn?: readonly string[];
  readonly owns?: readonly string[];
}

/** A real ledger in a temporary folder, written through the tasks engine. */
export interface Board {
  readonly project: Project;
  entries(): Promise<readonly LedgerEntry[]>;
  /** Creates the job and its steps (planned), each step's id `<jobId>.<key>`. */
  job(jobId: string, steps: readonly StepInput[]): Promise<void>;
  executor(
    taskId: string,
    runId: string,
    details?: { branch?: string; conversationId?: string; choice?: ModelChoice },
  ): Promise<void>;
  /**
   * Moves the step to in_review and records a review of `runId`. A "findings" review given no
   * findings holds one blocker, so it fails.
   */
  review(
    taskId: string,
    runId: string,
    verdict: "pass" | "findings",
    commit: string,
    extra?: Partial<LedgerData["review.decided"]>,
  ): Promise<void>;
  /** A review with no findings, then the step moves to queued, as the loop does on a pass. */
  passed(taskId: string, runId: string, commit: string, round?: number): Promise<void>;
  note(data: LedgerData["note"], taskId?: string): Promise<void>;
  plan(jobId: string, plan: string, winner?: string): Promise<void>;
  close(): Promise<void>;
}

export async function openBoard(): Promise<Board> {
  const dataDir = await mkdtemp(join(tmpdir(), "xatlas-board-"));
  let tick = 0;
  let id = 0;
  const ledger: Ledger = openLedger({
    dataDir,
    now: () => new Date(Date.UTC(2026, 10, 15, 9, 0, tick++)),
    newId: () => `id-${++id}`,
  });
  const project = openProject(ledger, projectKey);
  const board: Board = {
    project,
    entries: () => ledger.read(projectKey),
    async job(jobId, steps) {
      await project.createTask({
        id: jobId,
        title: `Job ${jobId}`,
        brief: "The whole job",
        route: "orchestrated",
      });
      for (const step of steps) {
        const taskId = stepTaskId(jobId, step.key);
        await project.createTask({
          id: taskId,
          title: step.title ?? `Step ${step.key}`,
          brief: `Build ${step.key}`,
          route: "orchestrated",
          parentId: jobId,
          dependsOn: (step.dependsOn ?? []).map((key) => stepTaskId(jobId, key)),
          owns: step.owns ?? [`packages/${step.key}`],
        });
        await project.moveTask(taskId, "planned");
      }
    },
    async executor(taskId, runId, details = {}) {
      const { choice = opus, ...rest } = details;
      await project.startRun({ id: runId, taskId, role: "executor", choice, ...rest });
      await project.moveTask(taskId, "working");
    },
    async review(taskId, runId, verdict, commit, extra = {}) {
      const { tasks } = await project.state();
      if (tasks.find((task) => task.id === taskId)?.state === "working") {
        await project.moveTask(taskId, "in_review");
      }
      await project.record({
        kind: "review.decided",
        taskId,
        runId,
        data: {
          round: 1,
          verdict,
          commit,
          lenses: ["reuse"],
          findings:
            verdict === "findings"
              ? [{ id: `f-${commit}`, severity: "blocker", text: "Wrong" }]
              : [],
          ...extra,
        },
      });
    },
    async passed(taskId, runId, commit, round = 1) {
      await board.review(taskId, runId, "pass", commit, { round });
      await project.moveTask(taskId, "queued");
    },
    async note(data, taskId) {
      await project.record({ kind: "note", data, ...(taskId === undefined ? {} : { taskId }) });
    },
    async plan(jobId, plan, winner) {
      await project.record({
        kind: "parliament.decided",
        taskId: jobId,
        data: { seats: [opus], plan, ...(winner === undefined ? {} : { winner }) },
      });
    },
    close: () => rm(dataDir, { recursive: true, force: true }),
  };
  return board;
}

export function words(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** `count` distinct words: "w1 w2 w3…". */
export function lorem(count: number, prefix = "w"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(" ");
}

/**
 * The entries with one more appended as is, past the ledger's own checks: for entries the
 * ledger may refuse to write, such as a "pass" that holds a blocker.
 */
export function withEntry(
  entries: readonly LedgerEntry[],
  entry: Omit<Extract<LedgerEntry, { kind: "review.decided" }>, "seq" | "at" | "projectKey">,
): LedgerEntry[] {
  const seq = entries.length + 1;
  return [
    ...entries,
    { ...entry, seq, at: new Date(Date.UTC(2026, 10, 16, 0, 0, seq)).toISOString(), projectKey },
  ];
}
