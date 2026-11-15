import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Bot, ChevronRight, DiffIcon, FolderOpen, GitBranch, Globe, Link2, Plug } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { ConversationSource } from "./conversationSummarySources.js";
import { useConversationSummaryStore } from "./conversationSummaryStore.js";

/** Marks the header button that toggles the summary, so clicking it isn't "outside". */
export const CONVERSATION_SUMMARY_TOGGLE_ATTR = "data-conversation-summary-toggle";
const MAX_SOURCES = 5;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border px-1.5 pt-2.5 pb-1">
      <p className="px-2 text-ui-sm text-foreground-subtlest">{title}</p>
      {children}
    </div>
  );
}

function Row({
  icon,
  children,
  trailing,
  onClick,
  muted = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  muted?: boolean;
}) {
  const className = cn(
    "flex min-h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left text-ui-sm",
    muted ? "text-foreground-subtlest" : "text-foreground",
    onClick && "transition-colors hover:bg-hover",
  );
  const content = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </>
  );
  return onClick ? (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

/**
 * What this conversation has been doing, at a glance: project and branch,
 * changes, subagents and the sources it drew on. Floats under the header's
 * summary toggle; Escape or a click outside closes it.
 */
export function ConversationSummaryPopover({
  projectName,
  branchName,
  changes,
  runningSubagents,
  endedSubagents,
  sources,
  onOpenChanges,
  onOpenSubagents,
  onOpenLink,
}: {
  projectName: string;
  branchName: string | null;
  changes: { added: number; removed: number } | null;
  runningSubagents: number;
  endedSubagents: number;
  sources: readonly ConversationSource[];
  onOpenChanges?: () => void;
  onOpenSubagents?: () => void;
  onOpenLink?: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const open = useConversationSummaryStore((state) => state.open);
  const setOpen = useConversationSummaryStore((state) => state.setOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest(`[${CONVERSATION_SUMMARY_TOGGLE_ATTR}]`)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Closes the summary only, not the conversation behind it.
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, setOpen]);

  if (!open) {
    return null;
  }

  const hasChanges = Boolean(changes && (changes.added > 0 || changes.removed > 0));
  const shownSources = sources.slice(0, MAX_SOURCES);
  const moreSources = sources.length - shownSources.length;
  const subagentParts = [
    runningSubagents > 0
      ? intl.formatMessage(
          { id: "conversationSummary.subagentsRunning" },
          { count: String(runningSubagents) },
        )
      : null,
    endedSubagents > 0
      ? intl.formatMessage(
          { id: "conversationSummary.subagentsDone" },
          { count: String(endedSubagents) },
        )
      : null,
  ].filter(Boolean);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={intl.formatMessage({ id: "conversationSummary.title" })}
      className="absolute top-2 right-3 z-30 flex w-80 max-w-[calc(100%-1.5rem)] animate-in flex-col gap-1 rounded-2xl border border-glass-border bg-card p-1.5 pb-2 shadow-[0_18px_44px_-14px_var(--color-glass-edge),0_2px_8px_var(--color-glass-edge)] fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
    >
      <div className="flex flex-col gap-0.5 px-1.5 pt-1 pb-1.5">
        <Row icon={<FolderOpen className="size-4" />}>
          <span className="font-medium">{projectName}</span>
        </Row>
        {branchName ? (
          <Row icon={<GitBranch className="size-4" />} muted>
            {branchName}
          </Row>
        ) : null}
        <Row
          icon={<DiffIcon className="size-4" />}
          onClick={hasChanges ? onOpenChanges : undefined}
          muted={!hasChanges}
          trailing={
            hasChanges && changes ? (
              <span className="flex shrink-0 gap-1.5 font-mono text-ui-sm">
                <span className="text-diff-added">+{changes.added}</span>
                <span className="text-diff-removed">−{changes.removed}</span>
              </span>
            ) : null
          }
        >
          {intl.formatMessage({
            id: hasChanges ? "conversationSummary.changes" : "conversationSummary.noChanges",
          })}
        </Row>
      </div>
      <Section title={intl.formatMessage({ id: "conversationSummary.subagents" })}>
        {subagentParts.length > 0 ? (
          <Row
            icon={<Bot className="size-4" />}
            onClick={onOpenSubagents}
            trailing={
              onOpenSubagents ? (
                <ChevronRight className="size-3.5 shrink-0 text-foreground-subtlest" />
              ) : null
            }
          >
            {subagentParts.join(" · ")}
          </Row>
        ) : (
          <Row icon={<Bot className="size-4" />} muted>
            {intl.formatMessage({ id: "conversationSummary.noSubagents" })}
          </Row>
        )}
      </Section>
      <Section title={intl.formatMessage({ id: "conversationSummary.sources" })}>
        {shownSources.length === 0 ? (
          <Row icon={<Link2 className="size-4" />} muted>
            {intl.formatMessage({ id: "conversationSummary.noSources" })}
          </Row>
        ) : (
          shownSources.map((source) =>
            source.kind === "link" ? (
              <Row
                key={source.key}
                icon={<Link2 className="size-4" />}
                onClick={onOpenLink ? () => onOpenLink(source.url) : undefined}
              >
                {source.label}
              </Row>
            ) : source.kind === "search" ? (
              <Row key={source.key} icon={<Globe className="size-4" />}>
                {intl.formatMessage({ id: "conversationSummary.webSearch" })}
              </Row>
            ) : (
              <Row key={source.key} icon={<Plug className="size-4" />}>
                {source.label}
              </Row>
            ),
          )
        )}
        {moreSources > 0 ? (
          <Row icon={null} muted>
            {intl.formatMessage(
              { id: "conversationSummary.moreSources" },
              { count: String(moreSources) },
            )}
          </Row>
        ) : null}
      </Section>
    </div>
  );
}
