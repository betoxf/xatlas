import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Database,
  ExternalLink,
  GitMerge,
  Wand2,
  XCircle,
} from "lucide-react";
import { formatReleaseMigrationNumber, type ReleaseQueueItem } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

type ChipTone = "neutral" | "good" | "warn" | "bad";

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: "bg-surface text-foreground-subtle",
  good: "bg-success/10 text-success",
  warn: "bg-warning/12 text-warning",
  bad: "bg-destructive/10 text-destructive",
};

function Chip({
  tone,
  icon,
  title,
  children,
}: {
  tone: ChipTone;
  icon?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  const chip = (
    <span
      className={cn(
        "inline-flex h-5 max-w-56 shrink-0 items-center gap-1 rounded-full px-2 text-ui-xs font-medium",
        CHIP_TONE[tone],
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
  return title ? (
    <ControlHintTooltip title={title} side="top">
      {chip}
    </ControlHintTooltip>
  ) : (
    chip
  );
}

/**
 * One pull request in the release queue: number, title, branch, and chips for
 * what matters to shipping (migrations, checks, conflicts, overlaps).
 */
export function ReleaseQueueRow({
  item,
  step,
  trainConflictFiles,
  onOpen,
  onFix,
}: {
  item: ReleaseQueueItem;
  /** Position in the ship order, when it ships with the train. */
  step?: number;
  trainConflictFiles?: readonly string[];
  onOpen: (url: string) => void;
  onFix?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const pr = item.pullRequest;
  const blocking = item.issues.filter((issue) => issue.blocking);
  const overlap = item.issues.filter((issue) => issue.kind === "file-overlap");
  const migrationIssue = item.issues.find(
    (issue) => issue.kind === "migration-taken" || issue.kind === "migration-duplicate",
  );

  return (
    <div className="group flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-hover">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-ui-xs font-semibold tabular-nums",
          step !== undefined ? "bg-foreground text-background" : "bg-surface text-foreground-subtle",
        )}
      >
        {step !== undefined ? step : <GitMerge className="size-3.5" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-ui-sm text-foreground-subtle tabular-nums">
            #{pr.number}
          </span>
          <span className="min-w-0 truncate text-ui-base text-foreground" title={pr.title}>
            {pr.title}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="max-w-64 truncate font-mono text-ui-xs text-foreground-subtlest">
            {pr.branch}
          </span>
          {item.migrations.map((migration) => (
            <Chip
              key={migration.file}
              tone={migrationIssue ? "warn" : "neutral"}
              icon={<Database className="size-3" />}
              title={migrationIssue?.detail ?? migration.file}
            >
              {formatReleaseMigrationNumber(migration)}
            </Chip>
          ))}
          {pr.checks.state === "success" ? (
            <Chip tone="good" icon={<CheckCircle2 className="size-3" />}>
              {intl.formatMessage({ id: "releases.row.checksPassed" })}
            </Chip>
          ) : pr.checks.state === "failure" ? (
            <Chip tone="bad" icon={<XCircle className="size-3" />} title={pr.checks.failing.join(", ")}>
              {intl.formatMessage({ id: "releases.row.checksFailing" })}
            </Chip>
          ) : pr.checks.state === "pending" ? (
            <Chip tone="warn" icon={<CircleDashed className="size-3" />}>
              {intl.formatMessage({ id: "releases.row.checksRunning" })}
            </Chip>
          ) : null}
          {blocking
            .filter((issue) => issue.kind !== "checks-failing" && issue.kind !== "migration-taken")
            .map((issue) => (
              <Chip key={issue.kind} tone="bad" icon={<AlertTriangle className="size-3" />}>
                {issue.detail}
              </Chip>
            ))}
          {trainConflictFiles && trainConflictFiles.length > 0 ? (
            <Chip
              tone="bad"
              icon={<AlertTriangle className="size-3" />}
              title={trainConflictFiles.join("\n")}
            >
              {intl.formatMessage(
                { id: "releases.row.trainConflict" },
                { files: trainConflictFiles.map((file) => file.split("/").pop()).join(", ") },
              )}
            </Chip>
          ) : null}
          {overlap.length > 0 && !trainConflictFiles?.length ? (
            <Chip
              tone="neutral"
              title={overlap.map((issue) => issue.detail).join("\n")}
            >
              {intl.formatMessage(
                { id: "releases.row.sharesFiles" },
                { count: String(overlap.length) },
              )}
            </Chip>
          ) : null}
        </div>
      </div>
      <span className="shrink-0 text-ui-xs text-foreground-subtlest tabular-nums">
        {formatTaskRelativeTime(Date.parse(pr.updatedAt), intl)}
      </span>
      {onFix ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onFix}>
          <Wand2 className="size-3.5" />
          {intl.formatMessage({ id: "releases.row.fixWithAgent" })}
        </Button>
      ) : null}
      <ControlHintTooltip title={intl.formatMessage({ id: "releases.row.openOnGitHub" })} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={intl.formatMessage({ id: "releases.row.openOnGitHub" })}
          onClick={() => onOpen(pr.url)}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </ControlHintTooltip>
    </div>
  );
}
