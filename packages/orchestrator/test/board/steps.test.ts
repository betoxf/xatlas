import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobSteps, stepTaskId, stepsToStart } from "../../src/board/index.js";
import { openBoard, opus, sol, withEntry, type Board } from "./fixture.js";

let board: Board;
beforeEach(async () => {
  board = await openBoard();
});
afterEach(async () => {
  await board.close();
});

const ready = async (jobId = "job") => stepsToStart(await board.entries(), jobId);

describe("stepTaskId", () => {
  it("joins the job and the key with a dot", () => {
    expect(stepTaskId("job-7", "settings-ui")).toBe("job-7.settings-ui");
  });
});

describe("stepsToStart", () => {
  it("starts a step that waits on nothing from the project's current commit", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui", dependsOn: ["api"] }]);
    expect(await ready()).toEqual([{ taskId: "job.api", startFrom: null, mergeIn: [] }]);
  });

  it("starts a job with one step", async () => {
    await board.job("job", [{ key: "only" }]);
    expect(await ready()).toEqual([{ taskId: "job.only", startFrom: null, mergeIn: [] }]);
  });

  it("leaves out steps that have a run, are not planned, or belong to another job", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui" }, { key: "docs" }]);
    await board.job("other", [{ key: "api" }]);
    await board.executor("job.api", "run-api");
    await board.project.moveTask("job.docs", "cancelled");
    expect((await ready()).map((step) => step.taskId)).toEqual(["job.ui"]);
  });

  it("leaves out a step whose run has ended without moving it", async () => {
    await board.job("job", [{ key: "api" }]);
    await board.project.startRun({
      id: "run-1",
      taskId: "job.api",
      role: "executor",
      choice: opus,
    });
    await board.project.updateRun("run-1", { state: "failed" });
    expect(await ready()).toEqual([]);
  });

  it("waits for one dependency to pass review and be queued, and starts from its reviewed commit", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui", dependsOn: ["api"] }]);
    await board.executor("job.api", "run-api");
    expect(await ready()).toEqual([]);
    await board.review("job.api", "run-api", "findings", "c1");
    expect(await ready()).toEqual([]);
    await board.project.moveTask("job.api", "working");
    await board.review("job.api", "run-api", "pass", "c2", { round: 2 });
    // Passed but still in_review: the loop has not queued it yet.
    expect(await ready()).toEqual([]);
    await board.project.moveTask("job.api", "queued");
    expect(await ready()).toEqual([{ taskId: "job.ui", startFrom: "c2", mergeIn: [] }]);
  });

  it("counts a dependency that is merged, deployed or checked", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui", dependsOn: ["api"] }]);
    await board.executor("job.api", "run-api");
    await board.passed("job.api", "run-api", "c1");
    for (const state of ["merged", "deployed", "checked"] as const) {
      await board.project.moveTask("job.api", state);
      expect(await ready()).toEqual([{ taskId: "job.ui", startFrom: "c1", mergeIn: [] }]);
    }
  });

  it("goes by the latest review: a pass followed by findings blocks again", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui", dependsOn: ["api"] }]);
    await board.executor("job.api", "run-api");
    await board.passed("job.api", "run-api", "c1");
    expect(await ready()).toHaveLength(1);
    await board.review("job.api", "run-api", "findings", "c2", { round: 2 });
    expect(await ready()).toEqual([]);
  });

  it("ignores a pass of a run that a newer executor run replaced", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui", dependsOn: ["api"] }]);
    await board.executor("job.api", "run-1");
    await board.passed("job.api", "run-1", "sha-old");
    expect(await ready()).toEqual([{ taskId: "job.ui", startFrom: "sha-old", mergeIn: [] }]);

    // Sent back and given to another executor: the old pass no longer counts.
    await board.project.moveTask("job.api", "working");
    await board.project.updateRun("run-1", { state: "stopped" });
    await board.project.startRun({ id: "run-2", taskId: "job.api", role: "executor", choice: sol });
    expect(await ready()).toEqual([]);
    // Queued again without a review of the new run: still not.
    await board.project.moveTask("job.api", "in_review");
    await board.project.moveTask("job.api", "queued");
    expect(await ready()).toEqual([]);

    await board.review("job.api", "run-2", "pass", "sha-new");
    expect(await ready()).toEqual([{ taskId: "job.ui", startFrom: "sha-new", mergeIn: [] }]);
  });

  it("judges a review by its findings: no blocker passes, whatever the verdict word", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui", dependsOn: ["api"] }]);
    await board.executor("job.api", "run-api");
    await board.review("job.api", "run-api", "findings", "c1", {
      findings: [
        { id: "f1", severity: "should-fix", text: "Rename it" },
        { id: "f2", severity: "note", text: "Nice" },
      ],
    });
    await board.project.moveTask("job.api", "queued");
    expect(await ready()).toEqual([{ taskId: "job.ui", startFrom: "c1", mergeIn: [] }]);

    // A "pass" that holds a blocker does not pass (written past the ledger's checks).
    const entries = withEntry(await board.entries(), {
      id: "raw-pass",
      kind: "review.decided",
      taskId: "job.api",
      runId: "run-api",
      data: {
        round: 2,
        verdict: "pass",
        commit: "c2",
        lenses: [],
        findings: [{ id: "f3", severity: "blocker", text: "Broken" }],
      },
    });
    expect(stepsToStart(entries, "job")).toEqual([]);
  });

  it("with several dependencies, starts from the first and merges the others in their order", async () => {
    await board.job("job", [
      { key: "a" },
      { key: "b" },
      { key: "c" },
      { key: "top", dependsOn: ["c", "a", "b"] },
    ]);
    for (const key of ["a", "b", "c"]) await board.executor(`job.${key}`, `run-${key}`);
    await board.passed("job.a", "run-a", "sha-a");
    await board.passed("job.c", "run-c", "sha-c");
    expect(await ready()).toEqual([]);
    await board.review("job.b", "run-b", "findings", "sha-b1");
    expect(await ready()).toEqual([]);
    await board.project.moveTask("job.b", "working");
    await board.passed("job.b", "run-b", "sha-b2", 2);
    expect(await ready()).toEqual([
      { taskId: "job.top", startFrom: "sha-c", mergeIn: ["sha-a", "sha-b2"] },
    ]);
  });

  it("never lets a cancelled dependency unblock anything, even one that passed review", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui", dependsOn: ["api"] }]);
    await board.executor("job.api", "run-api");
    await board.passed("job.api", "run-api", "c1");
    expect(await ready()).toHaveLength(1);
    await board.project.moveTask("job.api", "cancelled");
    expect(await ready()).toEqual([]);
  });

  it("blocks a step that waits on a task that does not exist", async () => {
    await board.project.createTask({ id: "job", title: "Job", brief: "b", route: "orchestrated" });
    await board.project.createTask({
      id: "job.ui",
      title: "UI",
      brief: "b",
      route: "orchestrated",
      parentId: "job",
      dependsOn: ["job.missing"],
    });
    await board.project.moveTask("job.ui", "planned");
    expect(await ready()).toEqual([]);
  });

  it("returns nothing for a job with no steps or no such job", async () => {
    await board.job("job", []);
    expect(await ready()).toEqual([]);
    expect(await ready("nope")).toEqual([]);
  });
});

describe("jobSteps", () => {
  it("gives each step its latest executor run, latest review and flags, in creation order", async () => {
    await board.job("job", [
      { key: "api", owns: ["packages/api"] },
      { key: "ui", dependsOn: ["api"] },
    ]);
    await board.job("other", [{ key: "x" }]);
    await board.executor("job.api", "run-1", { branch: "xatlas/job.api/claude-run-1" });
    await board.project.updateRun("run-1", { state: "failed" });
    await board.project.startRun({
      id: "run-2",
      taskId: "job.api",
      role: "executor",
      choice: sol,
      conversationId: "conv-exec",
      branch: "xatlas/job.api/codex-run-2",
    });
    await board.project.startRun({
      id: "rev-1",
      taskId: "job.api",
      role: "reviewer",
      choice: opus,
      conversationId: "conv-review",
    });
    await board.project.record({
      kind: "oversight.flagged",
      taskId: "job.api",
      runId: "run-2",
      data: { check: "no-commit", action: "flagged", detail: "Nothing committed" },
    });
    await board.review("job.api", "run-2", "findings", "c1", {
      reviewerRunId: "rev-1",
      findings: [{ id: "f1", severity: "blocker", text: "Broken" }],
    });
    await board.project.record({
      kind: "oversight.flagged",
      taskId: "job.api",
      runId: "run-2",
      data: {
        check: "outside-owns",
        action: "paused",
        detail: "Changed a file it does not own",
        paths: ["README.md"],
      },
    });
    await board.executor("other.x", "run-x");
    await board.project.record({
      kind: "oversight.flagged",
      taskId: "other.x",
      runId: "run-x",
      data: { check: "no-commit", action: "flagged", detail: "Another job's step" },
    });

    const steps = jobSteps(await board.entries(), "job");
    expect(steps.map((step) => step.taskId)).toEqual(["job.api", "job.ui"]);
    const [api, ui] = steps;
    expect(api).toMatchObject({
      title: "Step api",
      brief: "Build api",
      state: "in_review",
      owns: ["packages/api"],
      dependsOn: [],
      run: {
        runId: "run-2",
        choice: sol,
        state: "starting",
        conversationId: "conv-exec",
        branch: "xatlas/job.api/codex-run-2",
      },
      review: {
        runId: "run-2",
        round: 1,
        verdict: "findings",
        commit: "c1",
        lenses: ["reuse"],
        findings: [{ id: "f1", severity: "blocker", text: "Broken" }],
        reviewerRunId: "rev-1",
        conversationId: "conv-review",
      },
    });
    expect(api?.flags.map((flag) => [flag.check, flag.action, flag.runId])).toEqual([
      ["no-commit", "flagged", "run-2"],
      ["outside-owns", "paused", "run-2"],
    ]);
    expect(api?.flags[1]?.paths).toEqual(["README.md"]);
    expect((api?.flags[0]?.at ?? "") < (api?.flags[1]?.at ?? "")).toBe(true);
    expect(ui).toEqual({
      taskId: "job.ui",
      title: "Step ui",
      brief: "Build ui",
      state: "planned",
      owns: ["packages/ui"],
      dependsOn: ["job.api"],
      flags: [],
    });
  });

  it("reports the verdict its findings give, not the word the review used", async () => {
    await board.job("job", [{ key: "api" }]);
    await board.executor("job.api", "run-api");
    await board.review("job.api", "run-api", "findings", "c1", {
      findings: [{ id: "f1", severity: "note", text: "Fine" }],
    });
    expect(jobSteps(await board.entries(), "job")[0]?.review?.verdict).toBe("pass");
    const entries = withEntry(await board.entries(), {
      id: "raw-pass",
      kind: "review.decided",
      taskId: "job.api",
      runId: "run-api",
      data: {
        round: 2,
        verdict: "pass",
        commit: "c2",
        lenses: [],
        findings: [{ id: "f2", severity: "blocker", text: "Broken" }],
      },
    });
    expect(jobSteps(entries, "job")[0]?.review).toMatchObject({
      verdict: "findings",
      commit: "c2",
    });
  });

  it("shows a job with one step and no runs", async () => {
    await board.job("job", [{ key: "only" }]);
    const steps = jobSteps(await board.entries(), "job");
    expect(steps).toHaveLength(1);
    expect(steps[0]).not.toHaveProperty("run");
    expect(steps[0]).not.toHaveProperty("review");
  });

  it("leaves the reviewer conversation out when the review names no reviewer run", async () => {
    await board.job("job", [{ key: "api" }]);
    await board.executor("job.api", "run-1", { conversationId: "conv-exec" });
    await board.review("job.api", "run-1", "pass", "c1");
    const [api] = jobSteps(await board.entries(), "job");
    expect(api?.review).toMatchObject({ verdict: "pass", commit: "c1" });
    expect(api?.review).not.toHaveProperty("conversationId");
  });
});
