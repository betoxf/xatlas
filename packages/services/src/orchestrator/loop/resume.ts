import { replay } from "@zcode/orchestrator/tasks";
import type { OrchestratorProject } from "../orchestrator.js";
import {
  background,
  entriesOf,
  inJob,
  jobClosed,
  jobRef,
  ledgerOf,
  openDecision,
  type JobRef,
  type Loop,
} from "./context.js";
import { finalRead } from "./chair.js";
import { divideJob, materializeDivisions } from "./divide.js";
import { claimJob, interrupt } from "./guard.js";
import { decidedOf, isDivided, jobTasks, triageOf } from "./jobView.js";
import { planJob, startJob } from "./plan.js";
import { decisionsOf, openDecisions } from "./records.js";
import { advanceJob, latestRun, setRunState, stepsOfJob } from "./steps.js";
import { lostTurn } from "./turns.js";

/**
 * Carries on from the ledger after the app started again. A turn that was running can't be
 * seen by this process (the host only knows turns it sent), so such a run is never waited on:
 * it waits on the person, who lets it carry on or stops it. A run that was still starting is a
 * failed start, never started again by itself. Nothing is started twice: a step with a run is
 * never offered again.
 */
export function resumeProject(loop: Loop, project: OrchestratorProject, key: string): void {
  void (async () => {
    const entries = await loop.ledger.read(key);
    for (const job of jobTasks(replay(entries).tasks)) {
      if (jobClosed(entries, job.id)) continue;
      const ref = jobRef(project, job.id);
      background(loop, ref, { stage: "start", what: "carrying on after the app restarted" }, () =>
        inJob(loop, ref, () => resumeJob(loop, ref)),
      );
    }
  })().catch(() => undefined);
}

export async function resumeJob(loop: Loop, job: JobRef): Promise<void> {
  if (jobClosed(await entriesOf(loop, job), job.jobId)) return;
  // A job another live instance runs is only read here.
  if (!(await claimJob(loop, job)).ours) return;
  // A division saved just before the app stopped may lack some of its steps' tasks.
  if (isDivided(await entriesOf(loop, job), job.jobId)) await materializeDivisions(loop, job);
  const entries = await entriesOf(loop, job);
  const open = openDecisions(entries, job.jobId);
  if (!isDivided(entries, job.jobId)) {
    if (open.length > 0) return;
    const { latest, won } = decidedOf(entries, job.jobId);
    if (won) return divideJob(loop, job);
    // A level vote whose decision is open was handled above; anything else is planned again.
    if (latest) return planJob(loop, job);
    const questions = triageOf(entries, job.jobId)?.decision.questions ?? [];
    const clarified = decisionsOf(entries, job.jobId).some((d) => d.record.about === "clarify");
    if (questions.length > 0 && !clarified) return startJob(loop, job);
    return planJob(loop, job);
  }

  const held = new Set(open.flatMap((decision) => (decision.taskId ? [decision.taskId] : [])));
  const project = ledgerOf(loop, job);
  for (const step of stepsOfJob(entries, job.jobId)) {
    if (held.has(step.id) || step.state === "cancelled") continue;
    const executor = latestRun(entries, step.id, "executor");
    if (!executor) continue;
    const reviewer = latestRun(entries, step.id, "reviewer");
    if (reviewer?.state === "starting" && step.state === "in_review") {
      // As for an executor: stop a conversation it may have, then call its start failed.
      if (reviewer.conversationId && !(await interrupt(loop, job, reviewer.conversationId))) {
        await openDecision(loop, job, {
          about: "stop-failed",
          kind: "blocked",
          taskId: step.id,
          runId: reviewer.id,
          question: `The app stopped while step "${step.title}"'s reviewer was starting, and its conversation couldn't be stopped now. Stop it in the app, then stop the step or give it to a new executor.`,
          options: ["reassign", "stop-step"],
        });
        continue;
      }
      await setRunState(project, reviewer.id, "failed", "The app stopped while it was starting.");
      await openDecision(loop, job, {
        about: "retry",
        kind: "blocked",
        stage: "review",
        taskId: step.id,
        question: `The app stopped while step "${step.title}"'s reviewer was starting. Ask for the review again, or stop the step.`,
        options: ["retry", "stop-step"],
      });
      continue;
    }
    if (executor.state === "starting") {
      // Its conversation may be running already: stop it before calling the start failed.
      if (executor.conversationId && !(await interrupt(loop, job, executor.conversationId))) {
        await openDecision(loop, job, {
          about: "stop-failed",
          kind: "blocked",
          taskId: step.id,
          runId: executor.id,
          question: `The app stopped while step "${step.title}"'s executor was starting, and its conversation couldn't be stopped now. Stop it in the app, then stop the step or give it to a new executor.`,
          options: ["reassign", "stop-step"],
        });
        continue;
      }
      await setRunState(project, executor.id, "failed", "The app stopped while it was starting.");
      await openDecision(loop, job, {
        about: "retry",
        kind: "blocked",
        stage: "start",
        taskId: step.id,
        question: `The app stopped while step "${step.title}"'s executor was starting; its conversation may be open without a branch. Start the step again, or stop it.`,
        options: ["retry", "stop-step"],
      });
      continue;
    }
    if (executor.state === "working" || (executor.state === "waiting" && step.state !== "queued")) {
      const reviewing = step.state === "in_review" && reviewer?.conversationId;
      const run = reviewing ? reviewer : executor;
      if (run.conversationId) {
        await lostTurn(
          loop,
          job,
          {
            taskId: step.id,
            runId: run.id,
            role: reviewing ? "reviewer" : "executor",
            conversationId: run.conversationId,
          },
          "the app restarted",
        );
        continue;
      }
    }
    if ((executor.state === "failed" || executor.state === "stopped") && step.state !== "queued") {
      await openDecision(loop, job, {
        about: "retry",
        kind: "blocked",
        stage: "start",
        taskId: step.id,
        question: `Step "${step.title}" has no executor running. Start it again, or stop it.`,
        options: ["retry", "stop-step"],
      });
    }
  }
  const jobState = replay(await entriesOf(loop, job)).tasks.find((t) => t.id === job.jobId)?.state;
  if (jobState === "in_review" && !open.some((decision) => !decision.taskId)) {
    return finalRead(loop, job);
  }
  return advanceJob(loop, job);
}
