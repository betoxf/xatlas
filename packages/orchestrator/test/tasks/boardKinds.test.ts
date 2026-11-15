import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ROLES, MAX_REVIEW_ROUNDS, type LedgerDraft } from "../../src/types.js";
import { LedgerRuleError, openLedger, replay, type Ledger } from "../../src/tasks/index.js";

const projectKey = "/work/xatlas";
const opus = { agent: "claude", model: "opus", effort: "high" } as const;

let dataDir: string;
let ledger: Ledger;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "xatlas-ledger-board-"));
  ledger = openLedger({ dataDir });
  await ledger.append(projectKey, {
    kind: "task.created",
    taskId: "job",
    data: { title: "Job", brief: "Do it", route: "orchestrated" },
  });
  await ledger.append(projectKey, {
    kind: "run.started",
    taskId: "job",
    runId: "run-1",
    data: { role: "executor", choice: opus },
  });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const loose = (draft: Record<string, unknown>) => draft as unknown as LedgerDraft;

async function refused(draft: LedgerDraft) {
  const error = await ledger.append(projectKey, draft).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(LedgerRuleError);
}

const review = {
  kind: "review.decided",
  taskId: "job",
  runId: "run-1",
  data: {
    round: 1,
    verdict: "findings",
    commit: "0123abc",
    lenses: ["reuse"],
    findings: [
      {
        id: "f1",
        severity: "blocker",
        lens: "reuse",
        file: "src/a.ts",
        line: 3,
        text: "Copies b.ts",
      },
    ],
  },
} as const;

describe("the board, oversight and chair entries", () => {
  it("writes and reads back every new kind, and they change no task or run", async () => {
    const before = replay(await ledger.read(projectKey));
    await ledger.append(projectKey, {
      kind: "note",
      data: { from: "run-1", text: "The API moved", to: "job" },
    });
    await ledger.append(projectKey, review);
    await ledger.append(projectKey, {
      kind: "review.decided",
      taskId: "job",
      runId: "run-1",
      data: {
        ...review.data,
        round: 2,
        findings: [{ id: "f2", severity: "blocker", text: "Still copied", repeats: "f1" }],
      },
    });
    await ledger.append(projectKey, {
      kind: "oversight.flagged",
      taskId: "job",
      runId: "run-1",
      data: {
        check: "outside-owns",
        action: "paused",
        detail: "Changed 1 file it does not own",
        paths: ["src/other.ts"],
      },
    });
    await ledger.append(projectKey, {
      kind: "watcher.advised",
      taskId: "job",
      runId: "run-1",
      data: {
        trigger: "repeated-finding",
        advice: "reassign",
        text: "Same finding twice",
        choice: DEFAULT_ROLES.watcher[0]!,
      },
    });
    await ledger.append(projectKey, {
      kind: "chair.ruled",
      taskId: "job",
      runId: "run-1",
      data: {
        trigger: "finding-disputed",
        ruling: "drop",
        text: "The copy is intended",
        chair: "claude:claude-mythos-5-2",
        findingId: "f2",
      },
    });
    await ledger.append(projectKey, {
      kind: "parliament.decided",
      taskId: "job",
      data: {
        seats: DEFAULT_ROLES.parliament,
        plan: "The plan",
        winner: "claude:fable",
        tied: ["claude:fable", "codex:gpt-6-astra"],
        advisors: [
          { choice: DEFAULT_ROLES.advisor.choices[0]!, error: "not signed in" },
          {
            choice: DEFAULT_ROLES.advisor.choices[1]!,
            ranking: ["claude:fable", "codex:gpt-6-astra"],
            reason: "Simpler",
          },
          { choice: DEFAULT_ROLES.advisor.choices[2]!, ranking: ["claude:fable"] },
        ],
        advisorOrder: ["claude:fable", "codex:gpt-6-astra"],
      },
    });
    const entries = await ledger.read(projectKey);
    expect(entries.map((entry) => entry.kind).slice(2)).toEqual([
      "note",
      "review.decided",
      "review.decided",
      "oversight.flagged",
      "watcher.advised",
      "chair.ruled",
      "parliament.decided",
    ]);
    const after = replay(entries);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.runs).toEqual(before.runs);
  });

  it("needs the task and run a verdict is about, and they must exist", async () => {
    await refused(loose({ kind: "review.decided", taskId: "job", data: review.data }));
    await refused({ ...review, runId: "no-such-run" });
    await refused(
      loose({
        kind: "chair.ruled",
        data: { trigger: "final-read", ruling: "pass", text: "ok", chair: "c" },
      }),
    );
  });

  it("refuses values outside the contract", async () => {
    for (const data of [
      { ...review.data, round: 0 },
      { ...review.data, round: MAX_REVIEW_ROUNDS + 1 },
      { ...review.data, verdict: "maybe" },
      { ...review.data, commit: undefined },
      { ...review.data, findings: [{ id: "", severity: "blocker", text: "x" }] },
      { ...review.data, findings: [{ id: "f", severity: "fatal", text: "x" }] },
      { ...review.data, findings: [{ id: "f", severity: "note", text: "x", line: 0 }] },
    ]) {
      await refused(loose({ ...review, data }));
    }
    await refused(
      loose({
        kind: "oversight.flagged",
        taskId: "job",
        runId: "run-1",
        data: { check: "slow", action: "paused", detail: "x" },
      }),
    );
    await refused(
      loose({
        kind: "watcher.advised",
        taskId: "job",
        runId: "run-1",
        data: { trigger: "waiting", advice: "pause", text: "x", choice: opus },
      }),
    );
    await refused(
      loose({
        kind: "chair.ruled",
        taskId: "job",
        data: { trigger: "final-read", ruling: "merge", text: "x", chair: "c" },
      }),
    );
    await refused(loose({ kind: "note", data: { from: "p", text: "x", to: "" } }));
    for (const advisors of [
      [{ choice: { via: "email", model: "m" } }],
      [{ choice: { via: "codex", model: "gpt-6-astra" } }],
      [{ choice: { via: "claude" } }],
      [{ choice: { via: "claude", model: "opus", effort: "huge" } }],
      [{ choice: { via: "claude", model: "opus" }, ranking: "A" }],
      { choice: { via: "claude", model: "opus" } },
    ]) {
      await refused(
        loose({
          kind: "parliament.decided",
          taskId: "job",
          data: { seats: [], plan: "p", advisors },
        }),
      );
    }
    await refused(
      loose({
        kind: "parliament.decided",
        taskId: "job",
        data: { seats: [], plan: "p", advisorOrder: "claude:fable" },
      }),
    );
  });

  it("still reads a decision written with the single advisor of before", async () => {
    await ledger.append(
      projectKey,
      loose({
        kind: "parliament.decided",
        taskId: "job",
        data: {
          seats: [],
          plan: "p",
          advisor: {
            choice: { via: "openrouter", model: "google/gemini-4-argon" },
            ranking: ["x"],
          },
        },
      }),
    );
    expect((await ledger.read(projectKey)).at(-1)?.kind).toBe("parliament.decided");
  });
});

describe("what a verdict and a ruling may name", () => {
  const reviewOf = (data: Record<string, unknown>, runId = "run-1") =>
    loose({ kind: "review.decided", taskId: "job", runId, data: { ...review.data, ...data } });

  it("refuses a pass that holds a blocker, and a findings verdict with none", async () => {
    await refused(reviewOf({ verdict: "pass" }));
    await refused(reviewOf({ verdict: "findings", findings: [] }));
    // A findings verdict may hold only notes, and a pass may hold them too.
    const note = [{ id: "n1", severity: "note", text: "Rename later" }];
    await ledger.append(projectKey, reviewOf({ verdict: "findings", findings: note }));
    await ledger.append(projectKey, reviewOf({ verdict: "pass", findings: note }));
  });

  it("takes a verdict only about an executor's run, by a reviewer's run of the same step", async () => {
    await ledger.append(projectKey, {
      kind: "run.started",
      taskId: "job",
      runId: "reviewer-1",
      data: { role: "reviewer", choice: opus },
    });
    await ledger.append(projectKey, {
      kind: "task.created",
      taskId: "other",
      data: { title: "Other", brief: "b", route: "direct" },
    });
    await ledger.append(projectKey, {
      kind: "run.started",
      taskId: "other",
      runId: "reviewer-other",
      data: { role: "reviewer", choice: opus },
    });
    await ledger.append(projectKey, reviewOf({ reviewerRunId: "reviewer-1" }));
    await refused(reviewOf({ reviewerRunId: "no-such-run" }));
    await refused(reviewOf({ reviewerRunId: "run-1" })); // an executor is not a reviewer
    await refused(reviewOf({ reviewerRunId: "reviewer-other" })); // another task's reviewer
    await refused(reviewOf({}, "reviewer-1")); // the run reviewed must be an executor's
  });

  it("takes a chair's ruling about a run of one of the job's steps, and no other job's", async () => {
    const ruling = (runId: string) =>
      ({
        kind: "chair.ruled",
        taskId: "job",
        runId,
        data: { trigger: "finding-disputed", ruling: "reassign", text: "t", chair: "c" },
      }) as const;
    await ledger.append(projectKey, {
      kind: "task.created",
      taskId: "job.api",
      data: { title: "API", brief: "b", route: "orchestrated", parentId: "job" },
    });
    await ledger.append(projectKey, {
      kind: "run.started",
      taskId: "job.api",
      runId: "run-api",
      data: { role: "executor", choice: opus },
    });
    await ledger.append(projectKey, {
      kind: "task.created",
      taskId: "elsewhere",
      data: { title: "Elsewhere", brief: "b", route: "direct" },
    });
    await ledger.append(projectKey, {
      kind: "run.started",
      taskId: "elsewhere",
      runId: "run-elsewhere",
      data: { role: "executor", choice: opus },
    });
    await ledger.append(projectKey, ruling("run-api"));
    await ledger.append(projectKey, ruling("run-1"));
    await refused(ruling("run-elsewhere"));
    await refused(ruling("no-such-run"));
  });
});

describe("what an advisors' order may claim", () => {
  const seats = ["claude:fable", "codex:gpt-6-astra"];
  const decided = (data: Record<string, unknown>) =>
    loose({
      kind: "parliament.decided",
      taskId: "job",
      data: { seats: DEFAULT_ROLES.parliament, plan: "p", tied: seats, ...data },
    });
  const said = (...rankings: string[][]) =>
    rankings.map((ranking, index) => ({ choice: DEFAULT_ROLES.advisor.choices[index]!, ranking }));

  it("takes the order the advisors' rankings give, with its first seat as the winner", async () => {
    await ledger.append(
      projectKey,
      decided({
        winner: seats[1],
        advisors: said([seats[1]!, seats[0]!], [seats[1]!]),
        advisorOrder: [seats[1], seats[0]],
      }),
    );
  });

  it("refuses a choice the advisors did not make", async () => {
    // One each way and the third failed: the top is still level.
    await refused(
      decided({
        winner: seats[0],
        advisors: [
          ...said([seats[0]!, seats[1]!], [seats[1]!, seats[0]!]),
          { choice: DEFAULT_ROLES.advisor.choices[2]!, error: "offline" },
        ],
        advisorOrder: seats,
      }),
    );
    // The rankings say the other plan.
    await refused(
      decided({ winner: seats[0], advisors: said([seats[1]!, seats[0]!]), advisorOrder: seats }),
    );
    // The winner is not the advisors' first choice.
    await refused(
      decided({
        winner: seats[0],
        advisors: said([seats[1]!, seats[0]!]),
        advisorOrder: [seats[1], seats[0]],
      }),
    );
    // No advisor answered, and no level vote to break.
    await refused(decided({ winner: seats[0], advisorOrder: seats }));
    await refused(
      decided({ winner: seats[0], tied: undefined, advisors: said(seats), advisorOrder: seats }),
    );
  });
});

describe("the advisors' default", () => {
  it("is on: Opus at high effort, a fresh Mythos, then Gemini through OpenRouter", () => {
    expect(DEFAULT_ROLES.advisor).toEqual({
      enabled: true,
      choices: [
        { via: "claude", model: "opus", effort: "high" },
        { via: "claude", model: "claude-mythos-5-2" },
        { via: "openrouter", model: "google/gemini-4-argon" },
      ],
    });
  });
});
