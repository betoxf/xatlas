import { seatId } from "@zcode/orchestrator/oversight";
import {
  pickParliament,
  pickRole,
  planPrompt,
  resolvePlanBy,
  resolveRoute,
  triage,
} from "@zcode/orchestrator/routing";
import type {
  LedgerData,
  LedgerEntry,
  ParliamentSeat,
  RoleSettings,
  TriageDecision,
} from "@zcode/orchestrator/types";
import type { SwarmResult } from "@zcode/swarm/types";
import type { OrchestratorRouteRequest, OrchestratorRouteResult } from "../orchestrator.js";
import {
  background,
  entriesOf,
  errorText,
  inJob,
  jobClosed,
  jobRef,
  ledgerOf,
  openDecision,
  projectKeyOf,
  signalOf,
  taskIn,
  type JobRef,
  type Loop,
} from "./context.js";
import { divideJob } from "./divide.js";
import { claimJob } from "./guard.js";
import { decidedOf, triageOf } from "./jobView.js";
import { titleOf } from "./prompts.js";
import { planNote, planOptions } from "./records.js";

/**
 * Where a message goes, and for a job the plan: one planner or the parliament. Division and
 * everything after it live in the files beside this one.
 */

export async function route(
  loop: Loop,
  params: OrchestratorRouteRequest,
): Promise<OrchestratorRouteResult> {
  const key = projectKeyOf(params);
  const project = ledgerOf(loop, jobRef(params, ""));
  const roles = await loop.roles.get(key);
  const decision = await triage({
    message: params.text,
    preference: params.preference,
    ask: async (prompt) => {
      const pick = pickRole("triage", roles, await loop.host.agents(), { now: loop.now() });
      if (!pick.ok) throw new Error(pick.reason);
      return loop.host.ask(pick.choice, prompt, { cwd: params.workspacePath });
    },
  });
  const routed = resolveRoute(params.preference, decision);
  const recorded = {
    decision,
    preference: params.preference,
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
  };
  if (routed !== "orchestrated") {
    await project.record({ kind: "triage.decided", data: recorded });
    return { decision: { ...decision, route: routed } };
  }
  let why: string | undefined;
  try {
    why = await loop.host.cannotOrchestrate(params);
  } catch (error) {
    why = `The app couldn't tell whether this project can be orchestrated (${errorText(error)}), so it goes straight to an executor.`;
  }
  if (why) {
    await project.record({ kind: "triage.decided", data: recorded });
    return { decision: { ...decision, route: "direct" }, note: why };
  }
  const jobId = loop.newId();
  await project.createTask({
    id: jobId,
    title: titleOf(params.text),
    brief: params.text,
    route: "orchestrated",
  });
  await project.record({ kind: "triage.decided", taskId: jobId, data: recorded });
  const job = jobRef(params, jobId);
  // A new job is ours; should the claim fail anyway, the job only waits to be taken over.
  if ((await claimJob(loop, job)).ours) {
    background(loop, job, { stage: "plan", what: "planning the job" }, () =>
      inJob(loop, job, () => startJob(loop, job)),
    );
  }
  return { decision: { ...decision, route: "orchestrated" }, jobId };
}

/** A job with questions waits for the person; any other goes straight to its plan. */
export async function startJob(loop: Loop, job: JobRef): Promise<void> {
  const entries = await entriesOf(loop, job);
  const questions = triageOf(entries, job.jobId)?.decision.questions ?? [];
  if (questions.length === 0) return planJob(loop, job);
  await openDecision(loop, job, {
    about: "clarify",
    kind: "clarify",
    question: [
      questions.length === 1
        ? "Before planning, one thing needs an answer:"
        : "Before planning, these need answers:",
      ...questions.map((question) => `- ${question}`),
      "Answer with notes on the board, then start the job.",
    ].join("\n"),
    options: ["start"],
  });
}

/** What the person added on the board before planning, oldest first. */
function personNotes(entries: readonly LedgerEntry[], jobId: string): string[] {
  return entries.flatMap((entry) =>
    entry.kind === "note" && entry.taskId === jobId && entry.data.from === "person"
      ? [entry.data.text]
      : [],
  );
}

/** The job as planners read it: the message, what triage understood, the person's notes. */
function planningTask(entries: readonly LedgerEntry[], jobId: string): string {
  const brief = taskIn(entries, jobId)?.brief ?? "";
  const understood = triageOf(entries, jobId)?.decision.understood;
  const notes = personNotes(entries, jobId);
  return [
    brief,
    ...(understood ? ["", `Understood as: ${understood}`] : []),
    ...(notes.length > 0 ? ["", "The person added:", ...notes.map((note) => `- ${note}`)] : []),
  ].join("\n");
}

export async function planJob(loop: Loop, job: JobRef): Promise<void> {
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) return;
  const decision: TriageDecision | undefined = triageOf(entries, job.jobId)?.decision;
  const roles = await loop.roles.get(job.key);
  const agents = await loop.host.agents();
  const sitting = pickParliament(roles, agents, { now: loop.now() });
  if (resolvePlanBy(decision) === "parliament") {
    if (sitting.enough) return deliberate(loop, job, roles, sitting.seats);
    await ledgerOf(loop, job).record({
      kind: "note",
      taskId: job.jobId,
      data: {
        from: "orchestrator",
        text: `The parliament can't sit, because fewer than two seats that propose can run${sitting.skipped.length > 0 ? ` (${sitting.skipped.map((entry) => entry.reason).join(" ")})` : ""}. One model plans this job instead.`,
      },
    });
  }
  return planByOne(loop, job, sitting.seats, sitting.skipped);
}

async function planByOne(
  loop: Loop,
  job: JobRef,
  seats: readonly ParliamentSeat[],
  skipped: ReadonlyArray<{ readonly reason: string }>,
): Promise<void> {
  const entries = await entriesOf(loop, job);
  const task = taskIn(entries, job.jobId);
  const understood = triageOf(entries, job.jobId)?.decision.understood;
  const notes = personNotes(entries, job.jobId);
  const prompt = planPrompt({
    task: task?.brief ?? "",
    ...(understood ? { understood } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  });
  const failures: string[] = skipped.map((entry) => entry.reason);
  for (const seat of seats.filter((candidate) => !candidate.votesOnly)) {
    let plan: string;
    try {
      plan = (
        await loop.host.ask(seat, prompt, {
          cwd: job.project.workspacePath,
          signal: signalOf(loop, job),
        })
      ).trim();
    } catch (error) {
      if (signalOf(loop, job).aborted) return;
      failures.push(`${seatId(seat)} failed: ${errorText(error)}.`);
      continue;
    }
    if (!plan) {
      failures.push(`${seatId(seat)} gave an empty plan.`);
      continue;
    }
    if (jobClosed(await entriesOf(loop, job), job.jobId)) return;
    await ledgerOf(loop, job).record({
      kind: "parliament.decided",
      taskId: job.jobId,
      data: { seats: [seat], plan, winner: seatId(seat) },
    });
    return divideJob(loop, job);
  }
  await openDecision(loop, job, {
    about: "retry",
    kind: "blocked",
    stage: "plan",
    question: `Nobody could write the plan${failures.length > 0 ? `: ${failures.join(" ")}` : ": no parliament seat can run."} Check the agents under Connections, then try again.`,
    options: ["retry", "stop-job"],
  });
}

/** The seat a swarm member stands for: by its place among the members, or by its id. */
function seatNameOf(result: SwarmResult, seats: readonly ParliamentSeat[], memberId: string) {
  const index = result.members?.findIndex((member) => member.id === memberId) ?? -1;
  const seat = index >= 0 ? seats[index] : undefined;
  // Member ids are `agent[:model][+options][#n]`; the part before the options is the seat.
  return seat ? seatId(seat) : (memberId.split("#")[0]?.split("+")[0] ?? memberId);
}

async function deliberate(
  loop: Loop,
  job: JobRef,
  roles: RoleSettings,
  seats: readonly ParliamentSeat[],
): Promise<void> {
  const entries = await entriesOf(loop, job);
  const advisors = roles.advisor.enabled ? roles.advisor.choices : [];
  let result: SwarmResult;
  try {
    result = await loop.host.deliberate({
      task: planningTask(entries, job.jobId),
      cwd: job.project.workspacePath,
      seats,
      ...(advisors.length > 0 ? { advisors } : {}),
      signal: signalOf(loop, job),
    });
  } catch (error) {
    if (signalOf(loop, job).aborted) return;
    await openDecision(loop, job, {
      about: "retry",
      kind: "blocked",
      stage: "plan",
      question: `The parliament couldn't sit: ${errorText(error)}. Try again, or stop the job.`,
      options: ["retry", "stop-job"],
    });
    return;
  }
  if (jobClosed(await entriesOf(loop, job), job.jobId)) return;
  const name = (memberId: string) => seatNameOf(result, seats, memberId);
  const letterSeat = (letter: string) => {
    const plan = result.plans.find((candidate) => candidate.letter === letter);
    return plan ? name(plan.memberId) : letter;
  };
  const plans = result.plans.filter((plan) => plan.plan.trim() !== "");
  if (plans.length === 0) {
    await openDecision(loop, job, {
      about: "retry",
      kind: "blocked",
      stage: "plan",
      question: "The parliament gave no plan. Check the agents under Connections, then try again.",
      options: ["retry", "stop-job"],
    });
    return;
  }
  const tied = (result.tied ?? []).filter((letter) => plans.some((plan) => plan.letter === letter));
  // The advisors asked are always the first of the panel, in its order, so each answer is the
  // choice at its place.
  const answers: NonNullable<LedgerData["parliament.decided"]["advisors"]> = (
    result.advisors ?? []
  ).flatMap((answer, index) => {
    const choice = advisors[index];
    if (!choice) return [];
    return [
      {
        choice,
        ...(answer.ranking ? { ranking: answer.ranking.map(letterSeat) } : {}),
        ...(answer.reason ? { reason: answer.reason } : {}),
        ...(answer.error ? { error: answer.error } : {}),
      },
    ];
  });
  const advisorOrder =
    answers.length > 0 && result.advisorOrder && result.advisorOrder.length > 0
      ? result.advisorOrder.map(letterSeat)
      : undefined;
  // Only a plan the parliament named as its winner is taken; a lone plan left standing after
  // the others failed was never chosen, so it goes to the person like any other. A level vote
  // is settled only by the advisors' combined order.
  const settled = result.winner !== undefined && (tied.length <= 1 || advisorOrder !== undefined);
  const winnerPlan =
    plans.find((plan) => plan.letter === result.winner?.letter) ??
    plans.find((plan) => plan.memberId === result.winner?.memberId);
  const common = {
    seats: [...seats],
    ...(tied.length > 1 ? { tied: tied.map(letterSeat) } : {}),
    ...(answers.length > 0 ? { advisors: answers } : {}),
    ...(advisorOrder ? { advisorOrder } : {}),
  };
  if (settled && winnerPlan) {
    await ledgerOf(loop, job).record({
      kind: "parliament.decided",
      taskId: job.jobId,
      data: { ...common, plan: winnerPlan.plan, winner: name(winnerPlan.memberId) },
    });
    return divideJob(loop, job);
  }
  // Level, or no vote at all: the person picks among the level plans (every plan without a vote).
  const level = tied.length > 1 ? plans.filter((plan) => tied.includes(plan.letter)) : plans;
  const project = ledgerOf(loop, job);
  await project.record({
    kind: "parliament.decided",
    taskId: job.jobId,
    data: { ...common, plan: (winnerPlan ?? level[0]!).plan },
  });
  for (const plan of level) {
    await project.record(
      planNote(job.jobId, loop.newId(), {
        letter: plan.letter,
        seat: name(plan.memberId),
        plan: plan.plan,
      }),
    );
  }
  const seatsText = level.map((plan) => `Plan ${plan.letter} (${name(plan.memberId)})`).join(", ");
  const why =
    tied.length > 1
      ? `The parliament split between ${seatsText}${
          answers.length > 0
            ? `, and the outside advisors did not settle it (${answersText(answers)})`
            : ""
        }.`
      : level.length === 1
        ? `The parliament named no winner; one plan is left, ${seatsText}.`
        : `The parliament couldn't choose between ${seatsText}.`;
  await openDecision(loop, job, {
    about: "level-vote",
    kind: "level-vote",
    question: `${why} Which plan should the job follow?`,
    options: level.map((plan) => ({
      id: plan.letter,
      label: `Plan ${plan.letter} by ${name(plan.memberId)}`,
    })),
  });
}

/** What each advisor said, in a few words: "opus put claude:fable first; google/gemini-4-argon couldn't answer (timed out)". */
function answersText(answers: NonNullable<LedgerData["parliament.decided"]["advisors"]>): string {
  return answers
    .map(({ choice, ranking, error }) =>
      ranking?.[0]
        ? `${choice.model} put ${ranking[0]} first`
        : `${choice.model} couldn't answer (${error ?? "no ranking"})`,
    )
    .join("; ");
}

/** The person chose one of the level plans. */
export async function chooseLevelPlan(loop: Loop, job: JobRef, letter: string): Promise<void> {
  const entries = await entriesOf(loop, job);
  const option = planOptions(entries, job.jobId).get(letter);
  const { latest } = decidedOf(entries, job.jobId);
  if (!option || !latest) throw new Error(`Plan ${letter} is not in the job's record.`);
  await ledgerOf(loop, job).record({
    kind: "parliament.decided",
    taskId: job.jobId,
    data: {
      seats: [...latest.seats],
      plan: option.plan,
      winner: option.seat,
      ...(latest.tied ? { tied: latest.tied } : {}),
      ...(latest.advisors ? { advisors: latest.advisors } : {}),
    },
  });
  return divideJob(loop, job);
}
