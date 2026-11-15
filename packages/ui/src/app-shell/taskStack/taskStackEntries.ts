import type { ZCodeTaskMeta } from "@zcode/shared";
import type { OrchestratorStackJob } from "@/app-shell/orchestrator/useOrchestratorJobs.js";
import { getPathLeaf } from "@/lib/path.js";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

export type TaskStackStatus = "running" | "waiting" | "error" | "unread" | "idle";

/** View model for one card in the Task Stack; decoupled from services. */
export interface TaskStackEntry {
  key: string;
  /** Project the conversation belongs to (identity for remote, else path). */
  groupKey: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceName: string;
  title: string;
  updatedAt: number;
  status: TaskStackStatus;
  added?: number;
  removed?: number;
  /** Set when the card is an orchestrator job rather than a conversation. */
  job?: OrchestratorStackJob;
}

function resolveTaskStackStatus(task: ZCodeTaskMeta): TaskStackStatus {
  // Waiting on the user outranks the spinner: it is the state that needs action.
  if (getTaskListAttention(task)) {
    return "waiting";
  }
  const indicator = deriveTaskLeadingIndicator(task, getTaskListRowActivity(task));
  switch (indicator) {
    case "loading":
      return "running";
    case "error":
      return "error";
    case "unread":
      return "unread";
    default:
      return "idle";
  }
}

/** Newest activity first, so the front card is the conversation that moved last. */
export function buildTaskStackEntries(
  tasks: readonly ZCodeTaskMeta[],
  labelForWorkspace: (task: ZCodeTaskMeta) => string | undefined = () => undefined,
): TaskStackEntry[] {
  return [...tasks]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((task) => ({
      key: `${task.workspaceIdentity?.trim() || task.workspacePath}::${task.taskId}`,
      groupKey: task.workspaceIdentity?.trim() || task.workspacePath,
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      workspaceName: labelForWorkspace(task) || getPathLeaf(task.workspacePath),
      title: task.title,
      updatedAt: task.updatedAt,
      status: resolveTaskStackStatus(task),
      ...(task.changeSummary
        ? { added: task.changeSummary.added, removed: task.changeSummary.removed }
        : {}),
    }));
}

/** Errors and conversations waiting on the user need action; they lead. */
function isTaskStackActionable(status: TaskStackStatus): boolean {
  return status === "waiting" || status === "error";
}

export interface TaskStackGroup {
  key: string;
  name: string;
  /** Actionable conversations first, then by most recent activity. */
  entries: TaskStackEntry[];
  latestAt: number;
  counts: Record<TaskStackStatus, number>;
  actionableCount: number;
  /** The entries that are conversations, not jobs. */
  conversationCount: number;
}

function prioritise(entries: readonly TaskStackEntry[]): TaskStackEntry[] {
  return [...entries].sort((left, right) => {
    const rank =
      Number(isTaskStackActionable(right.status)) - Number(isTaskStackActionable(left.status));
    return rank || right.updatedAt - left.updatedAt;
  });
}

/**
 * One stack per project. Projects with actionable conversations come first,
 * then by their latest activity.
 */
export function buildTaskStackGroups(entries: readonly TaskStackEntry[]): TaskStackGroup[] {
  const byKey = new Map<string, TaskStackEntry[]>();
  for (const entry of entries) {
    const bucket = byKey.get(entry.groupKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      byKey.set(entry.groupKey, [entry]);
    }
  }
  const groups = Array.from(byKey, ([key, bucket]): TaskStackGroup => {
    const counts: Record<TaskStackStatus, number> = {
      running: 0,
      waiting: 0,
      error: 0,
      unread: 0,
      idle: 0,
    };
    for (const entry of bucket) {
      counts[entry.status] += 1;
    }
    return {
      key,
      name: bucket[0]?.workspaceName ?? key,
      entries: prioritise(bucket),
      latestAt: Math.max(...bucket.map((entry) => entry.updatedAt)),
      counts,
      actionableCount: counts.waiting + counts.error,
      conversationCount: bucket.filter((entry) => !entry.job).length,
    };
  });
  return groups.sort(
    (left, right) =>
      Number(right.actionableCount > 0) - Number(left.actionableCount > 0) ||
      right.latestAt - left.latestAt,
  );
}

/** "1 conversation" / "N conversations" (the i18n layer has no plural rules). */
export function formatConversationCount(
  intl: { formatMessage: (desc: { id: string }, values?: Record<string, string>) => string },
  count: number,
): string {
  return count === 1
    ? intl.formatMessage({ id: "taskStack.conversationCountOne" })
    : intl.formatMessage({ id: "taskStack.conversationCount" }, { count: String(count) });
}
