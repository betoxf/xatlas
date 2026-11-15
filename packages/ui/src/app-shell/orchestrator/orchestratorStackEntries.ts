import type { OrchestratorJobView } from "@zcode/services";
import type { TaskStackEntry, TaskStackStatus } from "@/app-shell/taskStack/taskStackEntries.js";
import type { OrchestratorStackJob } from "./useOrchestratorJobs.js";

/** Job cards never share a key or task id with a conversation, so opening one can't open the other. */
const JOB_KEY_PREFIX = "orchestrator-job:";

/** Waiting on the person and failure lead the stack, as they do for conversations. */
export function jobStackStatus(job: OrchestratorJobView): TaskStackStatus {
  if (job.decisions.length > 0 || job.phase === "waiting") return "waiting";
  switch (job.phase) {
    case "failed":
      return "error";
    case "done":
    case "stopped":
      return "idle";
    default:
      return "running";
  }
}

export function buildJobStackEntries(jobs: readonly OrchestratorStackJob[]): TaskStackEntry[] {
  return jobs.map((job) => {
    const id = `${JOB_KEY_PREFIX}${job.view.jobId}`;
    const updatedAt = Date.parse(job.view.updatedAt);
    return {
      key: `${job.project.key}::${id}`,
      groupKey: job.project.key,
      taskId: id,
      workspacePath: job.project.workspacePath,
      ...(job.project.workspaceIdentity
        ? { workspaceIdentity: job.project.workspaceIdentity }
        : {}),
      workspaceName: job.project.name,
      title: job.view.title,
      updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
      status: jobStackStatus(job.view),
      job,
    };
  });
}
