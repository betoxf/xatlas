import { openLedger, openProject } from "@zcode/orchestrator/tasks";
import { DEFAULT_ROLES, type LedgerEntry, type ModelChoice } from "@zcode/orchestrator/types";
import { describe, expect, it } from "vitest";
import type { OrchestratorJobView } from "../src/orchestrator/orchestrator.js";
import { claimJob, claimRun, ClaimRefused } from "../src/orchestrator/loop/guard.js";
import { createOrchestratorService } from "../src/orchestrator/orchestratorService.js";
import {
  createFakeHost,
  findings,
  gitOk,
  makeRepo,
  pass,
  promptKind,
  roundOf,
  until,
  type FakeHostOptions,
  type Script,
} from "./orchestratorFakeHost.js";

const TRIAGE = JSON.stringify({
  route: "orchestrated",
  reason: "A feature.",
  confident: true,
  planBy: "one",
});
const ONE_STEP = JSON.stringify({
  steps: [{ key: "core", title: "Core", brief: "Build the core.", dependsOn: [], owns: ["src"] }],
});

interface Answers {
  chair?: (prompt: string) => string;
  watcher?: (prompt: string) => string;
  finalRead?: string;
  division?: () => string;
  plan?: string;
}

/** A job one model plans, divided into one step that owns `src` (or as `answers.division` says). */
async function oneStepJob(
  host: Omit<FakeHostOptions, "repo" | "ask"> & { answers?: Answers },
  roles = DEFAULT_ROLES,
) {
  const { repo, dataDir } = await makeRepo();
  const answers = host.answers ?? {};
  const asked: Array<{ kind: string; prompt: string; choice: ModelChoice }> = [];
  const fake = createFakeHost({
    repo,
    ...host,
    ask: (choice, prompt) => {
      const kind = promptKind(prompt);
      asked.push({ kind, prompt, choice });
      if (kind === "triage") return TRIAGE;
      if (kind === "plan") return answers.plan ?? "Build the core in src.";
      if (kind === "division") return answers.division ? answers.division() : ONE_STEP;
      if (kind === "final-read") return answers.finalRead ?? '{"ruling": "pass", "text": "Good."}';
      if (kind === "chair" && answers.chair) return answers.chair(prompt);
      if (kind === "watcher" && answers.watcher) return answers.watcher(prompt);
      throw new Error(`unexpected ${kind}`);
    },
  });
  let ids = 0;
  const service = createOrchestratorService({
    dataDir,
    host: fake.host,
    newId: () => `id${String((ids += 1)).padStart(3, "0")}`,
  });
  const project = { projectId: "p1", workspacePath: repo };
  if (roles !== DEFAULT_ROLES) await service.setRoles({ ...project, roles });
  const { jobId } = await service.route({ ...project, text: "Build the core", preference: "auto" });
  const view = async () =>
    (await service.listJobs(project)).jobs.find((job) => job.jobId === jobId)!;
  const settled = (what: string, check?: (job: OrchestratorJobView) => boolean) =>
    until(async () => {
      const current = await view();
      const ok = check
        ? check(current)
        : ["waiting", "done", "stopped", "failed"].includes(current.phase);
      return ok ? current : undefined;
    }, what);
  const ledger = () => openLedger({ dataDir }).read(repo);
  const decide = async (optionId: string) => {
    const current = await view();
    const decision = current.decisions[0]!;
    await service.decide({ ...project, jobId: jobId!, decisionId: decision.id, optionId });
  };
  return {
    repo,
    dataDir,
    fake,
    service,
    project,
    jobId: jobId!,
    view,
    settled,
    ledger,
    asked,
    decide,
  };
}

const commitOnce: Script = async (turn) => {
  if (turn.index === 0) await turn.commit({ "src/core.ts": "export const core = 1;\n" });
  else await turn.commit({ [`src/fix${turn.index}.ts`]: `export const fix = ${turn.index};\n` });
  return { text: `Turn ${turn.index} done.` };
};

function kinds(entries: readonly LedgerEntry[], kind: LedgerEntry["kind"]) {
  return entries.filter((entry) => entry.kind === kind);
}

describe("orchestrator service: review rounds", () => {
  it("sends findings back and passes the fix", async () => {
    const { settled, fake, ledger } = await oneStepJob({
      executor: commitOnce,
      reviewer: (turn) =>
        roundOf(turn.message) === 1
          ? findings([{ text: "core is never exported from the index", file: "src/core.ts" }])
          : pass(),
    });
    const done = await settled("the job to finish");
    expect(done.phase, done.status).toBe("done");
    const sends = fake.of("send");
    const toExecutor = sends.filter((call) => String(call.conversationId).startsWith("exec-"));
    expect(String(toExecutor[0]?.text)).toContain("Review round 1 of 3 of your step found this:");
    expect(String(toExecutor[0]?.text)).toContain("core-r1-1 [blocker]");
    // Round two went to the same reviewer conversation.
    expect(fake.of("startReviewer")).toHaveLength(1);
    expect(sends.some((call) => String(call.conversationId).startsWith("review-"))).toBe(true);
    const reviews = kinds(await ledger(), "review.decided");
    expect(
      reviews.map(
        (entry) => entry.kind === "review.decided" && [entry.data.round, entry.data.verdict],
      ),
    ).toEqual([
      [1, "findings"],
      [2, "pass"],
    ]);
  });

  it("calls the watcher on a repeated finding and the chair after three failed rounds", async () => {
    const { settled, ledger, asked } = await oneStepJob({
      executor: commitOnce,
      reviewer: (turn) => {
        const round = roundOf(turn.message);
        return findings([
          {
            text: "the core still leaks",
            ...(round >= 2 ? { repeats: round === 2 ? "core-r1-1" : "core-r2-1" } : {}),
          },
        ]);
      },
      answers: {
        watcher: () => '{"advice": "note", "text": "Look at how the cache is freed."}',
        chair: () =>
          '{"ruling": "drop", "text": "The leak is in a test helper; not worth holding the step."}',
      },
    });
    const done = await settled("the job to finish");
    expect(done.phase, done.status).toBe("done");
    expect(done.rulings.map((ruling) => [ruling.trigger, ruling.ruling])).toEqual([
      ["round-three-failed", "drop"],
      ["final-read", "pass"],
    ]);
    // The chair is a seat that did not write the plan and is not the executor's agent.
    expect(done.rulings[0]?.chair).toBe("codex:gpt-6-astra");
    expect(done.rulings[0]?.text).toContain('Step "Core":');
    const entries = await ledger();
    expect(kinds(entries, "watcher.advised")).toHaveLength(1);
    expect(done.notes.some((note) => note.from === "watcher")).toBe(true);
    expect(asked.filter((ask) => ask.kind === "watcher")).toHaveLength(1);
    // The drop wrote a passing review, so the step passed.
    expect(done.steps[0]?.review?.verdict).toBe("pass");
  });

  it("sends a dispute to the chair, and a dispute-only turn is not reminded", async () => {
    const { settled, ledger, fake } = await oneStepJob({
      async executor(turn) {
        if (turn.index === 0) {
          await turn.commit({ "src/core.ts": "x\n" });
          return { text: "Done." };
        }
        return { text: "DISPUTE core-r1-1: the helper it names does something else." };
      },
      reviewer: (turn) =>
        roundOf(turn.message) === 1 ? findings([{ text: "use the shared helper" }]) : pass(),
      answers: {
        chair: () =>
          '{"ruling": "drop", "text": "The executor is right.", "findingId": "core-r1-1"}',
      },
    });
    const done = await settled("the job to finish");
    expect(done.phase, done.status).toBe("done");
    expect(done.rulings[0]).toMatchObject({
      trigger: "finding-disputed",
      ruling: "drop",
      findingId: "core-r1-1",
    });
    const entries = await ledger();
    expect(entries.some((entry) => entry.id.startsWith("remind:"))).toBe(false);
    expect(kinds(entries, "oversight.flagged")).toHaveLength(0);
    // Round two was asked to leave the dropped finding out.
    const reviewerSends = fake
      .of("send")
      .filter((call) => String(call.conversationId).startsWith("review-"));
    expect(String(reviewerSends[0]?.text)).not.toContain("core-r1-1");
  });

  it("gives the step to a new executor when the chair rules reassign on a dispute", async () => {
    const { settled, fake, ledger } = await oneStepJob({
      async executor(turn) {
        if (turn.conversation.id !== "exec-1" || turn.index === 0) {
          await turn.commit({ "src/core.ts": `${turn.conversation.id}\n` });
          return { text: "Done." };
        }
        return { text: "DISPUTE core-r1-1: the brief asks for the opposite." };
      },
      reviewer: (turn) =>
        turn.conversation.worktreePath.endsWith("exec-1")
          ? findings([{ text: "invert the flag" }])
          : pass(),
      answers: { chair: () => '{"ruling": "reassign", "text": "This agent misread the brief."}' },
    });
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(fake.of("startExecutor")).toHaveLength(2);
    expect(done.rulings[0]).toMatchObject({ trigger: "finding-disputed", ruling: "reassign" });
    const ruled = (await ledger()).find((entry) => entry.kind === "chair.ruled");
    // The ruling names the run it was about.
    expect(ruled?.runId).toBe(
      (await ledger()).find(
        (entry) => entry.kind === "run.started" && entry.data.role === "executor",
      )?.runId,
    );
    expect(done.steps[0]?.state).toBe("queued");
  });

  it("hands disputes to the person once the chair's rulings are used up", async () => {
    const { settled, ledger, decide, fake } = await oneStepJob({
      async executor(turn) {
        if (turn.index === 0) {
          await turn.commit({ "src/core.ts": "x\n" });
          return { text: "Done." };
        }
        return {
          text: ["DISPUTE core-r1-1: no.", "DISPUTE core-r1-2: no.", "DISPUTE core-r1-3: no."].join(
            "\n",
          ),
        };
      },
      reviewer: (turn) =>
        roundOf(turn.message) === 1
          ? findings([{ text: "one" }, { text: "two" }, { text: "three" }])
          : pass(),
      answers: { chair: () => '{"ruling": "drop", "text": "Agreed."}' },
    });
    const waiting = await settled("the person's turn");
    expect(waiting.phase).toBe("waiting");
    expect(waiting.rulings).toHaveLength(2);
    expect(waiting.decisions[0]).toMatchObject({ kind: "chair", taskId: `${waiting.jobId}.core` });
    expect(waiting.decisions[0]?.question).toContain("core-r1-3");
    expect(waiting.decisions[0]?.question).toContain("no rulings left");
    await decide("drop-finding");
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(done.steps[0]?.state).toBe("queued");
    expect(kinds(await ledger(), "review.decided")).toHaveLength(2);
    // The finding the person dropped is not handed to the next round.
    const roundTwo = fake.of("send").find((call) => roundOf(String(call.text)) === 2);
    expect(String(roundTwo?.text)).not.toContain("core-r1-3");
  });

  it("asks the person when nobody can chair", async () => {
    const roles = {
      ...DEFAULT_ROLES,
      parliament: [{ agent: "claude" as const, model: "opus" }],
      executor: [{ agent: "claude" as const, model: "opus" }],
    };
    const { settled, decide } = await oneStepJob(
      // The same reply every round: the echoed token tells each new reply from the last.
      {
        executor: commitOnce,
        reviewer: () => findings([{ text: "still wrong" }]),
      },
      roles,
    );
    const waiting = await settled("the person's turn");
    expect(waiting.decisions[0]?.kind).toBe("chair");
    expect(waiting.decisions[0]?.question).toContain("Nobody can chair");
    expect(waiting.steps[0]?.review?.round).toBe(3);
    await decide("drop");
    // The final read has nobody either, so the person accepts the work.
    const final = await settled(
      "the final read",
      (job) => job.decisions[0]?.question.includes("final read") ?? false,
    );
    expect(final.decisions[0]?.options.map((option) => option.id)).toEqual(["accept", "stop-job"]);
    await decide("accept");
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(done.steps[0]?.state).toBe("queued");
  });
});

describe("orchestrator service: oversight", () => {
  it("pauses an executor that leaves its files, and resumes it on the person's word", async () => {
    const { settled, decide, ledger } = await oneStepJob({
      async executor(turn) {
        await turn.commit({ "src/core.ts": "x\n", "other/stray.ts": "y\n" });
        return { text: "Done." };
      },
      reviewer: () => pass(),
    });
    const paused = await settled("the pause");
    expect(paused.decisions[0]?.kind).toBe("paused-run");
    expect(paused.decisions[0]?.question).toContain("other/stray.ts");
    expect(paused.steps[0]?.run?.state).toBe("waiting");
    expect(paused.steps[0]?.flags[0]).toMatchObject({ check: "outside-owns", action: "paused" });
    // Two answers at once: one is carried out, the other is refused.
    const answers = await Promise.allSettled([decide("resume"), decide("resume")]);
    expect(answers.map((answer) => answer.status).sort()).toEqual(["fulfilled", "rejected"]);
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(done.steps[0]?.state).toBe("queued");
    // Resumed, the same paths are not flagged again.
    expect(
      kinds(await ledger(), "oversight.flagged").filter(
        (entry) => entry.kind === "oversight.flagged" && entry.data.check === "outside-owns",
      ),
    ).toHaveLength(1);
  });

  it("stops a paused executor's step on the person's word", async () => {
    const { settled, decide, fake } = await oneStepJob({
      async executor(turn) {
        await turn.commit({ "other/stray.ts": "y\n" });
        return { text: "Done." };
      },
    });
    await settled("the pause");
    await decide("stop-step");
    const stuck = await settled(
      "the stuck job",
      (job) => job.decisions[0]?.options[0]?.id === "stop-job",
    );
    expect(stuck.steps[0]?.state).toBe("cancelled");
    expect(stuck.steps[0]?.run?.state).toBe("stopped");
    expect(fake.of("interrupt")).toHaveLength(1);
  });

  it("reminds once about commits without trailers, then reviews", async () => {
    const { settled, fake, ledger } = await oneStepJob({
      async executor(turn) {
        if (turn.index === 0) await turn.commit({ "src/core.ts": "x\n" }, { trailers: false });
        return { text: "Done." };
      },
      reviewer: () => pass(),
    });
    const done = await settled("the job to finish");
    expect(done.phase, done.status).toBe("done");
    const reminders = fake
      .of("send")
      .filter((call) => String(call.text).includes("must end with these lines"));
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]?.text)).toContain("Xatlas-Run: ");
    expect((await ledger()).filter((entry) => entry.id.startsWith("remind:"))).toHaveLength(1);
  });

  it("reminds once about a turn with no commit, then asks the person", async () => {
    const { settled, fake, ledger } = await oneStepJob({
      executor: () => ({ text: "I looked around." }),
    });
    const waiting = await settled("the person's turn");
    expect(waiting.decisions[0]?.question).toContain(
      "without committing anything, even after a reminder",
    );
    expect(
      fake.of("send").filter((call) => String(call.text).includes("nothing committed")),
    ).toHaveLength(1);
    expect(
      kinds(await ledger(), "oversight.flagged").every(
        (entry) => entry.kind === "oversight.flagged" && entry.data.check === "no-commit",
      ),
    ).toBe(true);
  });

  it("makes a run's question the person's, with the watcher's advice on the board, and never sends it", async () => {
    const { settled, asked, fake, decide, view } = await oneStepJob({
      async executor(turn) {
        if (turn.index === 0)
          return { status: "needs_attention", text: "Which file should hold the setting?" };
        await turn.commit({ "src/config.ts": "export const setting = 1;\n" });
        return { text: "Done." };
      },
      reviewer: () => pass(),
      answers: { watcher: () => '{"advice": "note", "text": "Put it in src/config.ts."}' },
    });
    const waiting = await settled("the person's turn");
    expect(asked.filter((ask) => ask.kind === "watcher")).toHaveLength(1);
    // The watcher's answer would queue behind the question, so it is never sent.
    expect(fake.of("send")).toHaveLength(0);
    expect(waiting.decisions[0]?.options.map((option) => option.id)).toEqual([
      "answered",
      "stop-step",
    ]);
    expect(waiting.decisions[0]?.question).toContain("Put it in src/config.ts.");
    expect(
      waiting.notes.some(
        (note) => note.from === "watcher" && note.text === "Put it in src/config.ts.",
      ),
    ).toBe(true);
    // The person answers in the conversation and says so: the same turn goes on and is reviewed.
    fake.answer("exec-1", "Use src/config.ts.");
    await decide("answered");
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(done.steps[0]?.state).toBe("queued");
    expect((await view()).phase).toBe("done");

    const second = await oneStepJob({
      executor: () => ({ status: "needs_attention", text: "May I run npm install?" }),
      answers: { watcher: () => '{"advice": "note", "text": "Yes."}' },
    });
    const permission = await second.settled("the person's turn");
    expect(second.asked.filter((ask) => ask.kind === "watcher")).toHaveLength(0);
    expect(permission.decisions[0]?.question).toContain("for permission");
  });

  it("counts every watcher call against its cap, failed or unreadable ones too", async () => {
    const { settled, asked, fake, decide, ledger } = await oneStepJob({
      executor: (turn) => ({ status: "needs_attention", text: `Question ${turn.index}?` }),
      answers: { watcher: () => "I am not sure." },
    });
    for (let question = 0; question < 3; question += 1) {
      const waiting = await settled(`question ${question}`, (job) => job.decisions.length > 0);
      if (question < 2) {
        fake.answer("exec-1", `Answer ${question}.`);
        await decide("answered");
        await settled(
          "the next question",
          (job) => job.decisions[0]?.id !== waiting.decisions[0]?.id,
        );
      }
    }
    expect(asked.filter((ask) => ask.kind === "watcher")).toHaveLength(2);
    expect(kinds(await ledger(), "watcher.advised")).toHaveLength(0);
  });
});

describe("orchestrator service: failures and stops", () => {
  it("stops a job while the parliament sits, and it never starts a step", async () => {
    const { repo, dataDir } = await makeRepo();
    const fake = createFakeHost({
      repo,
      ask: () =>
        JSON.stringify({
          route: "orchestrated",
          reason: "Big.",
          confident: true,
          planBy: "parliament",
        }),
      deliberate: ({ signal }) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
    });
    const service = createOrchestratorService({ dataDir, host: fake.host });
    const project = { projectId: "p1", workspacePath: repo };
    const { jobId } = await service.route({ ...project, text: "Big job", preference: "auto" });
    await until(() => fake.of("deliberate").length === 1, "the parliament");
    await service.stopJob({ ...project, jobId: jobId! });
    const view = (await service.listJobs(project)).jobs[0]!;
    expect(view.phase).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.of("startExecutor")).toHaveLength(0);
    expect((await service.listJobs(project)).jobs[0]?.decisions).toEqual([]);
  });

  it("stops a working job: its runs are interrupted and its branches stay", async () => {
    const { settled, service, project, jobId, fake, view } = await oneStepJob({
      executor: () => new Promise(() => undefined),
    });
    await settled("the executor", (job) => job.steps[0]?.run?.state === "working");
    await service.stopJob({ ...project, jobId });
    const stopped = await view();
    expect(stopped.phase).toBe("stopped");
    expect(stopped.steps[0]?.state).toBe("cancelled");
    expect(stopped.steps[0]?.run?.state).toBe("stopped");
    expect(stopped.steps[0]?.run?.branch).toBeDefined();
    expect(fake.of("interrupt").map((call) => call.conversationId)).toEqual(["exec-1"]);
  });

  it("asks the person when an executor fails to start, and starts it again on retry", async () => {
    let starts = 0;
    const { settled, decide, fake } = await oneStepJob({
      startExecutor: () => {
        starts += 1;
        if (starts === 1) throw new Error("Claude Code isn't connected in the app");
      },
      executor: commitOnce,
      reviewer: () => pass(),
    });
    const waiting = await settled("the person's turn");
    expect(waiting.decisions[0]?.question).toContain("Claude Code isn't connected in the app");
    expect(waiting.steps[0]?.run?.state).toBe("failed");
    await decide("retry");
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(fake.of("startExecutor")).toHaveLength(2);
    expect(done.steps[0]?.run?.state).toBe("done");
  });

  it("asks the person when nobody can divide the plan", async () => {
    const { settled } = await oneStepJob({
      answers: {
        division: () => {
          throw new Error("signed out");
        },
      },
    });
    const waiting = await settled("the person's turn");
    expect(waiting.decisions[0]?.question).toContain("couldn't be divided");
    expect(waiting.decisions[0]?.options.map((option) => option.id)).toEqual(["retry", "stop-job"]);
  });

  it("carries on from the ledger after a restart without starting a step twice", async () => {
    const first = await oneStepJob({ executor: () => new Promise(() => undefined) });
    const before = await first.settled(
      "the executor",
      (job) => job.steps[0]?.run?.state === "working",
    );

    // A new instance, as after the app restarted: its host can't see the running turn.
    const fake = createFakeHost({ repo: first.repo, knows: () => false });
    // The first instance's process is gone, so this one takes its job over.
    const again = createOrchestratorService({
      dataDir: first.dataDir,
      host: fake.host,
      ownerAlive: () => false,
    });
    const listed = (await again.listJobs(first.project)).jobs;
    expect(listed.map((job) => [job.jobId, job.title])).toEqual([[before.jobId, before.title]]);
    expect(listed[0]?.steps.map((step) => step.taskId)).toEqual(
      before.steps.map((step) => step.taskId),
    );
    const waiting = await until(async () => {
      const job = (await again.listJobs(first.project)).jobs[0];
      return job?.phase === "waiting" ? job : undefined;
    }, "the restart decision");
    expect(waiting.decisions[0]?.question).toContain("lost track");
    expect(waiting.decisions[0]?.options.map((option) => option.id)).toEqual([
      "resume",
      "reassign",
      "stop-step",
    ]);
    expect(waiting.steps[0]?.run?.runId).toBe(before.steps[0]?.run?.runId);
    expect(fake.of("startExecutor")).toHaveLength(0);
    expect(fake.of("waitForTurn")).toHaveLength(0);
  });
});

describe("orchestrator service: the chair's rulings", () => {
  it("gives a stuck step to a new executor when the chair rules reassign", async () => {
    const { settled, fake, view } = await oneStepJob({
      executor: commitOnce,
      reviewer: (turn) =>
        turn.conversation.worktreePath.endsWith("exec-1")
          ? findings([{ text: `wrong (${roundOf(turn.message)})` }])
          : pass(),
      answers: { chair: () => '{"ruling": "reassign", "text": "Another agent should take it."}' },
    });
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(fake.of("startExecutor")).toHaveLength(2);
    expect(fake.of("interrupt").map((call) => call.conversationId)).toContain("exec-1");
    expect(done.steps[0]?.run?.runId).not.toBe(undefined);
    expect(done.rulings[0]).toMatchObject({ trigger: "round-three-failed", ruling: "reassign" });
    // The new run started from the same commit as the first.
    const [first, second] = fake.of("startExecutor");
    expect(second?.ref).toBe(first?.ref);
    expect((await view()).steps[0]?.state).toBe("queued");
  });

  it("divides the rest again when the chair rules redivide", async () => {
    let divisions = 0;
    const { settled, ledger } = await oneStepJob({
      executor: async (turn) => {
        const dir = turn.conversation.title === "Core" ? "src" : "lib";
        await turn.commit({ [`${dir}/f${turn.index}.ts`]: "x\n" });
        return { text: "Done." };
      },
      reviewer: (turn) =>
        turn.conversation.worktreePath.endsWith("exec-1")
          ? findings([{ text: `wrong (${roundOf(turn.message)})` }])
          : pass(),
      answers: {
        division: () => {
          divisions += 1;
          return divisions === 1
            ? ONE_STEP
            : JSON.stringify({
                steps: [
                  {
                    key: "core",
                    title: "Core again",
                    brief: "Smaller.",
                    dependsOn: [],
                    owns: ["lib"],
                  },
                ],
              });
        },
        chair: () => '{"ruling": "redivide", "text": "Split it smaller."}',
      },
    });
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(done.steps.map((step) => [step.title, step.state])).toEqual([
      ["Core", "cancelled"],
      ["Core again", "queued"],
    ]);
    // The reused key got a new task id.
    expect(done.steps[1]?.taskId).toBe(`${done.jobId}.core-2`);
    expect(kinds(await ledger(), "plan.divided")).toHaveLength(2);
  });
});

describe("orchestrator service: ideas beyond the request in a re-division", () => {
  it("keeps the chair's ruling and the rest, drops the ideas, and never shows them to an executor", async () => {
    let divisions = 0;
    const { settled, fake } = await oneStepJob({
      executor: async (turn) => {
        const dir = turn.conversation.title === "Core" ? "src" : "lib";
        await turn.commit({ [`${dir}/f${turn.index}.ts`]: "x\n" });
        return { text: "Done." };
      },
      reviewer: (turn) =>
        turn.conversation.worktreePath.endsWith("exec-1")
          ? findings([{ text: `wrong (${roundOf(turn.message)})` }])
          : pass(),
      answers: {
        plan: "## Steps\n1. Build the core in src.\n## Beyond the request\nMigrate authentication to passkeys.",
        division: () => {
          divisions += 1;
          return divisions === 1
            ? ONE_STEP
            : JSON.stringify({
                steps: [
                  {
                    key: "core",
                    title: "Core again",
                    brief: "Smaller.",
                    dependsOn: [],
                    owns: ["lib"],
                  },
                ],
              });
        },
        chair: () => '{"ruling": "redivide", "text": "Split it smaller."}',
      },
    });
    await settled("the job to finish", (job) => job.phase === "done");
    const divisionPrompts = fake
      .of("ask")
      .map((call) => String(call.prompt))
      .filter((prompt) => promptKind(prompt) === "division");
    expect(divisionPrompts).toHaveLength(2);
    expect(divisionPrompts[1]).toContain("Split it smaller.");
    expect(divisionPrompts[1]).toContain("Divide only the work still to do:");
    expect(divisionPrompts[1]).toContain("1. Build the core in src.");
    for (const prompt of divisionPrompts) expect(prompt).not.toContain("passkeys");
    const toExecutors = [
      ...fake.of("startExecutor").map((call) => String(call.text)),
      ...fake.of("send").map((call) => String(call.text)),
    ];
    expect(toExecutors.join("\n")).toContain("Build the core in src.");
    expect(toExecutors.join("\n")).not.toContain("passkeys");
  });
});

describe("orchestrator service: replies that can't be used", () => {
  it("asks the reviewer once more for a findings verdict with no findings, then tells the person", async () => {
    const { settled, fake } = await oneStepJob({
      executor: commitOnce,
      reviewer: () => ({ text: '{"verdict": "findings", "findings": []}' }),
    });
    const waiting = await settled("the person's turn");
    expect(waiting.decisions[0]?.question).toContain("gave no verdict that could be read, twice");
    const again = fake
      .of("send")
      .filter((call) => String(call.text).includes("could not be read as a review"));
    expect(again).toHaveLength(1);
    expect(waiting.steps[0]?.review).toBeUndefined();
  });

  it("still reads a new reply from a reviewer that doesn't echo the token", async () => {
    // Without the token, only a reply equal to the last one handled is taken as stale.
    const { settled } = await oneStepJob({
      echoToken: false,
      executor: commitOnce,
      reviewer: (turn) => (roundOf(turn.message) === 1 ? findings([{ text: "fix it" }]) : pass()),
    });
    const done = await settled("the job to finish");
    expect(done.phase, done.status).toBe("done");
  });

  it("sends the final read's findings back to the executors, and a reviewer may pass again with the same reply", async () => {
    let reads = 0;
    const { settled, decide, fake } = await oneStepJob({
      executor: commitOnce,
      reviewer: () => pass(),
      answers: {
        get finalRead() {
          reads += 1;
          return reads === 1
            ? '{"ruling": "fix", "text": "The core misses its index file."}'
            : '{"ruling": "pass", "text": "Now it matches."}';
        },
      },
    });
    const waiting = await settled("the final read's decision");
    expect(waiting.decisions[0]?.options.map((option) => option.id)).toEqual(["send", "accept"]);
    await decide("send");
    // The final read happens once: when the steps pass again, the person accepts the work.
    const again = await settled(
      "the person's acceptance",
      (job) => job.decisions[0]?.question.includes("passed review again") ?? false,
    );
    expect(again.decisions[0]?.options.map((option) => option.id)).toEqual(["accept", "stop-job"]);
    await decide("accept");
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(reads).toBe(1);
    expect(done.rulings.map((ruling) => ruling.ruling)).toEqual(["fix"]);
    expect(
      fake.of("send").some((call) => String(call.text).includes("The core misses its index file.")),
    ).toBe(true);
    expect(done.steps[0]?.review?.round).toBe(2);
  });

  it("handles the end of a turn again on retry after git failed", async () => {
    const { rename } = await import("node:fs/promises");
    const { settled, decide, fake } = await oneStepJob({
      async executor(turn) {
        await turn.commit({ "src/core.ts": "x\n" });
        // The worktree's link to its repository disappears, so git fails at the turn's end.
        const path = turn.conversation.worktreePath;
        await rename(`${path}/.git`, `${path}/.git-away`);
        return { text: "Done." };
      },
      reviewer: () => pass(),
    });
    const waiting = await settled("the person's turn");
    expect(waiting.decisions[0]?.question).toContain("Something went wrong");
    expect(waiting.decisions[0]?.options.map((option) => option.id)).toEqual([
      "retry",
      "stop-step",
    ]);
    const path = fake.conversations.get("exec-1")!.worktreePath;
    await rename(`${path}/.git-away`, `${path}/.git`);
    await decide("retry");
    const done = await settled("the job to finish", (job) => job.phase === "done");
    expect(done.steps[0]?.state).toBe("queued");
    // The turn was handled again, not restarted: one executor, no "carry on" message.
    expect(fake.of("startExecutor")).toHaveLength(1);
    expect(fake.of("send").filter((call) => String(call.text).startsWith("Carry on"))).toHaveLength(
      0,
    );
  });
});

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("orchestrator service: two windows, stops and restarts", () => {
  it("lets one instance run a job: another live one only reads it, and a start after a takeover is refused", async () => {
    const hold = gate();
    const first = await oneStepJob({
      async executor(turn) {
        await hold.promise;
        await turn.commit({ "src/core.ts": "x\n" });
        return { text: "Done." };
      },
      reviewer: () => pass(),
    });
    await first.settled("the executor", (job) => job.steps[0]?.run?.state === "working");

    // A second window while the first runs the job: it shows the job and does nothing with it.
    const other = createFakeHost({ repo: first.repo });
    const reader = createOrchestratorService({ dataDir: first.dataDir, host: other.host });
    expect((await reader.listJobs(first.project)).jobs[0]?.jobId).toBe(first.jobId);
    await sleep(150);
    for (const method of [
      "ask",
      "startExecutor",
      "startReviewer",
      "waitForTurn",
      "send",
      "interrupt",
    ]) {
      expect(other.of(method)).toHaveLength(0);
    }
    await expect(
      reader.decide({ ...first.project, jobId: first.jobId, decisionId: "x", optionId: "retry" }),
    ).rejects.toThrow("Another window of the app runs this job");

    // A third finds the owner's process gone and takes the job over.
    const third = createFakeHost({ repo: first.repo, knows: () => false });
    const taker = createOrchestratorService({
      dataDir: first.dataDir,
      host: third.host,
      ownerAlive: () => false,
    });
    await until(async () => (await taker.listJobs(first.project)).jobs[0]?.phase === "waiting");
    // The first instance's turn now ends: the job is no longer its own, so it starts nothing.
    hold.open();
    await until(() => first.fake.conversations.get("exec-1")?.turns === 1, "the first turn's end");
    await sleep(200);
    expect(first.fake.of("startReviewer")).toHaveLength(0);
    expect((await first.ledger()).filter((entry) => entry.kind === "run.started")).toHaveLength(1);
  });

  it("takes a job over on a later poll once its owner is gone", async () => {
    const first = await oneStepJob({ executor: () => new Promise(() => undefined) });
    await first.settled("the executor", (job) => job.steps[0]?.run?.state === "working");
    let alive = true;
    const other = createFakeHost({ repo: first.repo, knows: () => false });
    const reader = createOrchestratorService({
      dataDir: first.dataDir,
      host: other.host,
      ownerAlive: () => alive,
    });
    expect((await reader.listJobs(first.project)).jobs[0]?.phase).toBe("working");
    await sleep(100);
    expect((await reader.listJobs(first.project)).jobs[0]?.phase).toBe("working");
    // The first window closes: the next poll takes the job over.
    alive = false;
    const waiting = await until(async () => {
      const job = (await reader.listJobs(first.project)).jobs[0];
      return job?.phase === "waiting" ? job : undefined;
    }, "the takeover");
    expect(waiting.decisions[0]?.question).toContain("lost track");
    expect(other.of("startExecutor")).toHaveLength(0);
  });

  it("ends a reviewer left starting by a restart, and starts a new one on retry", async () => {
    const first = await oneStepJob({
      executor: commitOnce,
      startReviewer: () => new Promise(() => undefined),
    });
    await until(() => first.fake.of("startReviewer").length === 1, "the reviewer's start");
    const fake = createFakeHost({ repo: first.repo, knows: () => false, reviewer: () => pass() });
    const again = createOrchestratorService({
      dataDir: first.dataDir,
      host: fake.host,
      ownerAlive: () => false,
    });
    const waiting = await until(async () => {
      const job = (await again.listJobs(first.project)).jobs[0];
      return job?.phase === "waiting" ? job : undefined;
    });
    expect(waiting.decisions[0]?.question).toContain("reviewer was starting");
    await again.decide({
      ...first.project,
      jobId: first.jobId,
      decisionId: waiting.decisions[0]!.id,
      optionId: "retry",
    });
    await until(() => fake.of("startReviewer").length === 1, "the new reviewer");
    const reviewers = (await first.ledger()).filter(
      (entry) => entry.kind === "run.started" && entry.data.role === "reviewer",
    );
    expect(reviewers).toHaveLength(2);
  });

  it("starts a step once: the claim is checked inside the ledger's lock, by the job's owner only", async () => {
    const { repo, dataDir } = await makeRepo();
    const ledger = openLedger({ dataDir });
    const project = openProject(ledger, repo);
    await project.createTask({ id: "job1", title: "Job", brief: "b", route: "orchestrated" });
    await project.createTask({
      id: "job1.s",
      title: "S",
      brief: "b",
      route: "orchestrated",
      parentId: "job1",
    });
    await project.moveTask("job1.s", "planned");
    const job = { project: { projectId: "p1", workspacePath: repo }, key: repo, jobId: "job1" };
    const loopOf = (instanceId: string) =>
      ({ ledger, instanceId, ownerAlive: () => true }) as unknown as Parameters<typeof claimRun>[0];
    expect((await claimJob(loopOf("A"), job)).ours).toBe(true);
    expect((await claimJob(loopOf("B"), job)).ours).toBe(false);
    const choice = { agent: "claude" as const };
    await claimRun(loopOf("A"), job, { id: "r1", taskId: "job1.s", role: "executor", choice });
    // A second start of the same step, as a second window would make it, is refused.
    await expect(
      claimRun(loopOf("A"), job, { id: "r2", taskId: "job1.s", role: "executor", choice }),
    ).rejects.toBeInstanceOf(ClaimRefused);
    await expect(
      claimRun(loopOf("B"), job, { id: "r3", taskId: "job1.s", role: "executor", choice }),
    ).rejects.toBeInstanceOf(ClaimRefused);
    expect((await ledger.read(repo)).filter((entry) => entry.kind === "run.started")).toHaveLength(
      1,
    );
  });

  it("keeps a run stoppable when the app refuses to stop it, and tells the person", async () => {
    let refuse = true;
    const job = await oneStepJob({
      executor: () => new Promise(() => undefined),
      interrupt: () => {
        if (refuse) throw new Error("The conversation couldn't be stopped.");
      },
    });
    await job.settled("the executor", (view) => view.steps[0]?.run?.state === "working");
    await expect(job.service.stopJob({ ...job.project, jobId: job.jobId })).rejects.toThrow(
      "refused to stop the executor",
    );
    let view = await job.view();
    expect(view.phase).toBe("stopped");
    expect(view.steps[0]?.run?.state).toBe("working");
    refuse = false;
    await job.service.stopJob({ ...job.project, jobId: job.jobId });
    view = await job.view();
    expect(view.steps[0]?.run?.state).toBe("stopped");
    expect(job.fake.of("interrupt")).toHaveLength(2);
  });

  it("sends nothing to a job stopped while a turn's end was being checked", async () => {
    const hold = gate();
    let checking = false;
    const job = await oneStepJob({
      executor: () => ({ text: "I looked around." }),
      gitHook: async (args) => {
        // The turn-end check's status call: held until the job has been stopped.
        if (args[0] === "status" && args.includes("--no-renames") && !checking) {
          checking = true;
          await hold.promise;
        }
      },
    });
    await until(() => checking, "the turn's check");
    await job.service.stopJob({ ...job.project, jobId: job.jobId });
    hold.open();
    await sleep(200);
    expect(job.fake.of("send")).toHaveLength(0);
    expect((await job.view()).phase).toBe("stopped");
  });

  it("stops the conversation of a run that was still starting before calling its start failed", async () => {
    const first = await oneStepJob({
      executor: () => new Promise(() => undefined),
      gitHook: async (args) => {
        // The worktree is never adopted: the app "stops" with the run still starting.
        if (args[0] === "worktree" && args[1] === "list") await new Promise(() => undefined);
      },
    });
    await until(async () =>
      (await first.ledger()).some(
        (entry) => entry.kind === "run.updated" && entry.data.conversationId,
      ),
    );
    const fake = createFakeHost({ repo: first.repo, knows: () => false });
    const again = createOrchestratorService({
      dataDir: first.dataDir,
      host: fake.host,
      ownerAlive: () => false,
    });
    const waiting = await until(async () => {
      const job = (await again.listJobs(first.project)).jobs[0];
      return job?.phase === "waiting" ? job : undefined;
    });
    expect(fake.of("interrupt").map((call) => call.conversationId)).toEqual(["exec-1"]);
    expect(waiting.steps[0]?.run?.state).toBe("failed");
    expect(fake.of("startExecutor")).toHaveLength(0);
  });

  it("interrupts a reviewer whose conversation was made while the job was being stopped", async () => {
    const hold = gate();
    let starting = false;
    const job = await oneStepJob({
      executor: commitOnce,
      startReviewer: async () => {
        starting = true;
        await hold.promise;
      },
    });
    await until(() => starting, "the reviewer's start");
    await job.service.stopJob({ ...job.project, jobId: job.jobId });
    hold.open();
    await until(
      () =>
        job.fake.of("interrupt").some((call) => String(call.conversationId).startsWith("review-")),
      "the reviewer's interrupt",
    );
  });

  it("writes out the steps of a division saved just before a restart", async () => {
    const { repo, dataDir } = await makeRepo();
    const project = openProject(openLedger({ dataDir }), repo);
    await project.createTask({
      id: "job1",
      title: "Build",
      brief: "Build the core",
      route: "orchestrated",
    });
    await project.record({
      kind: "triage.decided",
      taskId: "job1",
      data: {
        decision: { route: "orchestrated", reason: "Big.", confident: true },
        preference: "auto",
      },
    });
    await project.record({
      kind: "parliament.decided",
      taskId: "job1",
      data: {
        seats: [{ agent: "claude", model: "fable" }],
        plan: "Build it.",
        winner: "claude:fable",
      },
    });
    await project.record({
      kind: "plan.divided",
      taskId: "job1",
      data: {
        steps: [{ key: "core", title: "Core", brief: "Build.", dependsOn: [], owns: ["src"] }],
      },
    });
    const fake = createFakeHost({ repo, executor: () => new Promise(() => undefined) });
    const service = createOrchestratorService({ dataDir, host: fake.host });
    await service.listJobs({ projectId: "p1", workspacePath: repo });
    await until(() => fake.of("startExecutor").length === 1, "the step's start");
    const view = (await service.listJobs({ projectId: "p1", workspacePath: repo })).jobs[0];
    expect(view?.steps.map((step) => step.taskId)).toEqual(["job1.core"]);
  });

  it("reads nothing on a poll when the ledger has not changed", async () => {
    const { chmod } = await import("node:fs/promises");
    const { ledgerPath } = await import("@zcode/orchestrator/tasks");
    const job = await oneStepJob({ executor: commitOnce, reviewer: () => pass() });
    await job.settled("the job to finish", (view) => view.phase === "done");
    await sleep(100);
    const first = await job.service.listJobs(job.project);
    const file = ledgerPath(job.dataDir, job.repo);
    // A read of the ledger would now fail; a poll that only looks at the file's size and time doesn't.
    await chmod(file, 0o000);
    try {
      expect((await job.service.listJobs(job.project)).jobs).toEqual(first.jobs);
      expect(await job.service.listJobs({ ...job.project, sinceSeq: first.seq })).toEqual({
        seq: first.seq,
        jobs: [],
      });
    } finally {
      await chmod(file, 0o644);
    }
  });
});

describe("orchestrator service: reviews bound to what they read", () => {
  it("starts the round again when the branch moved while the reviewer read it", async () => {
    const job = await oneStepJob({
      executor: commitOnce,
      async reviewer(turn) {
        // Someone commits in the executor's worktree while the first review runs.
        if (turn.index === 0)
          await turn.commit({ "src/late.ts": "y\n" }, { message: "A late change" });
        return pass();
      },
    });
    const done = await job.settled("the job to finish", (view) => view.phase === "done");
    const reviews = kinds(await job.ledger(), "review.decided");
    expect(reviews).toHaveLength(1);
    const head = await gitOk(["rev-parse", done.steps[0]!.run!.branch!], job.repo);
    expect(reviews[0]?.kind === "review.decided" && reviews[0].data.commit).toBe(head);
    const reviewer = [...job.fake.conversations.values()].find((c) => c.kind === "reviewer")!;
    expect(reviewer.messages).toHaveLength(2);
    expect(reviewer.messages[1]).toContain(head);
  });

  it("keeps one step's dropped finding from dropping another step's with the same id", async () => {
    const division = JSON.stringify({
      steps: [
        { key: "a_b", title: "AB1", brief: "One.", dependsOn: [], owns: ["a"] },
        { key: "a-b", title: "AB2", brief: "Two.", dependsOn: [], owns: ["b"] },
      ],
    });
    let ledgerRead: (() => Promise<readonly LedgerEntry[]>) | undefined;
    const job = await oneStepJob({
      async executor(turn) {
        const dir = turn.conversation.title === "AB1" ? "a" : "b";
        if (turn.index === 0) {
          await turn.commit({ [`${dir}/f.txt`]: "x\n" });
          return { text: "Done." };
        }
        if (dir === "a") return { text: "DISPUTE a-b-r1-1: not a problem." };
        // The second step fixes only after the first step's finding was dropped.
        await until(async () =>
          (await ledgerRead!()).some((entry) => entry.kind === "chair.ruled"),
        );
        await turn.commit({ [`${dir}/g.txt`]: "y\n" });
        return { text: "Fixed." };
      },
      reviewer: (turn) => {
        const second = turn.conversation.title === "Review: AB2";
        const round = roundOf(turn.message);
        if (round === 1) return findings([{ text: second ? "two is wrong" : "one is wrong" }]);
        if (!second) return pass();
        return findings([{ text: "two is still wrong", repeats: "a-b-r1-1" }]);
      },
      answers: {
        division: () => division,
        chair: () => '{"ruling": "drop", "text": "Fine as it is.", "findingId": "a-b-r1-1"}',
      },
    });
    ledgerRead = job.ledger;
    await until(async () =>
      (await job.ledger()).some(
        (entry) =>
          entry.kind === "review.decided" &&
          entry.taskId === `${job.jobId}.a-b` &&
          entry.data.round === 2,
      ),
    );
    const second = (await job.ledger()).findLast(
      (entry) => entry.kind === "review.decided" && entry.taskId === `${job.jobId}.a-b`,
    );
    expect(second?.kind === "review.decided" && second.data.verdict).toBe("findings");
  });
});

describe("orchestrator service: the final read and dividing again", () => {
  it("retries only the failed delivery of the final read's findings, and never finishes with a step working", async () => {
    let refuse = true;
    let reads = 0;
    const job = await oneStepJob({
      executor: commitOnce,
      reviewer: () => pass(),
      send: (input) => {
        if (refuse && input.text.includes("read the whole work against the plan")) {
          refuse = false;
          throw new Error("The conversation didn't take the message.");
        }
      },
      answers: {
        get finalRead() {
          reads += 1;
          return '{"ruling": "fix", "text": "The core misses its index file."}';
        },
      },
    });
    await job.settled("the final read's decision");
    await job.decide("send");
    const failed = await job.settled(
      "the failed delivery",
      (view) => view.decisions[0]?.question.includes("Something went wrong") ?? false,
    );
    expect(failed.decisions[0]?.options.map((option) => option.id)).toEqual(["retry", "stop-job"]);
    await job.decide("retry");
    const again = await job.settled(
      "the person's acceptance",
      (view) => view.decisions[0]?.question.includes("passed review again") ?? false,
    );
    expect(again.steps[0]?.state).toBe("queued");
    expect(reads).toBe(1);
    await job.decide("accept");
    const done = await job.settled("the job to finish", (view) => view.phase === "done");
    expect(done.steps[0]?.state).toBe("queued");
  });

  it("keeps the dependencies the cancelled steps had on steps that stay when dividing again", async () => {
    const hold = gate();
    let divisions = 0;
    const job = await oneStepJob({
      async executor(turn) {
        const title = turn.conversation.title;
        if (title === "B") await hold.promise;
        await turn.commit({ [`${title.toLowerCase()}/f${turn.index}.txt`]: "x\n" });
        return { text: "Done." };
      },
      reviewer: (turn) =>
        turn.conversation.title === "Review: A"
          ? findings([{ text: `a is wrong (${roundOf(turn.message)})` }])
          : pass(),
      answers: {
        division: () => {
          divisions += 1;
          return divisions === 1
            ? JSON.stringify({
                steps: [
                  { key: "a", title: "A", brief: "a", dependsOn: [], owns: ["a"] },
                  { key: "b", title: "B", brief: "b", dependsOn: [], owns: ["b"] },
                  { key: "c", title: "C", brief: "c", dependsOn: ["b"], owns: ["c"] },
                ],
              })
            : JSON.stringify({
                steps: [
                  { key: "d", title: "D", brief: "a and c again", dependsOn: [], owns: ["a"] },
                ],
              });
        },
        chair: () => '{"ruling": "redivide", "text": "Split it differently."}',
      },
    });
    const redivided = await job.settled("the new division", (view) =>
      view.steps.some((step) => step.title === "D"),
    );
    const d = redivided.steps.find((step) => step.title === "D")!;
    expect(d.dependsOn).toEqual([`${job.jobId}.b`]);
    await sleep(150);
    expect(job.fake.of("startExecutor").map((call) => call.title)).not.toContain("D");
    hold.open();
    await until(() => job.fake.of("startExecutor").some((call) => call.title === "D"), "D's start");
    const bReview = (await job.ledger()).find(
      (entry) => entry.kind === "review.decided" && entry.taskId === `${job.jobId}.b`,
    );
    const dStart = job.fake.of("startExecutor").find((call) => call.title === "D");
    expect(dStart?.ref).toBe(bReview?.kind === "review.decided" && bReview.data.commit);
  });
});
