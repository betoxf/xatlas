import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { FolderOpen } from "lucide-react";
import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import type { MotionStyle, TargetAndTransition, Transition } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import {
  OrchestratorJobFace,
  OrchestratorJobMark,
} from "@/app-shell/orchestrator/OrchestratorJobFace.js";
import { jobStatusLabelId } from "@/app-shell/orchestrator/orchestratorLabels.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { STACK_ORIGIN_ATTR } from "./StackConversationFrame.js";
import type { TaskStackEntry, TaskStackStatus } from "./taskStackEntries.js";

/**
 * front    — the card on top of a project's stack (project, title, changes)
 * back     — a card behind it: header row only
 */
type TaskGlassCardVariant = "front" | "back";

const STATUS_CLASS: Record<Exclude<TaskStackStatus, "idle">, string> = {
  running: "text-success",
  waiting: "text-warning",
  error: "text-destructive",
  unread: "text-icon-blue",
};

function StatusBadge({
  status,
  label = true,
  text,
}: {
  status: TaskStackStatus;
  label?: boolean;
  /** Replaces the conversation status label (a job's phase). */
  text?: string;
}) {
  const { intl } = useZCodeIntl();
  if (status === "idle") {
    return null;
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-ui-sm font-medium",
        STATUS_CLASS[status],
      )}
    >
      <span
        className={cn("size-1.5 rounded-full bg-current", status === "running" && "animate-pulse")}
      />
      {label ? (text ?? intl.formatMessage({ id: `taskStack.status.${status}` })) : null}
    </span>
  );
}

function ChangeSummary({ entry }: { entry: TaskStackEntry }) {
  if (!entry.added && !entry.removed) {
    return null;
  }
  return (
    <span className="flex items-center gap-2 font-mono text-ui-sm">
      <span className="text-diff-added">+{entry.added ?? 0}</span>
      <span className="text-diff-removed">−{entry.removed ?? 0}</span>
    </span>
  );
}

/**
 * Liquid-glass conversation card: translucent fill, a hairline rim with an
 * inner highlight, and a specular sheen that follows the pointer. No backdrop
 * blur: the Stack's backdrop is already soft, and re-blurring every card on
 * each parallax frame is what kept the Stack from running at full frame rate. Stack and fan render the same `layoutId`, so Motion flies a
 * card between its place in the stack and its place in the fan.
 */
export function TaskGlassCard({
  entry,
  variant,
  projectName,
  footnote,
  layoutId,
  originId,
  animate,
  initial,
  exit,
  transition,
  style,
  className,
  ariaLabel,
  focusable = true,
  mirrored = false,
  onOpen,
  onHoverChange,
}: {
  entry: TaskStackEntry;
  variant: TaskGlassCardVariant;
  /** Shown in the front card's header. */
  projectName?: string;
  /** Trailing note in the front card's footer (e.g. conversation count). */
  footnote?: string;
  layoutId?: string;
  /** Task id when this card is where its conversation opens from. */
  originId?: string;
  animate?: TargetAndTransition;
  initial?: TargetAndTransition | false;
  exit?: TargetAndTransition;
  transition?: Transition;
  style?: MotionStyle;
  className?: string;
  ariaLabel?: string;
  /** Interactive cards are tab stops unless this is false. */
  focusable?: boolean;
  /** Lay the header row out from the right (fan blades on the right side). */
  mirrored?: boolean;
  onOpen?: (entry: TaskStackEntry) => void;
  onHoverChange?: (hovering: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const sheenX = useMotionValue(-1000);
  const sheenY = useMotionValue(-1000);
  const sheen = useMotionTemplate`radial-gradient(320px circle at ${sheenX}px ${sheenY}px, var(--color-glass-highlight), transparent 65%)`;
  const job = entry.job?.view;
  const title =
    entry.title ||
    intl.formatMessage({ id: job ? "orchestrator.job.untitled" : "taskStack.untitled" });
  const statusText = job ? intl.formatMessage({ id: jobStatusLabelId(job) }) : undefined;
  const time = formatTaskRelativeTime(entry.updatedAt, intl);

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    sheenX.set(event.clientX - rect.left);
    sheenY.set(event.clientY - rect.top);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (onOpen && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onOpen(entry);
    }
  };

  return (
    <motion.div
      layoutId={layoutId}
      {...(originId ? { [STACK_ORIGIN_ATTR]: originId } : {})}
      initial={initial}
      animate={animate}
      exit={exit}
      transition={transition}
      style={style}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? (focusable ? 0 : -1) : undefined}
      aria-label={ariaLabel}
      onHoverStart={onHoverChange ? () => onHoverChange(true) : undefined}
      onHoverEnd={onHoverChange ? () => onHoverChange(false) : undefined}
      onClick={onOpen ? () => onOpen(entry) : undefined}
      onKeyDown={onOpen ? handleKeyDown : undefined}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        sheenX.set(-1000);
        sheenY.set(-1000);
      }}
      className={cn(
        "group/glass relative flex flex-col overflow-hidden rounded-xl border border-glass-border bg-glass text-left outline-none",
        "shadow-[inset_0_1px_0_var(--color-glass-highlight),0_12px_32px_-16px_var(--color-glass-edge)]",
        variant === "back" ? "px-4 pt-1.5" : "gap-3 p-4",
        onOpen && "cursor-pointer focus-visible:border-border-hover",
        className,
      )}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: sheen }}
      />
      <span
        className={cn(
          "relative flex min-w-0 items-center gap-2",
          mirrored && "flex-row-reverse text-right",
        )}
      >
        {variant !== "back" && projectName ? (
          <span className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="truncate">{projectName}</span>
          </span>
        ) : null}
        {variant === "back" ? (
          <>
            <StatusBadge status={entry.status} label={false} />
            {job ? <OrchestratorJobMark /> : null}
            <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{title}</span>
          </>
        ) : null}
        {variant !== "back" && job ? <OrchestratorJobMark /> : null}
        <span className="flex-1" />
        {variant === "back" ? null : (
          <StatusBadge status={entry.status} {...(statusText ? { text: statusText } : {})} />
        )}
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">{time}</span>
      </span>
      {variant === "back" ? null : (
        <span
          // shrink-0: line-clamp's overflow:hidden would otherwise let the
          // card's flex column squeeze the title and clip its glyphs.
          className="relative line-clamp-2 shrink-0 text-ui-lg font-medium text-foreground"
        >
          {title}
        </span>
      )}
      {variant === "front" && job ? <OrchestratorJobFace job={job} /> : null}
      {variant === "front" && !job ? (
        <>
          <span className="flex-1" />
          <span className="relative flex items-center gap-3">
            <ChangeSummary entry={entry} />
            <span className="flex-1" />
            <span className="text-ui-sm text-foreground-subtlest">{footnote}</span>
          </span>
        </>
      ) : null}
    </motion.div>
  );
}
