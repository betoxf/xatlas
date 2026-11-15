import type { LedgerEntry, ModelChoice, RunRole, RunState } from "@zcode/orchestrator/types";
import {
  entriesOf,
  jobClosed,
  runIn,
  signalOf,
  type JobOwner,
  type JobRef,
  type Loop,
} from "./context.js";

/**
 * What keeps two instances of the service (two app windows over one ledger) and a stop from
 * racing the loop: every job has one owner recorded in the ledger, every start is a claim
 * checked inside the ledger's lock, and every message to a conversation is checked against a
 * stop at the moment it is sent.
 */

const OWNER_FROM = "xatlas:owner";
const FINAL_RUN: ReadonlySet<RunState> = new Set(["done", "failed", "stopped"]);

/** Instances alive in this process: an owner in this process is alive while it is listed. */
const LIVE_HERE = new Set<string>();

export function registerInstance(instance: string): void {
  LIVE_HERE.add(instance);
}

/** The default liveness: this process's instances by the list above, others by their pid. */
export function processAlive(owner: JobOwner): boolean {
  if (owner.pid === process.pid) return LIVE_HERE.has(owner.instance);
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** A start or an owner claim the ledger refused, and why. */
export class ClaimRefused extends Error {
  constructor(
    /** "owner": another instance runs the job; "closed": the job or step ended; "busy": the step has such a run. */
    readonly why: "owner" | "closed" | "busy",
    message: string,
  ) {
    super(message);
  }
}

/** The job's owner as last recorded, with that entry's id. */
export function ownerOf(
  entries: readonly LedgerEntry[],
  jobId: string,
): (JobOwner & { readonly entryId: string }) | undefined {
  const entry = entries.findLast(
    (candidate) =>
      candidate.kind === "note" && candidate.taskId === jobId && candidate.data.from === OWNER_FROM,
  );
  if (entry?.kind !== "note") return undefined;
  try {
    const value = JSON.parse(entry.data.text) as Partial<JobOwner>;
    if (typeof value.instance !== "string" || typeof value.pid !== "number") return undefined;
    return { instance: value.instance, pid: value.pid, entryId: entry.id };
  } catch {
    return undefined;
  }
}

export function isOwner(loop: Loop, entries: readonly LedgerEntry[], jobId: string): boolean {
  return ownerOf(entries, jobId)?.instance === loop.instanceId;
}

/**
 * Makes this instance the job's owner, inside the ledger's lock: when nobody owns it, when it
 * is ours already, or when its owner's process is gone. Returns whether it is ours now;
 * otherwise this instance only reads the job.
 */
export async function claimJob(
  loop: Loop,
  job: JobRef,
): Promise<{ ours: boolean; taken: boolean }> {
  let taken = false;
  try {
    await loop.ledger.append(job.key, ({ entries }) => {
      const owner = ownerOf(entries, job.jobId);
      // Already ours: the same entry again, which the ledger leaves as it is.
      if (owner?.instance === loop.instanceId) {
        return {
          id: owner.entryId,
          kind: "note",
          taskId: job.jobId,
          data: { from: OWNER_FROM, text: "" },
        };
      }
      if (owner && loop.ownerAlive(owner))
        throw new ClaimRefused("owner", "another window runs this job");
      taken = owner !== undefined;
      return {
        id: `owner:${job.jobId}:${loop.instanceId}:${entries.length}`,
        kind: "note",
        taskId: job.jobId,
        data: {
          from: OWNER_FROM,
          text: JSON.stringify({ instance: loop.instanceId, pid: process.pid }),
        },
      };
    });
    return { ours: true, taken };
  } catch (error) {
    if (error instanceof ClaimRefused) return { ours: false, taken: false };
    throw error;
  }
}

/**
 * Starts a run as an exclusive claim, inside the ledger's lock: refused unless this instance
 * owns the job, the step is open, and the step has no run of that role still going. Two
 * instances that both thought a step was ready therefore start it once.
 */
export async function claimRun(
  loop: Loop,
  job: JobRef,
  input: {
    readonly id: string;
    readonly taskId: string;
    readonly role: RunRole;
    readonly choice: ModelChoice;
  },
): Promise<void> {
  await loop.ledger.append(job.key, ({ entries, state }) => {
    if (!isOwner(loop, entries, job.jobId)) {
      throw new ClaimRefused("owner", "another window runs this job");
    }
    if (jobClosed(entries, job.jobId)) throw new ClaimRefused("closed", "the job is closed");
    const task = state.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task || task.state === "cancelled" || task.state === "queued") {
      throw new ClaimRefused("closed", "the step is not open");
    }
    const going = state.runs.some(
      (run) => run.taskId === input.taskId && run.role === input.role && !FINAL_RUN.has(run.state),
    );
    if (going) throw new ClaimRefused("busy", `the step already has a ${input.role}`);
    return {
      id: `run:${input.id}`,
      kind: "run.started",
      taskId: input.taskId,
      runId: input.id,
      data: { role: input.role, choice: input.choice },
    };
  });
}

/** Whether the loop may still talk to this run: ours, not stopped, not ended. */
async function mayTalk(loop: Loop, job: JobRef, runId: string): Promise<boolean> {
  if (signalOf(loop, job).aborted) return false;
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId) || !isOwner(loop, entries, job.jobId)) return false;
  const run = runIn(entries, runId);
  return run !== undefined && !FINAL_RUN.has(run.state);
}

/** One message at a time per job, so a stop waits for a send in flight and then wins. */
export function inSend<T>(loop: Loop, job: JobRef, work: () => Promise<T>): Promise<T> {
  return loop.queues.run(`send\0${job.key}\0${job.jobId}`, work);
}

/**
 * Sends a run its next message unless the job or the run was stopped, checked at the moment
 * of sending and serialised with `stopJob`. Returns whether it was sent.
 */
export function deliver(
  loop: Loop,
  job: JobRef,
  runId: string,
  conversationId: string,
  text: string,
): Promise<boolean> {
  return inSend(loop, job, async () => {
    if (!(await mayTalk(loop, job, runId))) return false;
    await loop.host.send({ project: job.project, conversationId, text });
    return true;
  });
}

/** Interrupts a conversation; false when the host refused, so the run stays stoppable. */
export async function interrupt(loop: Loop, job: JobRef, conversationId: string): Promise<boolean> {
  loop.interrupted.add(conversationId);
  try {
    await loop.host.interrupt({ project: job.project, conversationId });
    return true;
  } catch {
    loop.interrupted.delete(conversationId);
    return false;
  }
}
