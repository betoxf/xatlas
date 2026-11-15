import { stepTaskId } from "@zcode/orchestrator/board";
import {
  checkDivision,
  divisionPrompt,
  readDivisionReply,
  splitBeyond,
} from "@zcode/orchestrator/division";
import { seatId } from "@zcode/orchestrator/oversight";
import { pickParliament } from "@zcode/orchestrator/routing";
import { replay } from "@zcode/orchestrator/tasks";
import type { LedgerEntry, ModelChoice, PlanStep } from "@zcode/orchestrator/types";
import {
  entriesOf,
  errorText,
  jobClosed,
  ledgerOf,
  openDecision,
  signalOf,
  taskIn,
  type JobRef,
  type Loop,
} from "./context.js";
import { decidedOf } from "./jobView.js";
import { advanceJob } from "./steps.js";

/** The longest key kept, so `<jobId>.<key>` stays a valid run identity. */
const MAX_KEY = 40;

function cleanKey(key: string): string {
  const cleaned = key
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_KEY)
    .replace(/[-_]+$/g, "");
  return cleaned || "step";
}

/**
 * Keys a model wrote, made safe for task ids and branch names and unique against the tasks
 * the job already has, with `dependsOn` following the renames. A dependency on a key that is
 * not a step is kept as written, so `checkDivision` names it.
 */
export function cleanSteps(steps: readonly PlanStep[], taken: ReadonlySet<string>): PlanStep[] {
  const used = new Set(taken);
  const renamed = new Map<string, string>();
  const keys = steps.map((step) => {
    const base = cleanKey(step.key);
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
    used.add(key);
    if (!renamed.has(step.key)) renamed.set(step.key, key);
    return key;
  });
  return steps.map((step, index) => ({
    ...step,
    key: keys[index]!,
    dependsOn: step.dependsOn.map((dependency) => renamed.get(dependency) ?? dependency),
  }));
}

/** The keys a job's steps already use. */
function takenKeys(entries: readonly LedgerEntry[], jobId: string): Set<string> {
  const prefix = `${jobId}.`;
  return new Set(
    replay(entries)
      .tasks.filter((task) => task.parentId === jobId && task.id.startsWith(prefix))
      .map((task) => task.id.slice(prefix.length)),
  );
}

/** Who divides: the seat that wrote the plan when it can run, else the first seat that can. */
async function divider(loop: Loop, job: JobRef, winner: string | undefined) {
  const roles = await loop.roles.get(job.key);
  const { seats } = pickParliament(roles, await loop.host.agents(), { now: loop.now() });
  const proposing = seats.filter((seat) => !seat.votesOnly);
  return proposing.find((seat) => seatId(seat) === winner) ?? proposing[0];
}

/**
 * Asks for the steps and checks them. An unreadable or broken division becomes one step that
 * owns the whole repository; `undefined` only when no model could be asked at all. Callers
 * pass the plan without its ideas beyond the request (`splitBeyond`), in `single` too.
 */
export async function askDivision(
  loop: Loop,
  job: JobRef,
  input: { readonly task: string; readonly plan: string; readonly winner?: string },
  taken: ReadonlySet<string>,
  single: PlanStep,
): Promise<{ steps: PlanStep[]; note?: string } | { failed: string }> {
  const seat: ModelChoice | undefined = await divider(loop, job, input.winner);
  if (!seat) return { failed: "no parliament seat can run to divide the plan" };
  let reply: string;
  try {
    reply = await loop.host.ask(seat, divisionPrompt({ task: input.task, plan: input.plan }), {
      cwd: job.project.workspacePath,
      signal: signalOf(loop, job),
    });
  } catch (error) {
    return { failed: `${seatId(seat)} couldn't divide it: ${errorText(error)}` };
  }
  const read = readDivisionReply(reply);
  const steps = read ? cleanSteps(read.steps, taken) : undefined;
  const problems = steps ? checkDivision(steps) : [];
  if (steps && problems.length === 0) {
    return { steps, ...(read?.note ? { note: read.note } : {}) };
  }
  const [one] = cleanSteps([single], taken);
  return {
    steps: [one!],
    note: read
      ? `The division had problems (${problems.map((problem) => problem.detail).join(" ")}), so the work runs as one step.`
      : "The division couldn't be read, so the work runs as one step.",
  };
}

/**
 * Writes the steps as tasks of the job, each `planned` so it can start once what it waits for
 * passed. A `dependsOn` that is a key of these steps names that step; anything else is a task
 * id of a step that stays (a division made again keeps those). Writing again changes nothing,
 * so a division saved before a restart can be written out after it.
 */
export async function createSteps(
  loop: Loop,
  job: JobRef,
  steps: readonly PlanStep[],
): Promise<void> {
  const project = ledgerOf(loop, job);
  const keys = new Set(steps.map((step) => step.key));
  for (const step of steps) {
    const task = await project.createTask({
      id: stepTaskId(job.jobId, step.key),
      title: step.title,
      brief: step.brief,
      route: "orchestrated",
      parentId: job.jobId,
      dependsOn: step.dependsOn.map((dependency) =>
        keys.has(dependency) ? stepTaskId(job.jobId, dependency) : dependency,
      ),
      owns: step.owns,
    });
    if (task.state === "idea") await project.moveTask(task.id, "planned");
  }
}

/** Writes out every division the job saved whose steps are not all tasks yet (after a restart). */
export async function materializeDivisions(loop: Loop, job: JobRef): Promise<void> {
  for (const entry of await entriesOf(loop, job)) {
    if (entry.kind === "plan.divided" && entry.taskId === job.jobId) {
      await createSteps(loop, job, entry.data.steps);
    }
  }
  if (taskIn(await entriesOf(loop, job), job.jobId)?.state === "idea") {
    await ledgerOf(loop, job).moveTask(job.jobId, "planned");
  }
}

export async function divideJob(loop: Loop, job: JobRef): Promise<void> {
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) return;
  const task = taskIn(entries, job.jobId)!;
  const { won } = decidedOf(entries, job.jobId);
  if (!won) throw new Error("the job has no plan to divide");
  // The ideas beyond the request stay with the person: neither the divider nor a brief gets them.
  const work = splitBeyond(won.plan).work;
  const result = await askDivision(
    loop,
    job,
    { task: task.brief, plan: work, ...(won.winner ? { winner: won.winner } : {}) },
    takenKeys(entries, job.jobId),
    {
      key: "all",
      title: task.title,
      brief: `${task.brief}\n\nThe plan:\n${work}`,
      dependsOn: [],
      owns: [],
    },
  );
  if (signalOf(loop, job).aborted) return;
  if ("failed" in result) {
    await openDecision(loop, job, {
      about: "retry",
      kind: "blocked",
      stage: "divide",
      question: `The plan couldn't be divided into steps: ${result.failed}. Try again, or stop the job.`,
      options: ["retry", "stop-job"],
    });
    return;
  }
  // A stop that came while the divider was thinking must not leave steps behind.
  if (jobClosed(await entriesOf(loop, job), job.jobId)) return;
  const project = ledgerOf(loop, job);
  await project.record({
    kind: "plan.divided",
    taskId: job.jobId,
    data: { steps: result.steps, ...(result.note ? { note: result.note } : {}) },
  });
  await createSteps(loop, job, result.steps);
  if (taskIn(await entriesOf(loop, job), job.jobId)?.state === "idea") {
    await project.moveTask(job.jobId, "planned");
  }
  return advanceJob(loop, job);
}
