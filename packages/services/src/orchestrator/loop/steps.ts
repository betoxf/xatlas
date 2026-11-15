import { boardDigest, stepTaskId, stepsToStart, type StepStart } from "@zcode/orchestrator/board";
import { checkDivision, splitBeyond } from "@zcode/orchestrator/division";
import { passes } from "@zcode/orchestrator/oversight";
import { pickRole } from "@zcode/orchestrator/routing";
import { replay, type Project } from "@zcode/orchestrator/tasks";
import {
  RUN_MOVES,
  TASK_MOVES,
  type AgentId,
  type LedgerEntry,
  type PlanStep,
  type Run,
  type RunState,
  type TaskState,
} from "@zcode/orchestrator/types";
import { branchName, createWorktreeManager } from "@zcode/orchestrator/worktrees";
import {
  background,
  closeDecisions,
  entriesOf,
  errorText,
  inJob,
  jobClosed,
  ledgerOf,
  openDecision,
  signalOf,
  taskIn,
  abortJob,
  type JobRef,
  type OpenDecisionInput,
  type Loop,
} from "./context.js";
import { askDivision, createSteps } from "./divide.js";
import { decidedOf, STOPPED_REASON } from "./jobView.js";
import { executorBrief, trailerLines } from "./prompts.js";
import { claimRun, ClaimRefused, inSend, interrupt } from "./guard.js";
import { baseNote, openDecisions } from "./records.js";
import { startCommit } from "./gitFacts.js";
import { finalRead } from "./chair.js";
import { watchTurn } from "./turns.js";

/** How often `adopt` is tried: it undoes itself when the agent commits while it runs. */
const ADOPT_ATTEMPTS = 4;

const FINAL_RUN: ReadonlySet<RunState> = new Set(["done", "failed", "stopped"]);

export function stepsOfJob(entries: readonly LedgerEntry[], jobId: string) {
  return replay(entries).tasks.filter((task) => task.parentId === jobId);
}

export function runsOfTask(entries: readonly LedgerEntry[], taskId: string): Run[] {
  return replay(entries).runs.filter((run) => run.taskId === taskId);
}

export function latestRun(
  entries: readonly LedgerEntry[],
  taskId: string,
  role: Run["role"],
): Run | undefined {
  return runsOfTask(entries, taskId).findLast((run) => run.role === role);
}

/** Moves a task to `to` along the allowed moves, through `planned` when it is still an idea. */
export async function moveTaskTo(project: Project, taskId: string, to: TaskState): Promise<void> {
  let task = (await project.state()).tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.state === to) return;
  if (task.state === "idea" && to !== "planned" && to !== "cancelled") {
    task = await project.moveTask(taskId, "planned");
  }
  if (TASK_MOVES[task.state].includes(to)) await project.moveTask(taskId, to);
}

/** Sets a run's state unless it is already there or has ended. */
export async function setRunState(
  project: Project,
  runId: string,
  to: RunState,
  reason?: string,
): Promise<void> {
  const run = (await project.state()).runs.find((candidate) => candidate.id === runId);
  if (!run || !RUN_MOVES[run.state].includes(to)) return;
  await project.updateRun(runId, { state: to, ...(reason ? { reason } : {}) });
}

/** Runs the job queue's `advanceJob` from outside it. */
export function kickJob(loop: Loop, job: JobRef): void {
  background(loop, job, { stage: "start", what: "moving the job on" }, () =>
    inJob(loop, job, () => advanceJob(loop, job)),
  );
}

/**
 * Moves the job on from what the ledger says (job queue only): starts every step that can
 * start, all at once; begins the final read when every step passed; and asks the person when
 * a stopped step leaves the rest unable to go on.
 */
export async function advanceJob(loop: Loop, job: JobRef): Promise<void> {
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId) || signalOf(loop, job).aborted) return;
  const jobTask = taskIn(entries, job.jobId)!;
  const open = openDecisions(entries, job.jobId);
  const held = new Set(open.flatMap((decision) => (decision.taskId ? [decision.taskId] : [])));
  const starts = stepsToStart(entries, job.jobId).filter((start) => !held.has(start.taskId));
  if (starts.length > 0) {
    if (jobTask.state === "planned") await ledgerOf(loop, job).moveTask(job.jobId, "working");
    await Promise.all(
      starts.map((start) =>
        startStep(loop, job, start).catch((error: unknown) =>
          stepFailed(loop, job, start.taskId, `starting it`, error),
        ),
      ),
    );
    return;
  }
  const steps = stepsOfJob(entries, job.jobId);
  if (steps.length === 0 || jobTask.state !== "working") return;
  const live = steps.filter((step) => step.state !== "cancelled");
  // Never while the job waits on the person (a delivery to retry, a stuck step).
  const jobWaits = open.some((decision) => decision.taskId === undefined);
  if (live.length > 0 && live.every((step) => step.state === "queued")) {
    return jobWaits ? undefined : finalRead(loop, job);
  }
  const moving = live.some(
    (step) => step.state === "working" || step.state === "in_review" || held.has(step.id),
  );
  if (moving || open.length > 0 || live.length === steps.length) return;
  const stopped = steps
    .filter((step) => step.state === "cancelled")
    .map((step) => `"${step.title}"`);
  const passed = live.filter((step) => step.state === "queued").length;
  await openDecision(loop, job, {
    about: "stuck",
    kind: "blocked",
    question: `The job can't go on: ${stopped.join(", ")} ${stopped.length === 1 ? "was" : "were"} stopped, and the steps waiting for ${stopped.length === 1 ? "it" : "them"} can't start.${passed > 0 ? ` ${passed} ${passed === 1 ? "step" : "steps"} passed review.` : ""}`,
    options: passed > 0 ? ["accept", "stop-job"] : ["stop-job"],
  });
}

/** A step's part of the loop failed: the person sees it and can try again or stop the step. */
export async function stepFailed(
  loop: Loop,
  job: JobRef,
  taskId: string,
  what: string,
  error: unknown,
): Promise<void> {
  if (signalOf(loop, job).aborted || jobClosed(await entriesOf(loop, job), job.jobId)) return;
  const title = taskIn(await entriesOf(loop, job), taskId)?.title ?? taskId;
  await openDecision(loop, job, {
    about: "retry",
    kind: "blocked",
    stage: "start",
    taskId,
    question: `Step "${title}" failed while ${what}: ${errorText(error)}. Try again, or stop the step.`,
    options: ["retry", "stop-step"],
  });
}

/**
 * Starts a step's executor: claims the step with `run.started` before anything else (so it is
 * never started twice), keeps the commit it starts from, starts the conversation with its
 * brief, and gives the host's detached worktree the run's branch.
 */
export async function startStep(
  loop: Loop,
  job: JobRef,
  start: StepStart,
  avoid?: AgentId,
): Promise<void> {
  const signal = signalOf(loop, job);
  let entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId) || signal.aborted) return;
  const task = taskIn(entries, start.taskId);
  if (!task || task.state === "cancelled" || task.state === "queued") return;
  const blocked = (question: string) =>
    openDecision(loop, job, {
      about: "retry",
      kind: "blocked",
      stage: "start",
      taskId: task.id,
      question,
      options: ["retry", "stop-step"],
    });

  const roles = await loop.roles.get(job.key);
  const pick = pickRole("executor", roles, await loop.host.agents(), {
    now: loop.now(),
    ...(avoid ? { avoid } : {}),
  });
  if (!pick.ok) return blocked(`Step "${task.title}" can't start: ${pick.reason}`);
  const begin = await startCommit(
    loop.host.git,
    job.project.workspacePath,
    start,
    `step "${task.title}"`,
  );
  if (!begin.ok) return blocked(begin.reason);

  const project = ledgerOf(loop, job);
  const choice = pick.choice;
  const runId = loop.newId();
  const identity = {
    runId,
    taskId: task.id,
    agent: choice.agent,
    ...(choice.model ? { model: choice.model } : {}),
  };
  const branch = branchName(identity);
  try {
    await claimRun(loop, job, { id: runId, taskId: task.id, role: "executor", choice });
  } catch (error) {
    // Another instance owns the job or started the step first: this one backs off.
    if (error instanceof ClaimRefused) return;
    throw error;
  }
  await project.record(baseNote(task.id, runId, begin.sha));
  await moveTaskTo(project, task.id, "working");
  entries = await entriesOf(loop, job);
  const text = executorBrief({
    job: taskIn(entries, job.jobId)?.brief ?? "",
    title: task.title,
    brief: task.brief,
    owns: task.owns,
    branch,
    trailers: trailerLines(identity),
    digest: boardDigest(entries, task.id),
  });

  let started: { conversationId: string; worktreePath: string };
  try {
    started = await loop.host.startExecutor({
      project: job.project,
      ref: begin.sha,
      title: task.title,
      text,
      choice,
    });
  } catch (error) {
    await setRunState(
      project,
      runId,
      "failed",
      `The executor couldn't start: ${errorText(error)}.`,
    );
    return blocked(`Step "${task.title}"'s executor couldn't start: ${errorText(error)}.`);
  }

  /** Stops the new conversation; when the host refuses, the person is told and can stop it again. */
  const stop = async (): Promise<boolean> => {
    if (await interrupt(loop, job, started.conversationId)) return true;
    await openDecision(loop, job, {
      about: "stop-failed",
      kind: "blocked",
      taskId: task.id,
      runId,
      question: `Step "${task.title}"'s executor conversation couldn't be stopped. Stop it in the app, or try again.`,
      options: ["stop-step"],
    });
    return false;
  };
  try {
    await project.updateRun(runId, {
      conversationId: started.conversationId,
      worktreePath: started.worktreePath,
    });
  } catch (error) {
    // The job was stopped while the conversation started: it must not go on working.
    if (signal.aborted || jobClosed(await entriesOf(loop, job), job.jobId)) {
      await stop();
      return;
    }
    throw error;
  }

  const manager = createWorktreeManager({ git: loop.host.git });
  let adopted = false;
  let problem: unknown;
  for (let attempt = 0; attempt < ADOPT_ATTEMPTS && !adopted; attempt += 1) {
    try {
      await manager.adopt({
        repoPath: job.project.workspacePath,
        path: started.worktreePath,
        identity,
      });
      adopted = true;
    } catch (error) {
      problem = error;
    }
  }
  if (!adopted) {
    if (!(await stop())) return;
    await setRunState(
      project,
      runId,
      "failed",
      `Its worktree couldn't get its branch: ${errorText(problem)}.`,
    );
    return blocked(
      `Step "${task.title}"'s worktree couldn't get its branch ${branch}: ${errorText(problem)}.`,
    );
  }
  if (signal.aborted || jobClosed(await entriesOf(loop, job), job.jobId)) {
    await stop();
    return;
  }
  await project.updateRun(runId, { state: "working", branch });
  watchTurn(loop, job, {
    taskId: task.id,
    runId,
    role: "executor",
    conversationId: started.conversationId,
  });
}

/**
 * Stops every run of a step that has not ended. A run is marked stopped only once its
 * conversation was interrupted; one the host refused to stop stays as it is, so it can be
 * stopped again, and is returned.
 */
async function stopRuns(loop: Loop, job: JobRef, taskId: string, reason: string): Promise<Run[]> {
  const project = ledgerOf(loop, job);
  const refused: Run[] = [];
  for (const run of runsOfTask(await entriesOf(loop, job), taskId)) {
    if (FINAL_RUN.has(run.state)) continue;
    if (run.conversationId && !(await interrupt(loop, job, run.conversationId))) {
      refused.push(run);
      continue;
    }
    await setRunState(project, run.id, "stopped", reason).catch(() => undefined);
  }
  return refused;
}

function refusedText(runs: readonly Run[]): string {
  return runs.map((run) => `the ${run.role} of ${run.taskId}`).join(", ");
}

/** The host refused to stop a step's runs: nothing goes on until the person stops them. */
async function stopRefused(
  loop: Loop,
  job: JobRef,
  taskId: string,
  runs: readonly Run[],
  options: OpenDecisionInput["options"],
): Promise<void> {
  const title = taskIn(await entriesOf(loop, job), taskId)?.title ?? taskId;
  await openDecision(loop, job, {
    about: "stop-failed",
    kind: "blocked",
    taskId,
    question: `Step "${title}" couldn't be stopped: the app refused to stop ${refusedText(runs)}. Stop ${runs.length === 1 ? "it" : "them"} in the app, or try again.`,
    options,
  });
}

const PASSED: ReadonlySet<TaskState> = new Set(["queued", "merged", "deployed", "checked"]);

/**
 * Where a step starts again: the same commits `stepsToStart` would name. A dependency counts
 * when its task passed (`queued` or later) on a review of its latest executor run.
 */
function restartOf(entries: readonly LedgerEntry[], taskId: string): StepStart {
  const task = taskIn(entries, taskId)!;
  const commits = task.dependsOn.map((dependency) => {
    const latest = latestRun(entries, dependency, "executor");
    const review = entries.findLast(
      (entry) =>
        entry.kind === "review.decided" &&
        entry.taskId === dependency &&
        entry.runId === latest?.id,
    );
    const state = taskIn(entries, dependency)?.state;
    if (
      review?.kind !== "review.decided" ||
      state === undefined ||
      !PASSED.has(state) ||
      !passes(review.data.findings)
    ) {
      throw new Error(`step ${dependency}, which it waits for, has not passed review`);
    }
    return review.data.commit;
  });
  return { taskId, startFrom: commits[0] ?? null, mergeIn: commits.slice(1) };
}

/**
 * Another executor takes the step (job queue only): the old runs stop, their branches and
 * worktrees stay, and a new run starts from the same commits in a new worktree.
 */
export async function reassignStep(
  loop: Loop,
  job: JobRef,
  taskId: string,
  avoid?: AgentId,
): Promise<void> {
  await closeDecisions(loop, job, taskId);
  const refused = await stopRuns(loop, job, taskId, "Another executor takes the step.");
  if (refused.length > 0) return stopRefused(loop, job, taskId, refused, ["reassign", "stop-step"]);
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) return;
  await startStep(loop, job, restartOf(entries, taskId), avoid);
}

/** Stops one step for good; the job goes on with the steps that don't need it. */
export async function stopStep(loop: Loop, job: JobRef, taskId: string): Promise<void> {
  await closeDecisions(loop, job, taskId);
  const refused = await stopRuns(loop, job, taskId, "The person stopped the step.");
  if (refused.length > 0) return stopRefused(loop, job, taskId, refused, ["stop-step"]);
  await moveTaskTo(ledgerOf(loop, job), taskId, "cancelled");
  return advanceJob(loop, job);
}

/** Every run of the job ends as done and the job is `queued`: reviewed, waiting for the release queue. */
export async function finishJob(loop: Loop, job: JobRef): Promise<void> {
  const project = ledgerOf(loop, job);
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) return;
  for (const step of stepsOfJob(entries, job.jobId)) {
    for (const run of runsOfTask(entries, step.id)) {
      await setRunState(project, run.id, "done", "The job is finished.");
    }
  }
  await closeDecisions(loop, job);
  await moveTaskTo(project, job.jobId, "in_review");
  await moveTaskTo(project, job.jobId, "queued");
}

/**
 * Stops the whole job, at any moment: its model asks and turn waits are aborted, every run is
 * interrupted and stopped, the steps that had not passed are cancelled, and so is the job.
 * Branches and worktrees stay.
 */
export async function stopJob(loop: Loop, job: JobRef, reason = STOPPED_REASON): Promise<void> {
  abortJob(loop, job);
  // A message already on its way finishes first; every later one sees the stop.
  await inSend(loop, job, async () => undefined);
  const project = ledgerOf(loop, job);
  let entries = await entriesOf(loop, job);
  if (!taskIn(entries, job.jobId)) throw new Error("There is no such job in this project.");
  const refused: Run[] = [];
  for (const step of stepsOfJob(entries, job.jobId)) {
    refused.push(...(await stopRuns(loop, job, step.id, reason)));
  }
  entries = await entriesOf(loop, job);
  for (const step of stepsOfJob(entries, job.jobId)) {
    if (step.state !== "queued" && step.state !== "cancelled" && step.state !== "merged") {
      await project.moveTask(step.id, "cancelled", reason).catch(() => undefined);
    }
  }
  const state = taskIn(await entriesOf(loop, job), job.jobId)?.state;
  if (state !== "cancelled" && state !== "queued" && state !== "merged") {
    await project.moveTask(job.jobId, "cancelled", reason).catch(() => undefined);
  }
  if (refused.length > 0) {
    throw new Error(
      `The job is stopped, but the app refused to stop ${refusedText(refused)}. Stop ${refused.length === 1 ? "it" : "them"} in the app, or stop the job again.`,
    );
  }
}

/**
 * The chair ruled "redivide" (job queue only): the stuck step and the steps not yet started
 * are cancelled, and the work they held is divided again. What the cancelled steps waited for
 * among the steps that stay, the new steps that wait on nothing wait for too, and the new
 * division is checked together with the steps still running.
 */
export async function redivide(
  loop: Loop,
  job: JobRef,
  taskId: string,
  ruling: string,
): Promise<void> {
  let entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) return;
  const project = ledgerOf(loop, job);
  const stuck = taskIn(entries, taskId)!;
  const started = new Set(replay(entries).runs.map((run) => run.taskId));
  const unstarted = stepsOfJob(entries, job.jobId).filter(
    (step) => step.state === "planned" && !started.has(step.id),
  );
  await closeDecisions(loop, job, taskId);
  const refused = await stopRuns(
    loop,
    job,
    taskId,
    "The chair asked for the work to be divided again.",
  );
  if (refused.length > 0) return stopRefused(loop, job, taskId, refused, ["stop-step"]);
  const dropped = [stuck, ...unstarted];
  for (const step of dropped) await moveTaskTo(project, step.id, "cancelled");

  entries = await entriesOf(loop, job);
  const jobTask = taskIn(entries, job.jobId)!;
  const { won } = decidedOf(entries, job.jobId);
  const steps = stepsOfJob(entries, job.jobId);
  const passed = steps.filter((step) => step.state === "queued");
  const going = steps.filter((step) => step.state !== "queued" && step.state !== "cancelled");
  const droppedIds = new Set(dropped.map((step) => step.id));
  // What the cancelled steps waited for among the steps that stay.
  const external = [
    ...new Set(dropped.flatMap((step) => step.dependsOn.filter((id) => !droppedIds.has(id)))),
  ];
  const rest = dropped.map((step) => `- ${step.title}: ${step.brief}`).join("\n");
  const plan = [
    // The ideas beyond the request stay with the person.
    splitBeyond(won?.plan ?? jobTask.brief).work,
    "",
    `The chair asked for the rest of the work to be divided again: ${ruling}`,
    ...(passed.length > 0
      ? ["", "Already done and reviewed:", ...passed.map((step) => `- ${step.title}`)]
      : []),
    ...(going.length > 0
      ? [
          "",
          "Still being built (don't change what they own):",
          ...going.map(
            (step) => `- ${step.title}: ${step.owns.join(", ") || "the whole repository"}`,
          ),
        ]
      : []),
    "",
    "Divide only the work still to do:",
    rest,
  ].join("\n");
  const taken = new Set(steps.map((step) => step.id.slice(job.jobId.length + 1)));
  const restKey = taken.has("rest") ? `rest-${taken.size + 1}` : "rest";
  // The fallback waits on everything still going, so it never runs beside a step it could clash with.
  const single: PlanStep = {
    key: restKey,
    title: `Rest of "${jobTask.title}"`,
    brief: rest,
    dependsOn: [...new Set([...external, ...going.map((step) => step.id)])],
    owns: [],
  };
  const result = await askDivision(
    loop,
    job,
    { task: jobTask.brief, plan, ...(won?.winner ? { winner: won.winner } : {}) },
    taken,
    { ...single, dependsOn: [] },
  );
  if (jobClosed(await entriesOf(loop, job), job.jobId)) return;
  let divided = "failed" in result ? [single] : withExternal(result.steps, external);
  let note =
    "failed" in result
      ? ` The divider failed (${result.failed}), so the rest runs as one step.`
      : result.note
        ? ` ${result.note}`
        : "";
  const clash = "failed" in result ? [] : clashesWithGoing(job.jobId, divided, going);
  if (clash.length > 0) {
    divided = [single];
    note = ` The new steps clashed with the steps still going (${clash.join(" ")}), so the rest runs as one step after them.`;
  }
  await project.record({
    kind: "plan.divided",
    taskId: job.jobId,
    data: { steps: divided, note: `Divided again on the chair's ruling.${note}` },
  });
  await createSteps(loop, job, divided);
  return advanceJob(loop, job);
}

/** New steps that wait on nothing wait on what the cancelled steps waited for (task ids). */
function withExternal(steps: readonly PlanStep[], external: readonly string[]): PlanStep[] {
  return steps.map((step) =>
    step.dependsOn.length === 0 ? { ...step, dependsOn: [...external] } : step,
  );
}

/** What is wrong with the new steps beside the steps still going, all by task id. */
function clashesWithGoing(
  jobId: string,
  steps: readonly PlanStep[],
  going: ReadonlyArray<{
    id: string;
    title: string;
    brief: string;
    dependsOn: readonly string[];
    owns: readonly string[];
  }>,
): string[] {
  const keys = new Set(steps.map((step) => step.key));
  const goingIds = new Set(going.map((step) => step.id));
  const asTask = (dependency: string) =>
    keys.has(dependency) ? stepTaskId(jobId, dependency) : dependency;
  const known = (id: string) =>
    goingIds.has(id) || [...keys].some((key) => stepTaskId(jobId, key) === id);
  const graph: PlanStep[] = [
    ...going.map((step) => ({
      key: step.id,
      title: step.title,
      brief: step.brief,
      dependsOn: step.dependsOn.filter(known),
      owns: [...step.owns],
    })),
    ...steps.map((step) => ({
      ...step,
      key: stepTaskId(jobId, step.key),
      dependsOn: step.dependsOn.map(asTask).filter(known),
    })),
  ];
  return checkDivision(graph).map((problem) => problem.detail);
}
