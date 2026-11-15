import { useMemo, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { OrchestratorJobDialog } from "@/app-shell/orchestrator/OrchestratorJobDialog.js";
import { buildJobStackEntries } from "@/app-shell/orchestrator/orchestratorStackEntries.js";
import {
  orchestratorStackProjects,
  useOrchestratorJobs,
} from "@/app-shell/orchestrator/useOrchestratorJobs.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { TaskStack } from "./TaskStack.js";
import { buildTaskStackEntries } from "./taskStackEntries.js";
import type { TaskStackEntry } from "./taskStackEntries.js";

/** How many recent conversations each project's stack loads. */
const TASK_STACK_PER_PROJECT_LIMIT = 24;

function projectKey(hostId: string, projectId: string): string {
  return `${hostId}\0${projectId}`;
}

/**
 * Wires the Task Stack to the same project tree the sidebar shows (the host's
 * project and task rows joined with live session activity), one stack per
 * project.
 */
export function TaskStackMain({
  openTaskId,
  onOpenTask,
}: {
  /** Conversation open over the Stack, if any. */
  openTaskId: string | null;
  onOpenTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
}) {
  const directory = useOptionalProjectDirectory();
  const tree = directory?.tree;
  // Orchestrator jobs sit in their project's stack beside its conversations.
  const jobProjects = useMemo(
    () => orchestratorStackProjects(tree?.projects ?? []),
    [tree?.projects],
  );
  const orchestrator = useOrchestratorJobs(jobProjects);
  const [openJob, setOpenJob] = useState<{ projectKey: string; jobId: string } | null>(null);
  const conversationEntries = useMemo(() => {
    if (!tree) return [];
    const projectNames = new Map(
      tree.projects
        .filter((project) => !project.deleted)
        .map((project) => [projectKey(project.hostId, project.id), project.name]),
    );
    const perProject = new Map<string, ZCodeTaskMeta[]>();
    for (const task of tree.tasks) {
      if (task.archived || task.projectId === null) continue;
      const key = projectKey(task.hostId, task.projectId);
      if (!projectNames.has(key)) continue;
      const list = perProject.get(key) ?? [];
      list.push(task);
      perProject.set(key, list);
    }
    const nameByTask = new Map<ZCodeTaskMeta, string | undefined>();
    const tasks = [...perProject].flatMap(([key, list]) =>
      list
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, TASK_STACK_PER_PROJECT_LIMIT)
        .map((task) => {
          nameByTask.set(task, projectNames.get(key));
          return task;
        }),
    );
    return buildTaskStackEntries(tasks, (task) => nameByTask.get(task));
  }, [tree]);
  const entries = useMemo(
    () => [...conversationEntries, ...buildJobStackEntries(orchestrator.jobs)],
    [conversationEntries, orchestrator.jobs],
  );
  const shownJob =
    orchestrator.jobs.find(
      (job) => job.project.key === openJob?.projectKey && job.view.jobId === openJob.jobId,
    ) ?? null;

  const handleOpen = (entry: TaskStackEntry) =>
    entry.job
      ? setOpenJob({ projectKey: entry.job.project.key, jobId: entry.job.view.jobId })
      : onOpenTask(entry.workspacePath, entry.taskId, entry.workspaceIdentity);

  return (
    <>
      <TaskStack entries={entries} openTaskId={openTaskId} onOpen={handleOpen} />
      <OrchestratorJobDialog
        job={shownJob}
        onClose={() => setOpenJob(null)}
        actions={orchestrator}
        onOpenConversation={(job, conversationId) => {
          setOpenJob(null);
          // A step's conversation is a task of the project; the tree knows where it lives.
          const task = tree?.tasks.find((candidate) => candidate.taskId === conversationId);
          onOpenTask(
            task?.workspacePath ?? job.project.workspacePath,
            conversationId,
            task ? task.workspaceIdentity : job.project.workspaceIdentity,
          );
        }}
      />
    </>
  );
}
