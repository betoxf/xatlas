import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Rocket, TrainFront, X } from "lucide-react";
import type { ReleaseQueueItem } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildReleaseFixPrompt, type ReleaseTrainFinding } from "./releaseFixPrompt.js";
import { ReleaseQueueRow } from "./ReleaseQueueRow.js";
import { useReleaseQueue } from "./useReleaseQueue.js";

export interface ReleaseQueueProject {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly label: string;
}

const UNAVAILABLE_MESSAGE_ID = {
  "gh-missing": "releases.unavailable.ghMissing",
  "gh-signed-out": "releases.unavailable.ghSignedOut",
  "no-github-repository": "releases.unavailable.noRepository",
  failed: "releases.unavailable.failed",
} as const;

function Lane({
  title,
  count,
  collapsible = false,
  children,
}: {
  title: string;
  count: number;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  if (count === 0) {
    return null;
  }
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="flex flex-col gap-0.5">
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-left text-ui-sm font-medium text-foreground-subtle"
      >
        {collapsible ? <Chevron className="size-3.5" /> : null}
        {title}
        <span className="text-foreground-subtlest tabular-nums">{count}</span>
      </button>
      {open ? children : null}
    </section>
  );
}

/**
 * A project's open pull requests as a release queue: what can ship together
 * (checked by actually merging them in a scratch copy), what needs a fix
 * (with a one-click brief for an agent), what's waiting, and drafts.
 */
export function ReleaseQueuePanel({
  projects,
  initialWorkspacePath,
  onClose,
  onOpenUrl,
  onFixWithAgent,
}: {
  projects: readonly ReleaseQueueProject[];
  initialWorkspacePath: string | null;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  onFixWithAgent: (prompt: string, project: ReleaseQueueProject) => void;
}) {
  const { intl } = useZCodeIntl();
  const [workspacePath, setWorkspacePath] = useState(
    initialWorkspacePath ?? projects[0]?.workspacePath ?? null,
  );
  const project = projects.find((candidate) => candidate.workspacePath === workspacePath) ?? null;
  const { queue, train, refreshing, refresh, checkTrain } = useReleaseQueue(workspacePath);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const lanes = useMemo(() => {
    if (queue.status !== "ok") {
      return null;
    }
    const byNumber = new Map(queue.analysis.items.map((item) => [item.pullRequest.number, item]));
    const trainSteps = train.status === "ok" ? train.train.steps : null;
    const findings = new Map<number, ReleaseTrainFinding>();
    const shipTogether: ReleaseQueueItem[] = [];
    if (trainSteps) {
      const merged: number[] = [];
      for (const step of trainSteps) {
        if (step.status === "merged") {
          shipTogether.push(byNumber.get(step.pullRequest)!);
          merged.push(step.pullRequest);
        } else if (step.status === "conflict") {
          findings.set(step.pullRequest, { conflictFiles: step.conflictFiles, mergedBefore: [...merged] });
        }
      }
    }
    const ready = queue.analysis.plan.order
      .map((number) => byNumber.get(number)!)
      .filter((item) => !findings.has(item.pullRequest.number));
    const fix = [
      ...queue.analysis.items.filter((item) => item.lane === "fix"),
      ...[...findings.keys()].map((number) => byNumber.get(number)!),
    ];
    return {
      shipTogether: trainSteps ? shipTogether : ready,
      fix,
      waiting: queue.analysis.items.filter((item) => item.lane === "waiting"),
      drafts: queue.analysis.items.filter((item) => item.lane === "draft"),
      findings,
    };
  }, [queue, train]);

  const fixPrompt = (item: ReleaseQueueItem) =>
    queue.status === "ok"
      ? buildReleaseFixPrompt({
          snapshot: queue.snapshot,
          item,
          renumbers: queue.analysis.plan.renumbers.filter(
            (renumber) => renumber.pullRequest === item.pullRequest.number,
          ),
          ...(lanes?.findings.get(item.pullRequest.number)
            ? { train: lanes.findings.get(item.pullRequest.number) }
            : {}),
        })
      : "";

  const plan = queue.status === "ok" ? queue.analysis.plan : null;
  const trainMerged = train.status === "ok" ? train.train.steps.filter((s) => s.status === "merged").length : 0;
  const trainConflicts = train.status === "ok" ? train.train.steps.length - trainMerged : 0;

  return (
    <div className="fixed inset-0 z-40 flex justify-center px-6 pt-16 pb-6">
      <div aria-hidden className="absolute inset-0 bg-background/45" onClick={onClose} />
      <div
        role="dialog"
        aria-label={intl.formatMessage({ id: "releases.title" })}
        className="relative flex w-full max-w-4xl animate-in flex-col overflow-hidden rounded-2xl border border-glass-border bg-card shadow-[inset_0_1px_0_var(--color-glass-highlight),0_32px_80px_-20px_var(--color-glass-edge),0_10px_28px_-10px_var(--color-glass-edge)] fade-in-0 zoom-in-[0.98] duration-200"
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <Rocket className="size-4 text-foreground-subtle" />
          <h2 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "releases.title" })}
          </h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="gap-1 text-foreground-subtle">
                {project?.label ?? "—"}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              {projects.map((candidate) => (
                <DropdownMenuItem
                  key={candidate.workspacePath}
                  onSelect={() => setWorkspacePath(candidate.workspacePath)}
                >
                  {candidate.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {queue.status === "ok" ? (
            <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
              {queue.snapshot.repository} → {queue.snapshot.baseBranch}
            </span>
          ) : null}
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            aria-label={intl.formatMessage({ id: "releases.refresh" })}
            onClick={refresh}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            aria-label={intl.formatMessage({ id: "releases.close" })}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {queue.status === "loading" ? (
            <p className="flex items-center justify-center gap-2 py-16 text-ui-base text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" />
              {intl.formatMessage({ id: "releases.loading" })}
            </p>
          ) : queue.status === "unsupported" ? (
            <p className="py-16 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "releases.unsupported" })}
            </p>
          ) : queue.status === "unavailable" ? (
            <p className="py-16 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: UNAVAILABLE_MESSAGE_ID[queue.reason] })}
            </p>
          ) : queue.analysis.items.length === 0 ? (
            <p className="py-16 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "releases.empty" })}
            </p>
          ) : lanes && plan ? (
            <>
              <div className="mx-2 mt-3 flex items-center gap-4 rounded-xl bg-surface px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-ui-base font-medium text-foreground">
                    {train.status === "ok"
                      ? intl.formatMessage(
                          { id: "releases.plan.trainResult" },
                          { merged: String(trainMerged), conflicts: String(trainConflicts) },
                        )
                      : intl.formatMessage(
                          { id: "releases.plan.ready" },
                          { count: String(plan.order.length) },
                        )}
                  </p>
                  <p className="text-ui-sm text-foreground-subtle">
                    {train.status === "running"
                      ? intl.formatMessage(
                          { id: "releases.plan.checking" },
                          { count: String(plan.order.length) },
                        )
                      : train.status === "ok"
                        ? intl.formatMessage(
                            { id: "releases.plan.trainChecked" },
                            {
                              base: train.train.baseBranch,
                              commit: train.train.baseCommit.slice(0, 7),
                            },
                          )
                        : train.status === "unavailable"
                          ? intl.formatMessage(
                              { id: "releases.plan.trainFailed" },
                              { message: train.message.slice(0, 160) },
                            )
                          : intl.formatMessage(
                              { id: "releases.plan.hint" },
                              {
                                renumbers: String(plan.renumbers.length),
                                overlaps: String(plan.overlaps.length),
                              },
                            )}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  disabled={train.status === "running" || plan.order.length === 0}
                  onClick={() => void checkTrain()}
                >
                  {train.status === "running" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <TrainFront className="size-3.5" />
                  )}
                  {intl.formatMessage({ id: "releases.plan.checkTrain" })}
                </Button>
              </div>

              <Lane
                title={intl.formatMessage({
                  id: train.status === "ok" ? "releases.lane.shipTogether" : "releases.lane.ready",
                })}
                count={lanes.shipTogether.length}
              >
                {lanes.shipTogether.map((item, index) => (
                  <ReleaseQueueRow
                    key={item.pullRequest.number}
                    item={item}
                    step={index + 1}
                    onOpen={onOpenUrl}
                  />
                ))}
              </Lane>
              <Lane title={intl.formatMessage({ id: "releases.lane.fix" })} count={lanes.fix.length}>
                {lanes.fix.map((item) => (
                  <ReleaseQueueRow
                    key={item.pullRequest.number}
                    item={item}
                    trainConflictFiles={lanes.findings.get(item.pullRequest.number)?.conflictFiles}
                    onOpen={onOpenUrl}
                    onFix={project ? () => onFixWithAgent(fixPrompt(item), project) : undefined}
                  />
                ))}
              </Lane>
              <Lane title={intl.formatMessage({ id: "releases.lane.waiting" })} count={lanes.waiting.length}>
                {lanes.waiting.map((item) => (
                  <ReleaseQueueRow key={item.pullRequest.number} item={item} onOpen={onOpenUrl} />
                ))}
              </Lane>
              <Lane
                title={intl.formatMessage({ id: "releases.lane.draft" })}
                count={lanes.drafts.length}
                collapsible
              >
                {lanes.drafts.map((item) => (
                  <ReleaseQueueRow key={item.pullRequest.number} item={item} onOpen={onOpenUrl} />
                ))}
              </Lane>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
