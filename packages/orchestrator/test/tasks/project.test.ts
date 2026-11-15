import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEntry, TaskState } from "../../src/types.js";
import {
  LedgerRuleError,
  ledgerPath,
  openLedger,
  openProject,
  replay,
  type Ledger,
  type Project,
} from "../../src/tasks/index.js";

const projectKey = "/work/xatlas";
const opus = { agent: "claude", model: "opus", effort: "high" } as const;
const sol = { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true } as const;

let dataDir: string;
let ledger: Ledger;
let project: Project;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "xatlas-project-"));
  let tick = 0;
  let id = 0;
  ledger = openLedger({
    dataDir,
    now: () => new Date(Date.UTC(2026, 10, 15, 9, 0, tick++)),
    newId: () => `id-${++id}`,
  });
  project = openProject(ledger, projectKey);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const time = (second: number) => new Date(Date.UTC(2026, 10, 15, 9, 0, second)).toISOString();
const bytes = () => readFile(ledgerPath(dataDir, projectKey));

/** Runs `attempt`, expects it to throw a rule error with `code`, and checks the file didn't change. */
async function expectRefused(attempt: () => Promise<unknown>, code: LedgerRuleError["code"]) {
  const before = await bytes();
  const error = await attempt().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(LedgerRuleError);
  expect(error).toMatchObject({ code });
  expect(await bytes()).toEqual(before);
}

async function moveThrough(taskId: string, states: readonly TaskState[]) {
  for (const state of states) await project.moveTask(taskId, state);
}

describe("project", () => {
  it("replays a full task life with its runs", async () => {
    const task = await project.createTask({
      title: "Add dark mode",
      brief: "A theme switch in settings; done when every screen follows it.",
      route: "orchestrated",
      owns: ["packages/ui/src/theme"],
    });
    await project.moveTask(task.id, "planned");
    await project.moveTask(task.id, "working");
    const executor = await project.startRun({
      taskId: task.id,
      role: "executor",
      choice: opus,
      account: "Max",
      worktreePath: "/worktrees/dark-mode",
      branch: "xatlas/task/claude-run",
    });
    await project.updateRun(executor.id, { state: "working", conversationId: "conv-1" });
    await project.updateRun(executor.id, { state: "done" });
    await project.moveTask(task.id, "in_review");
    const reviewer = await project.startRun({ taskId: task.id, role: "reviewer", choice: sol });
    await project.updateRun(reviewer.id, { state: "working" });
    await project.updateRun(reviewer.id, { state: "done", reason: "two findings" });
    await project.moveTask(task.id, "working", "review findings");
    const fix = await project.startRun({ taskId: task.id, role: "executor", choice: opus });
    await project.updateRun(fix.id, { state: "working" });
    await project.updateRun(fix.id, { state: "waiting" });
    await project.updateRun(fix.id, { state: "working" });
    await project.updateRun(fix.id, { state: "done" });
    await project.moveTask(task.id, "in_review");
    await project.moveTask(task.id, "queued");
    const merged = await project.moveTask(task.id, "merged");

    const entries = await ledger.read(projectKey);
    expect(entries).toHaveLength(19);
    const state = replay(entries);
    expect(await project.state()).toEqual(state);
    expect(state.seq).toBe(19);
    expect(state.tasks).toEqual([
      {
        id: task.id,
        projectKey,
        title: "Add dark mode",
        brief: "A theme switch in settings; done when every screen follows it.",
        state: "merged",
        route: "orchestrated",
        dependsOn: [],
        owns: ["packages/ui/src/theme"],
        createdAt: time(0),
        updatedAt: time(18),
      },
    ]);
    expect(merged).toEqual(state.tasks[0]);
    expect(state.runs).toEqual([
      {
        id: executor.id,
        taskId: task.id,
        role: "executor",
        choice: opus,
        state: "done",
        account: "Max",
        conversationId: "conv-1",
        worktreePath: "/worktrees/dark-mode",
        branch: "xatlas/task/claude-run",
        startedAt: time(3),
        endedAt: time(5),
      },
      {
        id: reviewer.id,
        taskId: task.id,
        role: "reviewer",
        choice: sol,
        state: "done",
        startedAt: time(7),
        endedAt: time(9),
      },
      {
        id: fix.id,
        taskId: task.id,
        role: "executor",
        choice: opus,
        state: "done",
        startedAt: time(11),
        endedAt: time(15),
      },
    ]);
    expect(
      entries.filter((entry) => entry.kind === "task.moved").map((entry) => entry.data.to),
    ).toEqual(["planned", "working", "in_review", "working", "in_review", "queued", "merged"]);
  });

  it("starts a task as an idea and returns each run as it now is", async () => {
    const task = await project.createTask({ title: "t", brief: "b", route: "direct" });
    expect(task.state).toBe("idea");
    const run = await project.startRun({ taskId: task.id, role: "executor", choice: opus });
    expect(run).toMatchObject({ state: "starting", startedAt: time(1) });
    expect(run.endedAt).toBeUndefined();
    const stopped = await project.updateRun(run.id, {
      state: "stopped",
      reason: "the person stopped it",
    });
    expect(stopped).toMatchObject({ state: "stopped", endedAt: time(2) });
  });

  it("gives one winner and one clear error when two callers make the same move", async () => {
    const task = await project.createTask({ title: "t", brief: "b", route: "direct" });
    await project.moveTask(task.id, "planned");
    const other = openProject(openLedger({ dataDir }), projectKey);

    const results = await Promise.allSettled([
      project.moveTask(task.id, "working"),
      other.moveTask(task.id, "working"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected");
    expect(lost?.reason).toBeInstanceOf(LedgerRuleError);
    expect(lost?.reason).toMatchObject({ code: "illegal-move" });
    expect(String(lost?.reason.message)).toContain("is working");
    expect(
      (await ledger.read(projectKey)).filter((entry) => entry.kind === "task.moved"),
    ).toHaveLength(2);
  });

  it("returns the existing task or run when created again with the same id", async () => {
    const task = await project.createTask({
      id: "t1",
      title: "first",
      brief: "b",
      route: "direct",
    });
    const run = await project.startRun({ id: "r1", taskId: "t1", role: "executor", choice: opus });
    const before = await bytes();

    expect(
      await project.createTask({ id: "t1", title: "second", brief: "x", route: "orchestrated" }),
    ).toEqual(task);
    expect(
      await project.startRun({ id: "r1", taskId: "t1", role: "reviewer", choice: sol }),
    ).toEqual(run);
    expect(await bytes()).toEqual(before);
    expect((await project.state()).tasks).toHaveLength(1);
  });

  it("refuses illegal moves and unknown tasks or runs, and writes nothing", async () => {
    const task = await project.createTask({ id: "t1", title: "t", brief: "b", route: "direct" });
    const run = await project.startRun({
      id: "r1",
      taskId: task.id,
      role: "executor",
      choice: opus,
    });

    await expectRefused(() => project.moveTask(task.id, "merged"), "illegal-move");
    await expectRefused(() => project.moveTask(task.id, "idea"), "illegal-move");
    await expectRefused(() => project.moveTask("nope", "planned"), "unknown-task");
    await expectRefused(
      () => project.rerouteTask("nope", "orchestrated", "bigger"),
      "unknown-task",
    );
    await expectRefused(() => project.rerouteTask(task.id, "direct", "same"), "illegal-move");
    await expectRefused(
      () => project.startRun({ taskId: "nope", role: "executor", choice: opus }),
      "unknown-task",
    );
    await expectRefused(() => project.updateRun("nope", { state: "working" }), "unknown-run");
    await expectRefused(() => project.updateRun(run.id, { state: "done" }), "illegal-move");
    await expectRefused(
      () => project.createTask({ title: "t", brief: "b", route: "direct", parentId: "nope" }),
      "unknown-task",
    );
    await expectRefused(
      () => project.record({ kind: "note", taskId: "nope", data: { from: "person", text: "hi" } }),
      "unknown-task",
    );
    await expectRefused(
      () =>
        project.record({
          kind: "task.created",
          taskId: "t1",
          data: { title: "t", brief: "b", route: "direct" },
        }),
      "task-exists",
    );
    await expectRefused(
      () =>
        project.record({
          kind: "run.started",
          taskId: "t1",
          runId: "r1",
          data: { role: "executor", choice: opus },
        }),
      "run-exists",
    );
    // `record` passes the same rules as the commands: a stale `from` is refused.
    await expectRefused(
      () =>
        project.record({
          kind: "task.moved",
          taskId: "t1",
          data: { from: "planned", to: "working" },
        }),
      "illegal-move",
    );

    const other = await project.createTask({ id: "t2", title: "t", brief: "b", route: "direct" });
    await expectRefused(
      () =>
        project.record({
          kind: "run.updated",
          taskId: other.id,
          runId: run.id,
          data: { state: "working" },
        }),
      "wrong-task",
    );

    await project.updateRun(run.id, { state: "failed" });
    await expectRefused(() => project.updateRun(run.id, { state: "working" }), "run-ended");
    await expectRefused(() => project.updateRun(run.id, { branch: "late" }), "run-ended");
  });

  it("can't cancel a task once it is merged, deployed or checked", async () => {
    const task = await project.createTask({ title: "t", brief: "b", route: "direct" });
    await moveThrough(task.id, ["working", "in_review", "queued", "merged"]);
    await expectRefused(() => project.moveTask(task.id, "cancelled"), "illegal-move");
    await expectRefused(() => project.moveTask(task.id, "working"), "illegal-move");
    await project.moveTask(task.id, "deployed");
    await expectRefused(() => project.moveTask(task.id, "cancelled"), "illegal-move");
    await project.moveTask(task.id, "checked");
    await expectRefused(() => project.moveTask(task.id, "cancelled"), "illegal-move");
  });

  it("takes no new runs and no reroute once a task is closed", async () => {
    const cancelled = await project.createTask({ title: "t", brief: "b", route: "direct" });
    await project.moveTask(cancelled.id, "cancelled");
    await expectRefused(
      () => project.startRun({ taskId: cancelled.id, role: "executor", choice: opus }),
      "task-closed",
    );
    await expectRefused(
      () => project.rerouteTask(cancelled.id, "orchestrated", "late"),
      "task-closed",
    );
  });

  it("reroutes a direct job that turned out bigger", async () => {
    const task = await project.createTask({ title: "t", brief: "b", route: "direct" });
    const rerouted = await project.rerouteTask(task.id, "orchestrated", "touches three packages");

    expect(rerouted.route).toBe("orchestrated");
    const last = (await ledger.read(projectKey)).at(-1) as LedgerEntry;
    expect(last).toMatchObject({
      kind: "task.rerouted",
      data: { from: "direct", to: "orchestrated", reason: "touches three packages" },
    });
  });

  it("records triage, parliament and division entries next to the tasks", async () => {
    const task = await project.createTask({ title: "t", brief: "b", route: "orchestrated" });
    await project.record({
      kind: "triage.decided",
      data: {
        decision: { route: "orchestrated", reason: "big", confident: true },
        preference: "auto",
      },
    });
    await project.record({
      kind: "parliament.decided",
      taskId: task.id,
      data: { seats: [], plan: "Plan" },
    });
    const division = await project.record({
      kind: "plan.divided",
      taskId: task.id,
      data: { steps: [{ key: "api", title: "API", brief: "b", dependsOn: [], owns: ["api"] }] },
    });

    expect(division).toMatchObject({ seq: 4, projectKey, taskId: task.id });
    expect((await project.state()).tasks).toHaveLength(1);
  });

  it("gives planned tasks whose dependencies are all merged, deployed or checked", async () => {
    const api = await project.createTask({ id: "api", title: "API", brief: "b", route: "direct" });
    const ui = await project.createTask({
      id: "ui",
      title: "UI",
      brief: "b",
      route: "direct",
      dependsOn: ["api"],
    });
    const docs = await project.createTask({
      id: "docs",
      title: "Docs",
      brief: "b",
      route: "direct",
      dependsOn: ["api", "ui"],
    });
    // A dependency that doesn't exist yet keeps the task waiting.
    const later = await project.createTask({
      id: "later",
      title: "Later",
      brief: "b",
      route: "direct",
      dependsOn: ["not-yet"],
    });
    await project.createTask({ id: "idea", title: "Just an idea", brief: "b", route: "direct" });
    for (const task of [api, ui, docs, later]) await project.moveTask(task.id, "planned");

    const ids = async () => (await project.readyTasks()).map((task) => task.id);
    expect(await ids()).toEqual(["api"]);

    await moveThrough("api", ["working", "in_review", "queued"]);
    expect(await ids()).toEqual([]);
    await project.moveTask("api", "merged");
    expect(await ids()).toEqual(["ui"]);

    await moveThrough("ui", ["working", "in_review", "queued", "merged", "deployed", "checked"]);
    expect(await ids()).toEqual(["docs"]);

    await project.createTask({ id: "not-yet", title: "Now", brief: "b", route: "direct" });
    expect(await ids()).toEqual(["docs"]);
    await moveThrough("not-yet", ["working", "cancelled"]);
    expect(await ids()).toEqual(["docs"]);
  });

  it("counts a dependency ready only once merged, never when cancelled", async () => {
    await project.createTask({ id: "a", title: "A", brief: "b", route: "direct" });
    await project.createTask({
      id: "b",
      title: "B",
      brief: "b",
      route: "direct",
      dependsOn: ["a"],
    });
    await project.moveTask("b", "planned");
    await project.moveTask("a", "cancelled");

    expect(await project.readyTasks()).toEqual([]);
  });
});
