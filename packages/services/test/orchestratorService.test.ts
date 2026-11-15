import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "@zcode/orchestrator/tasks";
import { DEFAULT_ROLES, type LedgerEntry, type ParliamentSeat } from "@zcode/orchestrator/types";
import { readTrailers } from "@zcode/orchestrator/worktrees";
import type { SwarmResult } from "@zcode/swarm/types";
import { describe, expect, it } from "vitest";
import { createRolesStore } from "../src/orchestrator/loop/rolesStore.js";
import { createOrchestratorService } from "../src/orchestrator/orchestratorService.js";
import {
  createFakeHost,
  gitOk,
  makeRepo,
  pass,
  promptKind,
  until,
  type FakeHostOptions,
} from "./orchestratorFakeHost.js";

function triageReply(route: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    route,
    reason: "Because.",
    confident: true,
    understood: "A thing.",
    ...extra,
  });
}

async function setup(
  options: Omit<FakeHostOptions, "repo"> = {},
  repoFiles?: Record<string, string>,
) {
  const { repo, dataDir } = await makeRepo(repoFiles);
  const fake = createFakeHost({ repo, ...options });
  let ids = 0;
  const newId = () => `id${String((ids += 1)).padStart(3, "0")}`;
  const service = createOrchestratorService({ dataDir, host: fake.host, newId });
  const project = { projectId: "p1", workspacePath: repo };
  const job = async (jobId: string) =>
    (await service.listJobs(project)).jobs.find((candidate) => candidate.jobId === jobId)!;
  const ledger = () => openLedger({ dataDir }).read(repo);
  return { repo, dataDir, fake, service, project, job, ledger, newId };
}

/** A parliament result: each seat proposes, letters in seat order; `winner` is a letter. */
function swarmResult(
  seats: readonly ParliamentSeat[],
  outcome: Partial<Pick<SwarmResult, "tied" | "advisors" | "advisorOrder">> & { winner?: string },
): SwarmResult {
  const members = seats.map((seat, index) => ({
    id: `${seat.agent}:${seat.model}`,
    agent: seat.agent,
    ...(seat.model ? { model: seat.model } : {}),
    _index: index,
  }));
  const plans = members.map((member, index) => ({
    letter: String.fromCharCode(65 + index),
    memberId: member.id,
    plan: `Plan ${String.fromCharCode(65 + index)}: build the api, the ui and the docs.`,
  }));
  const scores = plans.map((plan) => ({
    letter: plan.letter,
    memberId: plan.memberId,
    points: 1,
    firstPlaces: 0,
  }));
  const winner = scores.find((score) => score.letter === outcome.winner);
  return {
    task: "t",
    plans,
    debate: [],
    ballots: [],
    scores,
    ...(winner ? { winner } : {}),
    dropped: [],
    members: members.map(({ _index: _, ...member }) => member),
    ...(outcome.tied ? { tied: outcome.tied } : {}),
    ...(outcome.advisors ? { advisors: outcome.advisors } : {}),
    ...(outcome.advisorOrder ? { advisorOrder: outcome.advisorOrder } : {}),
  };
}

const DIVISION = JSON.stringify({
  steps: [
    { key: "api", title: "API", brief: "Build the api.", dependsOn: [], owns: ["packages/api"] },
    { key: "ui", title: "UI", brief: "Build the ui.", dependsOn: [], owns: ["packages/ui"] },
    { key: "docs", title: "Docs", brief: "Document the api.", dependsOn: ["api"], owns: ["docs"] },
  ],
  note: "Two side by side, then the docs.",
});

describe("orchestrator service: route", () => {
  it("sends a message each way, and the person's choice wins", async () => {
    let reply = triageReply("chat");
    const { service, project, fake, ledger } = await setup({
      ask: (_choice, prompt) => (promptKind(prompt) === "triage" ? reply : "a plan"),
      cannotOrchestrate: undefined,
    });
    const send = (text: string, preference: "auto" | "direct" | "orchestrated" = "auto") =>
      service.route({ ...project, text, preference, conversationId: "c1" });

    const chat = await send("hi");
    expect(chat.decision.route).toBe("chat");
    expect(chat.jobId).toBeUndefined();

    reply = triageReply("direct");
    expect((await send("fix the typo")).decision.route).toBe("direct");

    // Unsure about a big job: the lighter way, and no job.
    reply = JSON.stringify({ route: "orchestrated", reason: "Maybe big.", confident: false });
    const unsure = await send("rework everything?");
    expect(unsure.decision.route).toBe("direct");
    expect(unsure.jobId).toBeUndefined();

    reply = "not json at all";
    expect((await send("???")).decision.route).toBe("direct");

    // "direct" never asks the model.
    const asksBefore = fake.of("ask").length;
    expect((await send("do it", "direct")).decision.route).toBe("direct");
    expect(fake.of("ask").length).toBe(asksBefore);

    // A forced "orchestrated" still asks triage (for what it understood), and makes a job.
    reply = triageReply("chat");
    const forced = await send("build it", "orchestrated");
    expect(forced.decision.route).toBe("orchestrated");
    expect(forced.jobId).toBeDefined();
    expect(fake.of("ask").length).toBe(asksBefore + 1);
    await service.stopJob({ ...project, jobId: forced.jobId! });

    const triages = (await ledger()).filter((entry) => entry.kind === "triage.decided");
    expect(triages).toHaveLength(6);
    expect(triages.at(-1)?.taskId).toBe(forced.jobId);
  });

  it("goes direct with the reason when the project can't be orchestrated", async () => {
    const { service, project } = await setup({
      ask: () => triageReply("orchestrated"),
      cannotOrchestrate: "This folder isn't a Git repository.",
    });
    const result = await service.route({ ...project, text: "build it", preference: "auto" });
    expect(result).toMatchObject({
      decision: { route: "direct" },
      note: "This folder isn't a Git repository.",
    });
    expect(result.jobId).toBeUndefined();
    expect((await service.listJobs(project)).jobs).toEqual([]);
  });
});

describe("orchestrator service: a big job end to end", () => {
  it("deliberates, divides, runs the free steps at once, the dependent one after review, and finishes", async () => {
    const order: string[] = [];
    const { service, project, fake, job, ledger, dataDir, repo } = await setup({
      ask: (_choice, prompt) => {
        const kind = promptKind(prompt);
        if (kind === "triage") return triageReply("orchestrated", { planBy: "parliament" });
        if (kind === "division") return DIVISION;
        if (kind === "final-read") return '{"ruling": "pass", "text": "Matches the plan."}';
        throw new Error(`unexpected ${kind}`);
      },
      deliberate: ({ seats }) => swarmResult(seats, { winner: "B" }),
      async executor(turn) {
        const title = turn.conversation.title;
        order.push(`work ${title}`);
        if (title !== "Docs") {
          // Both free steps must have started before either works.
          await until(() => fake.of("startExecutor").length >= 2, "both executors");
        }
        const dir = { API: "packages/api", UI: "packages/ui", Docs: "docs" }[title]!;
        await turn.commit({ [`${dir}/index.md`]: `${title}\n` }, { message: `Add ${title}` });
        return { text: `Built ${title}.` };
      },
      reviewer: () => pass(),
    });

    const { jobId } = await service.route({
      ...project,
      text: "Build the app",
      preference: "auto",
    });
    expect(jobId).toBeDefined();
    const done = await until(async () => {
      const view = await job(jobId!);
      return view.phase === "done" || view.phase === "waiting" ? view : undefined;
    }, "the job to finish");
    expect(done.phase, done.status).toBe("done");

    // The parliament, with the default advisors (they are on), and the winner recorded as its seat.
    expect(fake.of("deliberate")[0]?.advisors).toEqual(DEFAULT_ROLES.advisor.choices);
    expect(done.plan?.winner).toBe("claude:fable");

    // Three steps, the free two started first and at once, the dependent one after.
    const starts = fake.of("startExecutor");
    // The free two start together, in either order.
    expect(
      starts
        .slice(0, 2)
        .map((call) => call.title)
        .sort(),
    ).toEqual(["API", "UI"]);
    expect(starts[2]?.title).toBe("Docs");
    expect(order.indexOf("work Docs")).toBeGreaterThan(1);
    const entries = await ledger();
    const apiReview = entries.find(
      (entry) => entry.kind === "review.decided" && entry.taskId === `${jobId}.api`,
    ) as Extract<LedgerEntry, { kind: "review.decided" }>;
    expect(apiReview.data.verdict).toBe("pass");
    // The docs step starts from the api's reviewed commit.
    expect(starts[2]?.ref).toBe(apiReview.data.commit);
    const docsStart = entries.findIndex(
      (entry) => entry.kind === "run.started" && entry.taskId === `${jobId}.docs`,
    );
    expect(docsStart).toBeGreaterThan(entries.indexOf(apiReview));

    // Every step passed; reviewers ran on another agent; each branch's commits carry trailers.
    expect(done.steps.map((step) => step.state)).toEqual(["queued", "queued", "queued"]);
    expect(
      new Set(fake.of("startReviewer").map((call) => (call.choice as { agent: string }).agent)),
    ).toEqual(new Set(["codex"]));
    for (const step of done.steps) {
      expect(step.run?.branch).toMatch(
        new RegExp(`^xatlas/${step.taskId.replace(".", "\\.")}/claude-`),
      );
      const message = await gitOk(["log", "-1", "--format=%B", step.run!.branch!], repo);
      expect(readTrailers(message)?.runId).toBe(step.run?.runId);
      expect(step.review?.verdict).toBe("pass");
    }
    // The executor was told what it owns, its branch and its trailers.
    const apiStart = starts.find((call) => call.title === "API");
    expect(String(apiStart?.text)).toContain("You may change only: packages/api.");
    expect(String(apiStart?.text)).toContain("Xatlas-Run: ");

    // The final read was the chair's: not the plan's writer, not the executor's agent.
    expect(done.rulings.map((ruling) => [ruling.trigger, ruling.ruling, ruling.chair])).toEqual([
      ["final-read", "pass", "codex:gpt-6-astra"],
    ]);

    // The ledger alone rebuilds the same view, and an unchanged position costs nothing.
    const again = createOrchestratorService({ dataDir, host: createFakeHost({ repo }).host });
    const first = await service.listJobs(project);
    expect((await again.listJobs(project)).jobs).toEqual(first.jobs);
    expect(await service.listJobs({ ...project, sinceSeq: first.seq })).toEqual({
      seq: first.seq,
      jobs: [],
    });
  });
});

describe("orchestrator service: planning", () => {
  type Outcome = Pick<SwarmResult, "advisors" | "advisorOrder">;
  async function levelJob(advisorOn: boolean, outcome: Partial<Outcome> = {}, winner?: string) {
    const context = await setup({
      ask: (_choice, prompt) => {
        const kind = promptKind(prompt);
        if (kind === "triage") return triageReply("orchestrated", { planBy: "parliament" });
        if (kind === "division") return "I can't do this.";
        throw new Error(`unexpected ${kind}`);
      },
      deliberate: ({ seats }) =>
        swarmResult(seats, {
          tied: ["A", "B"],
          ...(winner ? { winner } : { winner: "A" }),
          ...outcome,
        }),
      executor: () => new Promise(() => undefined),
    });
    if (!advisorOn) {
      await context.service.setRoles({
        ...context.project,
        roles: { ...DEFAULT_ROLES, advisor: { ...DEFAULT_ROLES.advisor, enabled: false } },
      });
    }
    const { jobId } = await context.service.route({
      ...context.project,
      text: "Big",
      preference: "auto",
    });
    return { ...context, jobId: jobId! };
  }

  it("asks the person when the vote is level and the advisors are off", async () => {
    const { service, project, fake, job, jobId } = await levelJob(false);
    const waiting = await until(async () => {
      const view = await job(jobId);
      return view.phase === "waiting" ? view : undefined;
    });
    expect(fake.of("deliberate")[0]).not.toHaveProperty("advisors");
    const decision = waiting.decisions[0]!;
    expect(decision.kind).toBe("level-vote");
    expect(decision.options.map((option) => option.id)).toEqual(["A", "B"]);
    expect(waiting.plan?.winner).toBeUndefined();
    expect(waiting.plan?.tied).toEqual(["claude:claude-mythos-5-2", "claude:fable"]);

    await service.decide({ ...project, jobId, decisionId: decision.id, optionId: "B" });
    const chosen = await until(async () => {
      const view = await job(jobId);
      return view.plan?.winner ? view : undefined;
    });
    expect(chosen.plan?.winner).toBe("claude:fable");
    expect(chosen.plan?.text).toContain("Plan B");
    // An unreadable division became one step that owns everything.
    await until(async () => (await job(jobId)).steps.length === 1, "one step");
    expect((await job(jobId)).steps[0]?.owns).toEqual([]);
    await service.stopJob({ ...project, jobId });
  });

  it("lets the advisors settle a level vote, and records every one asked", async () => {
    const { service, project, fake, job, jobId, ledger } = await levelJob(
      true,
      {
        advisors: [
          { id: "claude:opus+high", error: "not signed in" },
          { id: "claude:claude-mythos-5-2", ranking: ["B", "A"], reason: "B is simpler." },
          { id: "openrouter:google/gemini-4-argon", ranking: ["B"] },
        ],
        advisorOrder: ["B", "A"],
      },
      "B",
    );
    const view = await until(async () => {
      const current = await job(jobId);
      return current.plan?.winner ? current : undefined;
    });
    expect(fake.of("deliberate")[0]?.advisors).toEqual(DEFAULT_ROLES.advisor.choices);
    expect(view.plan?.winner).toBe("claude:fable");
    const [opus, mythos, gemini] = DEFAULT_ROLES.advisor.choices;
    const recorded = {
      advisors: [
        { choice: opus, error: "not signed in" },
        {
          choice: mythos,
          ranking: ["claude:fable", "claude:claude-mythos-5-2"],
          reason: "B is simpler.",
        },
        { choice: gemini, ranking: ["claude:fable"] },
      ],
      advisorOrder: ["claude:fable", "claude:claude-mythos-5-2"],
    };
    expect(view.plan).toMatchObject(recorded);
    const decided = (await ledger()).filter((entry) => entry.kind === "parliament.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]?.data).toMatchObject({ ...recorded, winner: "claude:fable" });
    expect(view.decisions.filter((decision) => decision.kind === "level-vote")).toEqual([]);
    await service.stopJob({ ...project, jobId });
  });
  it("takes the one plan the parliament agreed on", async () => {
    const context = await setup({
      ask: (_choice, prompt) =>
        promptKind(prompt) === "triage"
          ? triageReply("orchestrated", { planBy: "parliament" })
          : "no division",
      // As the discussion-first parliament reports an agreement: one plan, letter A, the winner.
      deliberate: ({ seats }) => {
        const result = swarmResult(seats, { winner: "B" });
        const plan = { ...result.plans[1]!, letter: "A" };
        const score = { ...result.winner!, letter: "A" };
        return { ...result, plans: [plan], scores: [score], winner: score };
      },
      executor: () => new Promise(() => undefined),
    });
    const { jobId } = await context.service.route({
      ...context.project,
      text: "Big",
      preference: "auto",
    });
    const view = await until(async () => {
      const current = await context.job(jobId!);
      return current.plan?.winner ? current : undefined;
    });
    expect(view.plan?.winner).toBe("claude:fable");
    expect(view.decisions).toEqual([]);
    await context.service.stopJob({ ...context.project, jobId: jobId! });
  });

  it("asks the person when the parliament names no winner, even with one plan left", async () => {
    const context = await setup({
      ask: (_choice, prompt) =>
        promptKind(prompt) === "triage"
          ? triageReply("orchestrated", { planBy: "parliament" })
          : "no division",
      deliberate: ({ seats }) => {
        const result = swarmResult(seats, {});
        // The other authors failed: one plan stands, and nobody chose it.
        return { ...result, plans: result.plans.slice(0, 1), scores: result.scores.slice(0, 1) };
      },
      executor: () => new Promise(() => undefined),
    });
    const { jobId } = await context.service.route({
      ...context.project,
      text: "Big",
      preference: "auto",
    });
    const waiting = await until(async () => {
      const view = await context.job(jobId!);
      return view.phase === "waiting" ? view : undefined;
    });
    expect(waiting.decisions[0]?.kind).toBe("level-vote");
    expect(waiting.decisions[0]?.options.map((option) => option.id)).toEqual(["A"]);
    expect(waiting.plan?.winner).toBeUndefined();
    expect(context.fake.of("ask").filter((call) => call.kind === "division")).toHaveLength(0);
    await context.service.stopJob({ ...context.project, jobId: jobId! });
  });

  it("asks the person when the advisors did not settle it, and keeps their answers", async () => {
    const { service, project, job, jobId } = await levelJob(true, {
      advisors: [
        { id: "claude:opus+high", ranking: ["A", "B"] },
        { id: "claude:claude-mythos-5-2", ranking: ["B", "A"] },
        { id: "openrouter:google/gemini-4-argon", error: "timed out" },
      ],
    });
    const view = await until(async () => {
      const current = await job(jobId);
      return current.phase === "waiting" ? current : undefined;
    });
    expect(view.decisions[0]?.kind).toBe("level-vote");
    expect(view.decisions[0]?.question).toContain("the outside advisors did not settle it");
    expect(view.decisions[0]?.question).toContain(
      "google/gemini-4-argon couldn't answer (timed out)",
    );
    expect(view.plan?.advisors?.map((answer) => answer.error)).toEqual([
      undefined,
      undefined,
      "timed out",
    ]);
    expect(view.plan?.advisorOrder).toBeUndefined();
    expect(view.plan?.winner).toBeUndefined();
    // The person's choice keeps the advisors' answers.
    await service.decide({ ...project, jobId, decisionId: view.decisions[0]!.id, optionId: "A" });
    const chosen = await until(async () => {
      const current = await job(jobId);
      return current.plan?.winner ? current : undefined;
    });
    expect(chosen.plan?.advisors).toHaveLength(3);
    await service.stopJob({ ...project, jobId });
  });

  it("has one model plan a clear job, after the person answers triage's questions", async () => {
    const prompts: string[] = [];
    const { service, project, fake, job } = await setup({
      ask: (choice, prompt) => {
        const kind = promptKind(prompt);
        prompts.push(prompt);
        if (kind === "triage") {
          return triageReply("orchestrated", { planBy: "one", questions: ["Which database?"] });
        }
        if (kind === "plan") return `The plan from ${choice.model}.`;
        return "no division";
      },
      executor: () => new Promise(() => undefined),
    });
    const { jobId } = await service.route({ ...project, text: "Add storage", preference: "auto" });
    const waiting = await until(async () => {
      const view = await job(jobId!);
      return view.phase === "waiting" ? view : undefined;
    });
    expect(waiting.decisions[0]).toMatchObject({ kind: "clarify", options: [{ id: "start" }] });
    expect(waiting.decisions[0]?.question).toContain("Which database?");
    await service.postNote({ ...project, jobId: jobId!, text: "Use SQLite." });
    await service.decide({
      ...project,
      jobId: jobId!,
      decisionId: waiting.decisions[0]!.id,
      optionId: "start",
    });
    const planned = await until(async () => {
      const view = await job(jobId!);
      return view.plan?.winner ? view : undefined;
    });
    expect(fake.of("deliberate")).toHaveLength(0);
    expect(planned.plan?.winner).toBe("claude:claude-mythos-5-2");
    expect(prompts.find((prompt) => promptKind(prompt) === "plan")).toContain("Use SQLite.");
    await service.stopJob({ ...project, jobId: jobId! });
  });
});

describe("orchestrator service: steps that wait on two others", () => {
  it("starts from the first reviewed commit with the second merged in, and the merged files are not its changes", async () => {
    const { service, project, fake, job, ledger, repo } = await setup({
      ask: (_choice, prompt) => {
        const kind = promptKind(prompt);
        if (kind === "triage") return triageReply("orchestrated", { planBy: "one" });
        if (kind === "plan") return "Build a and b, then c on both.";
        if (kind === "division") {
          return JSON.stringify({
            steps: [
              { key: "a", title: "A", brief: "a", dependsOn: [], owns: ["a"] },
              { key: "b", title: "B", brief: "b", dependsOn: [], owns: ["b"] },
              { key: "c", title: "C", brief: "c", dependsOn: ["a", "b"], owns: ["c"] },
            ],
          });
        }
        if (kind === "final-read") return '{"ruling": "pass", "text": "Good."}';
        throw new Error(`unexpected ${kind}`);
      },
      async executor(turn) {
        const dir = turn.conversation.title.toLowerCase();
        await turn.commit({ [`${dir}/file.txt`]: `${dir}\n` });
        return { text: "Done." };
      },
      reviewer: () => pass(),
    });
    const { jobId } = await service.route({ ...project, text: "Build", preference: "auto" });
    const done = await until(async () => {
      const view = await job(jobId!);
      return view.phase === "done" || view.phase === "waiting" ? view : undefined;
    });
    expect(done.phase, done.status).toBe("done");
    const entries = await ledger();
    const reviewed = (key: string) =>
      (
        entries.find(
          (entry) => entry.kind === "review.decided" && entry.taskId === `${jobId}.${key}`,
        ) as Extract<LedgerEntry, { kind: "review.decided" }>
      ).data.commit;
    const ref = String(fake.of("startExecutor")[2]?.ref);
    const parents = (await gitOk(["rev-list", "--parents", "-n", "1", ref], repo))
      .split(" ")
      .slice(1);
    expect(parents).toEqual([reviewed("a"), reviewed("b")]);
    expect(entries.filter((entry) => entry.kind === "oversight.flagged")).toEqual([]);
  });

  it("stops a step whose dependencies' commits conflict, with a sentence the person can act on", async () => {
    const { repo } = await makeRepo({ "shared.txt": "base\n" });
    const { startCommit } = await import("../src/orchestrator/loop/gitFacts.js");
    const commitOn = async (branch: string, text: string) => {
      await gitOk(["checkout", "-q", "-b", branch, "main"], repo);
      await import("node:fs/promises").then((fs) => fs.writeFile(`${repo}/shared.txt`, text));
      await gitOk(["commit", "-q", "-am", branch], repo);
      return gitOk(["rev-parse", "HEAD"], repo);
    };
    const one = await commitOn("one", "one\n");
    const two = await commitOn("two", "two\n");
    const result = await startCommit(
      createFakeHost({ repo }).host.git,
      repo,
      { startFrom: one, mergeIn: [two] },
      'step "C"',
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('conflict when merged for step "C" (shared.txt)');
  });
});

describe("orchestrator roles store", () => {
  it("reads roles saved with the single advisor of before as a panel of one", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "xatlas-roles-"));
    const file = join(
      dataDir,
      "roles",
      `${createHash("sha256").update("/work/old").digest("hex")}.json`,
    );
    const { advisor: _, ...rest } = DEFAULT_ROLES;
    const saved = {
      ...rest,
      executor: [{ agent: "codex", model: "gpt-6-astra" }],
      advisor: {
        enabled: false,
        choice: { via: "openrouter", model: "google/gemini-4-argon", effort: "high" },
      },
    };
    await mkdir(join(dataDir, "roles"), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, projectKey: "/work/old", roles: saved }));
    const store = createRolesStore(dataDir);
    const roles = await store.get("/work/old");
    // The person's seats are kept, not replaced by the defaults.
    expect(roles.executor).toEqual([{ agent: "codex", model: "gpt-6-astra" }]);
    expect(roles.advisor).toEqual({
      enabled: false,
      choices: [{ via: "openrouter", model: "google/gemini-4-argon", effort: "high" }],
    });
    // Saved again, it is written in the new shape.
    await store.set("/work/old", roles);
    const written = JSON.parse(await readFile(file, "utf8")) as { roles: Record<string, unknown> };
    expect(written.roles.advisor).toEqual(roles.advisor);
    // A Claude Code advisor can be saved; one through another agent can't.
    await store.set("/work/old", {
      ...roles,
      advisor: { enabled: true, choices: [{ via: "claude", model: "opus", effort: "high" }] },
    });
    await expect(
      store.set("/work/old", {
        ...roles,
        advisor: { enabled: true, choices: [{ via: "codex" as never, model: "gpt-6-astra" }] },
      }),
    ).rejects.toThrow("advisor.choices[0]");
  });
});

describe("orchestrator service: ideas beyond the request", () => {
  const plan = [
    "## How it does what was asked",
    "Cache the search results.",
    "## Steps",
    "1. Add the cache in src/search.ts.",
    "### beyond the request (ideas for the person)",
    "Migrate authentication to passkeys.",
    "## How to verify",
    "Run the search tests.",
  ].join("\n");

  it("keeps them out of the division and the fallback brief, and on the job", async () => {
    const prompts: string[] = [];
    const { service, project, job, ledger } = await setup({
      ask: (_choice, prompt) => {
        const kind = promptKind(prompt);
        if (kind === "triage") return triageReply("orchestrated", { planBy: "parliament" });
        if (kind === "division") {
          prompts.push(prompt);
          return "I can't do this.";
        }
        throw new Error(`unexpected ${kind}`);
      },
      deliberate: ({ seats }) => {
        const result = swarmResult(seats, { winner: "A" });
        return {
          ...result,
          plans: result.plans.map((entry) => (entry.letter === "A" ? { ...entry, plan } : entry)),
        };
      },
      executor: () => new Promise(() => undefined),
    });
    const { jobId } = await service.route({
      ...project,
      text: "Make search faster",
      preference: "auto",
    });
    const step = await until(
      async () =>
        (await ledger()).find(
          (entry) => entry.kind === "task.created" && entry.taskId === `${jobId}.all`,
        ),
      "the fallback step",
    );
    // The divider never saw the ideas, and the one fallback step's brief doesn't hold them.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("1. Add the cache in src/search.ts.");
    expect(prompts[0]).toContain("Run the search tests.");
    expect(prompts[0]).not.toContain("passkeys");
    const brief = JSON.stringify(step);
    expect(brief).toContain("Add the cache in src/search.ts.");
    expect(brief).toContain("Run the search tests.");
    expect(brief).not.toContain("passkeys");
    // The person still sees the whole plan on the job.
    expect((await job(jobId!)).plan?.text).toContain("Migrate authentication to passkeys.");
    await service.stopJob({ ...project, jobId: jobId! });
  });
});
