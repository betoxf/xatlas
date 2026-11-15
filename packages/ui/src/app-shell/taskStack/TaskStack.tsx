import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layers } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion, useTransform } from "motion/react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GATHER_S, ProjectStackFan } from "./ProjectStackFan.js";
import type { TaskStackFanAnchor } from "./ProjectStackFan.js";
import { ProjectStackTile } from "./ProjectStackTile.js";
import { buildTaskStackGroups } from "./taskStackEntries.js";
import type { TaskStackEntry } from "./taskStackEntries.js";
import { useStackParallax } from "./useStackParallax.js";

/**
 * Grid of Time Machine-style liquid-glass stacks, one per project.
 * Conversations that need the user (errors, waiting for input) sit at the
 * front of their stack and their projects lead the grid.
 *
 * - Clicking a card behind the front one fans the stack open in place over
 *   the dimmed grid.
 * - Clicking a front card (or any fanned card) opens the conversation, which
 *   grows out of that card (see StackConversationFrame).
 *
 * Rendered with the Zai Light tokens for now, whatever the app theme.
 */
export function TaskStack({
  entries,
  openTaskId,
  onOpen,
}: {
  entries: readonly TaskStackEntry[];
  /** Conversation open over the Stack, if any. */
  openTaskId: string | null;
  onOpen: (entry: TaskStackEntry) => void;
}) {
  const { intl } = useZCodeIntl();
  const reduceMotion = useReducedMotion() ?? false;
  const parallax = useStackParallax();
  const groups = useMemo(() => buildTaskStackGroups(entries), [entries]);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fan, setFan] = useState<{ key: string; anchor: TaskStackFanAnchor } | null>(null);
  const fanGroup = fan ? (groups.find((group) => group.key === fan.key) ?? null) : null;
  // The backdrop drifts furthest, the deepest parallax layer.
  const auroraX = useTransform(parallax.pointerX, (value) => value * 36);
  const auroraY = useTransform(parallax.pointerY, (value) => value * 24);

  // Closing plays the gather first (cards fly back into their stack slots
  // while the stack fades in under them), then drops the fan.
  const [fanClosing, setFanClosing] = useState(false);
  const gatherTimerRef = useRef<number | null>(null);
  const handleFan = useCallback((key: string, cardArea: HTMLElement) => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    const contentRect = content.getBoundingClientRect();
    const areaRect = cardArea.getBoundingClientRect();
    // The scroll area that clips the grid: the fan must fit inside what is visible.
    const viewport = content.parentElement?.getBoundingClientRect() ?? contentRect;
    // Re-opened mid-gather: keep it open.
    if (gatherTimerRef.current !== null) {
      window.clearTimeout(gatherTimerRef.current);
      gatherTimerRef.current = null;
    }
    setFanClosing(false);
    setFan({
      key,
      anchor: {
        left: areaRect.left - contentRect.left,
        top: areaRect.top - contentRect.top,
        width: areaRect.width,
        height: areaRect.height,
        containerWidth: contentRect.width,
        viewTop: viewport.top - contentRect.top,
        viewBottom: viewport.bottom - contentRect.top,
      },
    });
  }, []);
  const handleCloseFan = useCallback(() => {
    if (reduceMotion) {
      setFan(null);
      return;
    }
    setFanClosing(true);
    if (gatherTimerRef.current === null) {
      gatherTimerRef.current = window.setTimeout(() => {
        gatherTimerRef.current = null;
        setFan(null);
        setFanClosing(false);
      }, GATHER_S * 1000 + 80);
    }
  }, [reduceMotion]);
  useEffect(
    () => () => {
      if (gatherTimerRef.current !== null) {
        window.clearTimeout(gatherTimerRef.current);
      }
    },
    [],
  );
  const fanOpen = fan !== null && !fanClosing;
  // Opening a conversation takes its card out of the fan, so the fan closes. It
  // goes once the conversation has grown out of the card, which reads its position.
  const fanVisible = fan !== null;
  useEffect(() => {
    if (openTaskId === null || !fanVisible) return;
    const timer = window.setTimeout(() => {
      setFan(null);
      setFanClosing(false);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [openTaskId, fanVisible]);

  // The open conversation grows out of its card, so the card steps aside
  // while the conversation is open.
  const openKey = openTaskId
    ? (entries.find((entry) => entry.taskId === openTaskId)?.key ?? null)
    : null;

  return (
    <div
      onPointerMove={parallax.onPointerMove}
      onPointerLeave={parallax.onPointerLeave}
      className="theme-zai-light relative flex size-full min-h-0 overflow-hidden bg-background text-foreground select-none"
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-16"
        style={{ x: auroraX, y: auroraY }}
      >
        <div className="absolute top-[6%] left-[10%] size-[28rem] rounded-full bg-icon-blue/20 blur-3xl" />
        <div className="absolute top-[30%] right-[6%] size-96 rounded-full bg-icon-purple/15 blur-3xl" />
        <div className="absolute bottom-[2%] left-[34%] size-80 rounded-full bg-success/10 blur-3xl" />
      </motion.div>

      {groups.length === 0 ? (
        <div className="relative m-auto flex max-w-sm flex-col items-center gap-2 px-6 text-center">
          <Layers className="size-6 text-foreground-subtle" />
          <p className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "taskStack.empty" })}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "taskStack.emptyHint" })}
          </p>
        </div>
      ) : (
        <LayoutGroup>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <div ref={contentRef} className="relative min-h-full">
              <div className="grid grid-cols-1 gap-x-10 gap-y-6 px-10 py-8 sm:grid-cols-2 lg:grid-cols-3">
                {groups.map((group) => (
                  <ProjectStackTile
                    key={group.key}
                    group={group}
                    fanned={fanOpen && group.key === fan?.key}
                    returning={fanClosing && group.key === fan?.key}
                    openKey={openKey}
                    dimmed={fanOpen && group.key !== fan?.key}
                    pointerX={parallax.pointerX}
                    pointerY={parallax.pointerY}
                    rotateX={parallax.rotateX}
                    rotateY={parallax.rotateY}
                    onFan={handleFan}
                    onOpen={onOpen}
                  />
                ))}
              </div>
              <AnimatePresence>
                {fanOpen ? (
                  <motion.div
                    key="scrim"
                    aria-hidden
                    className="absolute inset-0 z-20 bg-background/30"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.2 }}
                    onClick={handleCloseFan}
                  />
                ) : null}
                {fan && fanGroup ? (
                  <ProjectStackFan
                    key={fanGroup.key}
                    group={fanGroup}
                    anchor={fan.anchor}
                    openKey={openKey}
                    conversationOpen={openTaskId !== null}
                    closing={fanClosing}
                    reduceMotion={reduceMotion}
                    onClose={handleCloseFan}
                    onOpen={onOpen}
                  />
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </LayoutGroup>
      )}
    </div>
  );
}
