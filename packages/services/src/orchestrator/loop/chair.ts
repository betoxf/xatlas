import { boardDigest, jobSteps } from "@zcode/orchestrator/board";
import {
  chairPrompt,
  finalReadPrompt,
  pickChair,
  readRuling,
  rulingsLeft,
  seatId,
  type ChairPick,
  type Dispute,
  type FinishedStep,
} from "@zcode/orchestrator/oversight";
import {
  MAX_REVIEW_ROUNDS,
  type AgentId,
  type LedgerEntry,
  type ParliamentSeat,
  type ReviewFinding,
  type RoleSettings,
} from "@zcode/orchestrator/types";
import {
  background,
  entriesOf,
  errorText,
  inChair,
  inJob,
  jobClosed,
  ledgerOf,
  openDecision,
  runIn,
  signalOf,
  taskIn,
  type JobRef,
  type Loop,
} from "./context.js";
import { decidedOf } from "./jobView.js";
import { deliver } from "./guard.js";
import { disputeRulingMessage, finalReadMessage } from "./prompts.js";
import { finalSentNote, finalSentTo } from "./records.js";
import { finishJob, moveTaskTo, reassignStep, redivide, setRunState, stepsOfJob } from "./steps.js";
import { passByRuling, reviewRound, sendFindings, watchTurn } from "./turns.js";

/**
 * The seats that may chair: the parliament that sat, then the project's other seats. A job one
 * model planned recorded only that seat, which can never chair its own plan, so the roster is
 * needed for anyone to chair at all.
 */
function chairSeats(entries: readonly LedgerEntry[], jobId: string, roles: RoleSettings) {
  const { won, latest } = decidedOf(entries, jobId);
  const seats: ParliamentSeat[] = [];
  const seen = new Set<string>();
  for (const seat of [...((won ?? latest)?.seats ?? []), ...roles.parliament]) {
    const id = `${seatId(seat)}${seat.votesOnly ? "+vote" : ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    seats.push(seat);
  }
  return { seats, winner: won?.winner, plan: won?.plan ?? latest?.plan ?? "" };
}

async function pick(loop: Loop, job: JobRef, executorRunId: string | undefined) {
  const entries = await entriesOf(loop, job);
  const roles = await loop.roles.get(job.key);
  const { seats, winner, plan } = chairSeats(entries, job.jobId, roles);
  const executor = executorRunId ? runIn(entries, executorRunId)?.choice : undefined;
  const firstExecutor = jobSteps(entries, job.jobId).find((step) => step.run)?.run?.choice;
  const chosen: ChairPick = pickChair({
    seats,
    ...(winner ? { winner } : {}),
    executor: executor ?? firstExecutor ?? roles.executor[0] ?? { agent: "claude" },
    agents: await loop.host.agents(),
    now: loop.now(),
  });
  return { chosen, plan, entries };
}

/** The chair's answer, or why there is none. */
async function askChair(
  loop: Loop,
  job: JobRef,
  chosen: Extract<ChairPick, { ok: true }>,
  prompt: string,
  trigger: Parameters<typeof readRuling>[1],
) {
  let reply: string;
  try {
    reply = await loop.host.ask(chosen.seat, prompt, {
      cwd: job.project.workspacePath,
      signal: signalOf(loop, job),
    });
  } catch (error) {
    return { why: `The chair (${chosen.chair}) couldn't be asked: ${errorText(error)}.` };
  }
  const ruling = readRuling(reply, trigger);
  return ruling ? { ruling } : { why: `The chair's (${chosen.chair}) ruling couldn't be read.` };
}

/** What the ruling says, with the reason for a relaxed pick: the ledger has no other place for it. */
function rulingText(
  title: string | undefined,
  text: string,
  chosen: Extract<ChairPick, { ok: true }>,
) {
  const body = title ? `Step "${title}": ${text}` : text;
  return chosen.relaxed ? `${body} (${chosen.reason})` : body;
}

/** Round three still had blockers: the chair rules, or the person does. */
export function chairStuck(
  loop: Loop,
  job: JobRef,
  executorRunId: string,
  findings: readonly ReviewFinding[],
): Promise<void> {
  return inChair(loop, job, async () => {
    const { chosen, plan, entries } = await pick(loop, job, executorRunId);
    const run = runIn(entries, executorRunId)!;
    const task = taskIn(entries, run.taskId)!;
    const project = ledgerOf(loop, job);
    const toPerson = async (why: string) => {
      const reviewer = entries.findLast(
        (entry) =>
          entry.kind === "run.started" &&
          entry.taskId === task.id &&
          entry.data.role === "reviewer",
      );
      if (reviewer?.kind === "run.started") await setRunState(project, reviewer.runId, "waiting");
      await openDecision(loop, job, {
        about: "chair-step",
        kind: "chair",
        taskId: task.id,
        runId: run.id,
        question: `Step "${task.title}" still has blockers after ${MAX_REVIEW_ROUNDS} review rounds. ${why} Send the findings back once more, pass it as it is, give it to another executor, or stop it.`,
        options: ["fix", "drop", "reassign", "stop-step"],
      });
    };
    if (rulingsLeft(entries, job.jobId) === 0) {
      return toPerson("The chair has no rulings left in this job, so you decide.");
    }
    if (!chosen.ok) return toPerson(chosen.reason);
    const review = entries.findLast(
      (entry) => entry.kind === "review.decided" && entry.runId === run.id,
    );
    const answer = await askChair(
      loop,
      job,
      chosen,
      chairPrompt({
        trigger: "round-three-failed",
        plan,
        step: {
          key: task.id.slice(job.jobId.length + 1),
          title: task.title,
          brief: task.brief,
          owns: task.owns,
          ...(run.branch ? { branch: run.branch } : {}),
          ...(review?.kind === "review.decided" ? { commit: review.data.commit } : {}),
        },
        findings,
      }),
      "round-three-failed",
    );
    if (signalOf(loop, job).aborted || jobClosed(await entriesOf(loop, job), job.jobId)) return;
    if (!answer.ruling) return toPerson(answer.why);
    const { ruling } = answer;
    const text = rulingText(task.title, ruling.text, chosen);
    await project.record({
      kind: "chair.ruled",
      taskId: job.jobId,
      runId: run.id,
      data: { trigger: "round-three-failed", ruling: ruling.ruling, text, chair: chosen.chair },
    });
    switch (ruling.ruling) {
      case "fix":
        return sendFindings(
          loop,
          job,
          run.id,
          findings,
          `The chair (${chosen.chair}) ruled: ${ruling.text}`,
        );
      case "drop":
        return passByRuling(loop, job, run.id);
      case "reassign":
      case "redivide":
        return takeOver(loop, job, task.id, run.choice.agent, ruling.ruling, ruling.text);
      default:
        return toPerson(`The chair (${chosen.chair}) passed it to you: ${ruling.text}`);
    }
  });
}

/**
 * The chair gave the step to another executor, or asked for the rest to be divided again. Both
 * run on the job's queue, which starts executors; a failure there is a decision to retry.
 * Redivide's has no step, so "try again" moves the job on, which shows what is stuck.
 */
function takeOver(
  loop: Loop,
  job: JobRef,
  taskId: string,
  agent: AgentId,
  ruling: "reassign" | "redivide",
  text: string,
): void {
  if (ruling === "reassign") {
    return background(
      loop,
      job,
      { stage: "start", taskId, what: "giving the step to a new executor" },
      () => inJob(loop, job, () => reassignStep(loop, job, taskId, agent)),
    );
  }
  return background(loop, job, { stage: "start", what: "dividing the rest again" }, () =>
    inJob(loop, job, () => redivide(loop, job, taskId, text)),
  );
}

/**
 * The executor disputes findings: the chair rules on each, within the job's rulings. Fixes go
 * back to the executor together; when every dispute was dropped the step goes to review. A
 * "reassign" or "redivide" ends the old run there, with the disputes after it. A
 * dispute the chair can't settle goes to the person; the disputes after it in the same reply
 * are not ruled on (the next review round looks at those findings again).
 */
export function chairDisputes(
  loop: Loop,
  job: JobRef,
  executorRunId: string,
  disputes: readonly Dispute[],
  findings: readonly ReviewFinding[],
): Promise<void> {
  return inChair(loop, job, async () => {
    const project = ledgerOf(loop, job);
    const fixes: string[] = [];
    for (const dispute of disputes) {
      const { chosen, plan, entries } = await pick(loop, job, executorRunId);
      const run = runIn(entries, executorRunId)!;
      const task = taskIn(entries, run.taskId)!;
      const toPerson = async (why: string) => {
        await setRunState(project, run.id, "waiting", "A disputed finding waits on the person.");
        for (const text of fixes) {
          await project.record({
            kind: "note",
            taskId: task.id,
            data: { from: "orchestrator", to: task.id, text },
          });
        }
        await openDecision(loop, job, {
          about: "dispute",
          kind: "chair",
          taskId: task.id,
          runId: run.id,
          findingId: dispute.findingId,
          question: `Step "${task.title}"'s executor disputes finding ${dispute.findingId}: "${dispute.reason || "no reason given"}". ${why} Does the finding stand?`,
          options: ["keep", "drop-finding"],
        });
      };
      if (rulingsLeft(entries, job.jobId) === 0) {
        return toPerson("The chair has no rulings left in this job, so you decide.");
      }
      if (!chosen.ok) return toPerson(chosen.reason);
      const answer = await askChair(
        loop,
        job,
        chosen,
        chairPrompt({
          trigger: "finding-disputed",
          plan,
          step: {
            key: task.id.slice(job.jobId.length + 1),
            title: task.title,
            brief: task.brief,
            owns: task.owns,
            ...(run.branch ? { branch: run.branch } : {}),
          },
          findings: findings.filter((finding) => finding.id === dispute.findingId),
          dispute,
        }),
        "finding-disputed",
      );
      if (signalOf(loop, job).aborted || jobClosed(await entriesOf(loop, job), job.jobId)) return;
      if (!answer.ruling) return toPerson(answer.why);
      const { ruling } = answer;
      if (ruling.ruling === "owner") {
        await project.record({
          kind: "chair.ruled",
          taskId: job.jobId,
          runId: run.id,
          data: {
            trigger: "finding-disputed",
            ruling: "owner",
            text: rulingText(task.title, ruling.text, chosen),
            chair: chosen.chair,
            findingId: dispute.findingId,
          },
        });
        return toPerson(`The chair (${chosen.chair}) passed it to you: ${ruling.text}`);
      }
      await project.record({
        kind: "chair.ruled",
        taskId: job.jobId,
        runId: run.id,
        data: {
          trigger: "finding-disputed",
          ruling: ruling.ruling,
          text: rulingText(task.title, ruling.text, chosen),
          chair: chosen.chair,
          findingId: dispute.findingId,
        },
      });
      // Another executor, or a new division: the disputes after this one go with the old run.
      if (ruling.ruling === "reassign" || ruling.ruling === "redivide") {
        return takeOver(loop, job, task.id, run.choice.agent, ruling.ruling, ruling.text);
      }
      if (ruling.ruling === "fix") {
        fixes.push(
          disputeRulingMessage({
            findingId: dispute.findingId,
            text: ruling.text,
            by: `The chair (${chosen.chair})`,
          }),
        );
      }
    }
    if (fixes.length > 0) {
      const entries = await entriesOf(loop, job);
      const run = runIn(entries, executorRunId)!;
      if (!(await deliver(loop, job, run.id, run.conversationId!, fixes.join("\n\n")))) return;
      await setRunState(project, run.id, "working");
      watchTurn(loop, job, {
        taskId: run.taskId,
        runId: run.id,
        role: "executor",
        conversationId: run.conversationId!,
      });
      return;
    }
    return reviewRound(loop, job, executorRunId);
  });
}

/** The person ruled on a dispute the chair could not. */
export async function personDispute(
  loop: Loop,
  job: JobRef,
  executorRunId: string,
  findingId: string,
  stands: boolean,
): Promise<void> {
  if (!stands) return reviewRound(loop, job, executorRunId);
  const entries = await entriesOf(loop, job);
  const run = runIn(entries, executorRunId);
  if (!run?.conversationId) return;
  const text = `${disputeRulingMessage({ findingId, text: "the person decided it.", by: "The person" })}\n\nThe board digest:\n${boardDigest(entries, run.taskId)}`;
  if (!(await deliver(loop, job, run.id, run.conversationId, text))) return;
  await setRunState(ledgerOf(loop, job), run.id, "working");
  watchTurn(loop, job, {
    taskId: run.taskId,
    runId: run.id,
    role: "executor",
    conversationId: run.conversationId,
  });
}

/** Whether every step that is not cancelled passed review, and there is one. */
function allPassed(entries: readonly LedgerEntry[], jobId: string): boolean {
  const live = stepsOfJob(entries, jobId).filter((step) => step.state !== "cancelled");
  return live.length > 0 && live.every((step) => step.state === "queued");
}

/**
 * Every step passed: the chair reads the whole work against the plan, once per job (job queue
 * only). "pass" finishes the job; anything else is the person's to decide. When the steps pass
 * again after the person sent that read's findings back, the person is asked to accept the
 * work; the chair is not asked a second time.
 */
export function finalRead(loop: Loop, job: JobRef): Promise<void> {
  return inChair(loop, job, async () => {
    const project = ledgerOf(loop, job);
    const before = await entriesOf(loop, job);
    // Never with a step still working: its work would be left out of the read.
    if (jobClosed(before, job.jobId) || !allPassed(before, job.jobId)) return;
    await moveTaskTo(project, job.jobId, "in_review");
    const toPerson = (question: string, options: Parameters<typeof openDecision>[2]["options"]) =>
      openDecision(loop, job, { about: "final-read", kind: "chair", question, options });
    const read = before.some(
      (entry) =>
        entry.kind === "chair.ruled" &&
        entry.taskId === job.jobId &&
        entry.data.trigger === "final-read",
    );
    if (read) {
      return toPerson(
        "Every step passed review again after the final read's findings. Accept the work?",
        ["accept", "stop-job"],
      );
    }
    const { chosen, plan, entries } = await pick(loop, job, undefined);
    if (!chosen.ok) {
      return toPerson(`${chosen.reason} Nobody can do the final read of the whole work.`, [
        "accept",
        "stop-job",
      ]);
    }
    const steps: FinishedStep[] = jobSteps(entries, job.jobId)
      .filter((step) => step.state === "queued" && step.run?.branch && step.review)
      .map((step) => ({
        key: step.taskId.slice(job.jobId.length + 1),
        title: step.title,
        brief: step.brief,
        owns: step.owns,
        branch: step.run!.branch!,
        commit: step.review!.commit,
      }));
    const answer = await askChair(
      loop,
      job,
      chosen,
      finalReadPrompt({ plan, steps }),
      "final-read",
    );
    if (signalOf(loop, job).aborted || jobClosed(await entriesOf(loop, job), job.jobId)) return;
    if (!answer.ruling)
      return toPerson(`${answer.why} Ask for the final read again, or accept the work.`, [
        "retry",
        "accept",
      ]);
    const text = rulingText(undefined, answer.ruling.text, chosen);
    await project.record({
      kind: "chair.ruled",
      taskId: job.jobId,
      data: { trigger: "final-read", ruling: answer.ruling.ruling, text, chair: chosen.chair },
    });
    if (answer.ruling.ruling === "pass") return finishJob(loop, job);
    return toPerson(`The chair's final read (${chosen.chair}): ${answer.ruling.text}`, [
      "send",
      "accept",
    ]);
  });
}

/**
 * The person sends the final read's findings to every step's executor (job queue only). Each
 * delivery is recorded, so a retry after a failed one sends only to the steps still missing it.
 */
export async function sendFinal(loop: Loop, job: JobRef): Promise<void> {
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) return;
  const ruling = entries.findLast(
    (entry) =>
      entry.kind === "chair.ruled" &&
      entry.taskId === job.jobId &&
      entry.data.trigger === "final-read",
  );
  if (ruling?.kind !== "chair.ruled") return;
  const sent = finalSentTo(entries, ruling.id);
  const project = ledgerOf(loop, job);
  await moveTaskTo(project, job.jobId, "working");
  for (const step of jobSteps(entries, job.jobId)) {
    const run = step.run;
    if (step.state !== "queued" || sent.has(step.taskId) || !run?.conversationId) continue;
    const text = finalReadMessage({
      text: ruling.data.text,
      digest: boardDigest(await entriesOf(loop, job), step.taskId),
    });
    if (!(await deliver(loop, job, run.runId, run.conversationId, text))) continue;
    await project.record(finalSentNote(job.jobId, ruling.id, step.taskId));
    await moveTaskTo(project, step.taskId, "working");
    await setRunState(project, run.runId, "working");
    watchTurn(loop, job, {
      taskId: step.taskId,
      runId: run.runId,
      role: "executor",
      conversationId: run.conversationId,
    });
  }
}
