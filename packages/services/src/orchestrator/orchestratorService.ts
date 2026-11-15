import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { ledgerPath, openLedger, replay } from "@zcode/orchestrator/tasks";
import type { LedgerEntry } from "@zcode/orchestrator/types";
import type { OrchestratorHost } from "./host.js";
import type {
  IOrchestratorService,
  OrchestratorJobView,
  OrchestratorProject,
} from "./orchestrator.js";
import {
  background,
  entriesOf,
  inJob,
  jobClosed,
  jobRef,
  ledgerOf,
  projectKeyOf,
  taskIn,
  type JobOwner,
  type Loop,
} from "./loop/context.js";
import { decide } from "./loop/decide.js";
import { jobTasks, jobViews } from "./loop/jobView.js";
import { route } from "./loop/plan.js";
import { SerialQueues } from "./loop/queue.js";
import { claimJob, ownerOf, processAlive, registerInstance } from "./loop/guard.js";
import { resumeJob, resumeProject } from "./loop/resume.js";
import { createRolesStore } from "./loop/rolesStore.js";
import { stopJob } from "./loop/steps.js";

export interface OrchestratorServiceOptions {
  /** Where the ledgers and each project's roles are kept. */
  readonly dataDir: string;
  readonly host: OrchestratorHost;
  /** Tests pass their own. */
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** This instance's id as a job's owner; a new one by default. */
  readonly instanceId?: string;
  /** Whether a job's recorded owner still runs; by its process by default. */
  readonly ownerAlive?: (owner: JobOwner) => boolean;
}

/**
 * The orchestrator's loop. docs/xatlas/orchestrator-wiring.md has the rules it keeps. The
 * ledger is its only state: it moves on events (a message, a turn that ended, the person's
 * answer), and a new instance carries on from the ledger the first time a project is named.
 * The parts are in `loop/`: plan.ts (route, plan), divide.ts, steps.ts (start, reassign,
 * stop), turns.ts (turn ends, review, watcher), chair.ts, decide.ts, resume.ts, jobView.ts.
 */
export function createOrchestratorService(
  options: OrchestratorServiceOptions,
): IOrchestratorService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const loop: Loop = {
    host: options.host,
    ledger: openLedger({ dataDir: options.dataDir, now, newId }),
    roles: createRolesStore(options.dataDir),
    now,
    newId,
    queues: new SerialQueues(),
    controllers: new Map(),
    lastText: new Map(),
    interrupted: new Set(),
    reviewAsks: new Map(),
    instanceId: options.instanceId ?? randomUUID(),
    ownerAlive: options.ownerAlive ?? processAlive,
  };
  registerInstance(loop.instanceId);
  const resumed = new Set<string>();
  /** The last view per project, with the ledger file's size and time it was built from. */
  const views = new Map<
    string,
    { mark: string; seq: number; jobs: readonly OrchestratorJobView[] }
  >();

  /** Open jobs another instance runs, per project, as of the last read of its ledger. */
  const foreign = new Map<string, Map<string, JobOwner>>();

  function foreignJobs(entries: readonly LedgerEntry[]): Map<string, JobOwner> {
    const jobs = new Map<string, JobOwner>();
    for (const task of jobTasks(replay(entries).tasks)) {
      if (jobClosed(entries, task.id)) continue;
      const owner = ownerOf(entries, task.id);
      if (owner && owner.instance !== loop.instanceId) jobs.set(task.id, owner);
    }
    return jobs;
  }

  /**
   * On every poll: a job whose owner is gone (its window closed, its app quit) is taken over
   * and picked up from the ledger, without waiting for this instance to start again.
   */
  function takeOverGone(project: OrchestratorProject, key: string): void {
    const jobs = foreign.get(key);
    if (!jobs) return;
    for (const [jobId, owner] of jobs) {
      if (loop.ownerAlive(owner)) continue;
      jobs.delete(jobId);
      const job = jobRef(project, jobId);
      background(loop, job, { stage: "start", what: "taking over the job" }, () =>
        inJob(loop, job, () => resumeJob(loop, job)),
      );
    }
  }

  /** The first time this instance sees a project, its open jobs carry on from the ledger. */
  function touch(project: OrchestratorProject): string {
    const key = projectKeyOf(project);
    if (!resumed.has(key)) {
      resumed.add(key);
      resumeProject(loop, project, key);
    }
    return key;
  }

  async function existingJob(project: OrchestratorProject, jobId: string) {
    touch(project);
    const job = jobRef(project, jobId);
    const task = taskIn(await entriesOf(loop, job), jobId);
    if (!task || task.parentId !== undefined || task.route !== "orchestrated") {
      throw new Error("There is no such job in this project.");
    }
    return job;
  }

  return {
    async route(params) {
      touch(params);
      return route(loop, params);
    },

    async listJobs(params) {
      const key = touch(params);
      // The ledger only grows, so an unchanged size and time mean an unchanged ledger: the UI
      // polls every project every two seconds, and a poll then reads nothing. Stat first,
      // then read, so a view is never kept under a mark newer than what it was built from.
      const info = await stat(ledgerPath(options.dataDir, key)).catch(() => undefined);
      const mark = info ? `${info.size}:${info.mtimeMs}` : "none";
      let snapshot = views.get(key);
      if (snapshot?.mark !== mark) {
        const entries = await loop.ledger.read(key);
        const seq = entries.at(-1)?.seq ?? 0;
        snapshot =
          snapshot?.seq === seq ? { ...snapshot, mark } : { mark, seq, jobs: jobViews(entries) };
        views.set(key, snapshot);
        foreign.set(key, foreignJobs(entries));
      }
      takeOverGone(params, key);
      const { seq, jobs } = snapshot;
      return params.sinceSeq === seq ? { seq, jobs: [] } : { seq, jobs };
    },

    async decide(params) {
      const job = await existingJob(params, params.jobId);
      // Only the job's owner acts on it; a gone owner's job is taken over and picked up first.
      const claim = await claimJob(loop, job);
      if (!claim.ours) {
        throw new Error("Another window of the app runs this job; answer it there.");
      }
      if (claim.taken) await inJob(loop, job, () => resumeJob(loop, job));
      return decide(loop, job, params.decisionId, params.optionId);
    },

    async postNote(params) {
      const job = await existingJob(params, params.jobId);
      const text = params.text.trim();
      if (!text) throw new Error("A note needs some text.");
      if (params.to !== undefined) {
        const step = taskIn(await entriesOf(loop, job), params.to);
        if (step?.parentId !== job.jobId) throw new Error("That step is not part of this job.");
      }
      await ledgerOf(loop, job).record({
        kind: "note",
        taskId: params.to ?? job.jobId,
        data: { from: "person", text, ...(params.to === undefined ? {} : { to: params.to }) },
      });
    },

    async stopJob(params) {
      const job = await existingJob(params, params.jobId);
      await stopJob(loop, job);
    },

    async getRoles(params) {
      return loop.roles.get(projectKeyOf(params));
    },

    async setRoles(params) {
      await loop.roles.set(projectKeyOf(params), params.roles);
    },
  };
}
