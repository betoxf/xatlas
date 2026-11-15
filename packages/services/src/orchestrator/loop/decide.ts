import {
  background,
  entriesOf,
  inJob,
  inStep,
  jobClosed,
  ledgerOf,
  runIn,
  type JobRef,
  type Loop,
} from "./context.js";
import { finalRead, personDispute, sendFinal } from "./chair.js";
import { divideJob } from "./divide.js";
import { chooseLevelPlan, planJob } from "./plan.js";
import { answerNote, openDecisions, type DecisionRecord } from "./records.js";
import { advanceJob, finishJob, latestRun, reassignStep, stopJob, stopStep } from "./steps.js";
import { option } from "./options.js";
import {
  checkTurn,
  latestFindings,
  passByRuling,
  resumeRun,
  rewatchRun,
  reviewRound,
  sendFindings,
} from "./turns.js";

/** Records the person's answer and carries it out in the background. */
export async function decide(
  loop: Loop,
  job: JobRef,
  decisionId: string,
  optionId: string,
): Promise<void> {
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) {
    throw new Error("This job is finished or stopped, so nothing in it waits on you.");
  }
  const record = openDecisions(entries, job.jobId).find((decision) => decision.id === decisionId);
  if (!record) throw new Error("That decision is no longer open; refresh the job.");
  if (!record.options.some((option) => option.id === optionId)) {
    throw new Error("That is not one of the decision's options.");
  }
  const answer = answerNote(job.jobId, decisionId, optionId);
  // Checked inside the ledger's lock: two answers at once carry out only one.
  await loop.ledger.append(job.key, ({ entries: now }) => {
    if (now.some((entry) => entry.id === answer.id)) {
      throw new Error("That decision was already made.");
    }
    return answer;
  });
  // Stopping is done now, so a stop the app refused reaches the person as this call's error.
  if (optionId === option("stop-job")) return stopJob(loop, job);
  carryOut(loop, job, record, optionId);
}

function carryOut(loop: Loop, job: JobRef, record: DecisionRecord, optionId: string): void {
  const taskId = record.taskId;
  const onJob = (stage: Parameters<typeof background>[2]["stage"], work: () => Promise<void>) =>
    background(loop, job, { stage, what: "carrying out your decision" }, () =>
      inJob(loop, job, work),
    );
  const onStep = (stage: Parameters<typeof background>[2]["stage"], work: () => Promise<void>) =>
    background(loop, job, { stage, taskId, what: "carrying out your decision" }, () =>
      inStep(loop, job, taskId!, work),
    );
  const executorRun = async () => {
    const entries = await entriesOf(loop, job);
    return (
      (record.runId ? runIn(entries, record.runId) : undefined) ??
      latestRun(entries, taskId!, "executor")
    );
  };

  if (optionId === option("stop-step") && taskId) {
    return onJob("start", () => stopStep(loop, job, taskId));
  }
  if (optionId === option("reassign") && taskId) {
    return onJob("start", async () => {
      const run = await executorRun();
      await reassignStep(loop, job, taskId, run?.choice.agent);
    });
  }

  switch (record.about) {
    case "clarify":
      return onJob("plan", () => planJob(loop, job));
    case "level-vote":
      return onJob("plan", () => chooseLevelPlan(loop, job, optionId));
    case "retry":
      switch (record.stage) {
        case "plan":
          return onJob("plan", () => planJob(loop, job));
        case "divide":
          return onJob("divide", () => divideJob(loop, job));
        case "final-read":
          return onJob("final-read", () => finalRead(loop, job));
        case "final-send":
          // Only the deliveries that failed are made again.
          return onJob("final-send", () => sendFinal(loop, job));
        case "review":
          return onStep("review", async () => {
            const run = await executorRun();
            if (run) await reviewRound(loop, job, run.id);
          });
        case "turn":
          // The end of the executor's turn could not be handled: handle it again.
          return onStep("turn", async () => {
            const run = await executorRun();
            if (run?.state === "working") await checkTurn(loop, job, run.id, "");
            else if (run) await resumeRun(loop, job, run.id);
          });
        default:
          // A step that failed to start, or any other part of it: start it again.
          if (!taskId) return onJob("start", () => advanceJob(loop, job));
          return onJob("start", () => reassignStep(loop, job, taskId));
      }
    case "paused":
      // The person lets the run keep its changes: its turn is checked again, those paths allowed.
      return onStep("turn", async () => {
        if (!record.runId) return;
        const entries = await entriesOf(loop, job);
        const run = runIn(entries, record.runId);
        if (run?.state === "waiting") {
          await ledgerOf(loop, job).updateRun(run.id, { state: "working" });
          await checkTurn(loop, job, run.id, "");
        }
      });
    case "asked":
      // The person answered in the conversation: its turn is waited on again, nothing sent.
      return onStep("turn", async () => {
        if (record.runId) await rewatchRun(loop, job, record.runId);
      });
    case "turn":
      return onStep(record.role === "reviewer" ? "review" : "turn", async () => {
        if (record.runId) await resumeRun(loop, job, record.runId);
      });
    case "chair-step":
      return onStep("review", async () => {
        const run = await executorRun();
        if (!run) return;
        if (optionId === option("drop")) return passByRuling(loop, job, run.id);
        return sendFindings(
          loop,
          job,
          run.id,
          latestFindings(await entriesOf(loop, job), run.id),
          "The person sent the findings back for one more round.",
        );
      });
    case "dispute":
      return onStep("review", async () => {
        const run = await executorRun();
        if (run && record.findingId) {
          await personDispute(loop, job, run.id, record.findingId, optionId === option("keep"));
        }
      });
    case "watcher":
      return onStep("review", async () => {
        const run = await executorRun();
        if (run)
          await sendFindings(loop, job, run.id, latestFindings(await entriesOf(loop, job), run.id));
      });
    case "final-read":
      if (optionId === option("send")) return onJob("final-send", () => sendFinal(loop, job));
      if (optionId === option("retry")) return onJob("final-read", () => finalRead(loop, job));
      return onJob("final-read", () => finishJob(loop, job));
    case "stuck":
      return onJob("start", () => finishJob(loop, job));
    case "stop-failed":
      // Its options are "stop-step" and "reassign", handled above.
      return;
  }
}
