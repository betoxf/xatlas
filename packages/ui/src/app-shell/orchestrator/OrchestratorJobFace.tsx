import { Workflow } from "lucide-react";
import type { OrchestratorJobView } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** A step in one of these states has passed review. */
const PAST_REVIEW = new Set<OrchestratorJobView["steps"][number]["state"]>([
  "queued",
  "merged",
  "deployed",
  "checked",
]);

/** The job marker in a Stack card's header row. */
export function OrchestratorJobMark() {
  const { intl } = useZCodeIntl();
  return (
    <span className="flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle">
      <Workflow className="size-3.5" />
      {intl.formatMessage({ id: "orchestrator.job.label" })}
    </span>
  );
}

/** The front card's body for a job: where it stands, and how many steps and decisions it has. */
export function OrchestratorJobFace({ job }: { job: OrchestratorJobView }) {
  const { intl } = useZCodeIntl();
  const reviewed = job.steps.filter((step) => PAST_REVIEW.has(step.state)).length;
  return (
    <>
      {/* Takes the spacer's place, so a job card fits where a conversation card does. */}
      <span className="relative line-clamp-2 min-h-0 flex-1 text-ui-sm text-foreground-subtle">
        {job.status}
      </span>
      <span className="relative flex items-center gap-3 text-ui-sm">
        {job.steps.length > 0 ? (
          <span className="text-foreground-subtle tabular-nums">
            {intl.formatMessage(
              { id: "orchestrator.job.stepsReviewed" },
              { reviewed: String(reviewed), count: String(job.steps.length) },
            )}
          </span>
        ) : null}
        <span className="flex-1" />
        {job.decisions.length > 0 ? (
          <span className="font-medium text-warning tabular-nums">
            {intl.formatMessage(
              { id: "orchestrator.job.needsYou" },
              { count: String(job.decisions.length) },
            )}
          </span>
        ) : null}
      </span>
    </>
  );
}
