import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { centredStackDepthPose } from "./stackGeometry.js";
import { TaskGlassCard } from "./TaskGlassCard.js";
import { formatConversationCount } from "./taskStackEntries.js";
import type { TaskStackEntry, TaskStackGroup } from "./taskStackEntries.js";

/** Cards scattered around the front one when a stack opens. */
const MAX_BLADES = 6;
/** Scattered cards are a little smaller than the front card. */
const BLADE_SCALE = 0.78;
const EDGE_PX = 12;
const BLADE_STAGGER_S = 0.04;
/** How long the cards take to gather back into the stack (s). */
export const GATHER_S = 0.32;

/** The stack's card area and the visible window, in grid-content coordinates. */
export interface TaskStackFanAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
  containerWidth: number;
  /** Visible top and bottom of the scroll area, so the cards stay on screen. */
  viewTop: number;
  viewBottom: number;
}

/**
 * Slots around the front card, in card widths/heights from its centre, in fill
 * order: a row above (centre, left, right), then below, then the sides.
 */
const SLOTS = [
  { x: 0, y: -1.12, rotate: 0 },
  { x: -0.98, y: -0.92, rotate: -3 },
  { x: 0.98, y: -0.92, rotate: 3 },
  { x: -0.72, y: 1.08, rotate: 2.5 },
  { x: 0.72, y: 1.08, rotate: -2.5 },
  { x: 0, y: 1.2, rotate: 0 },
] as const;

/** Open toward the side with more visible room: upward unless the stack sits high. */
export function fanOpensUp(anchor: TaskStackFanAnchor): boolean {
  const roomAbove = anchor.top - anchor.viewTop;
  const roomBelow = anchor.viewBottom - (anchor.top + anchor.height);
  return roomAbove >= roomBelow;
}

/**
 * Where each scattered card goes, as offsets (px) from the front card's
 * position, kept inside the visible area.
 */
export function scatterOffsets(
  count: number,
  anchor: TaskStackFanAnchor,
): { x: number; y: number; rotate: number }[] {
  const up = fanOpensUp(anchor);
  const halfW = (anchor.width * BLADE_SCALE) / 2;
  const halfH = (anchor.height * BLADE_SCALE) / 2;
  const centreX = anchor.left + anchor.width / 2;
  const centreY = anchor.top + anchor.height / 2;
  const clamp = (value: number, min: number, max: number) =>
    min > max ? (min + max) / 2 : Math.min(Math.max(value, min), max);
  const placed = SLOTS.slice(0, count).map((slot) => ({
    x: centreX + slot.x * anchor.width,
    y: centreY + (up ? slot.y : -slot.y) * anchor.height,
    row: Math.sign(slot.y),
    rotate: slot.rotate,
  }));
  // Shift each row as a whole so cards near a screen edge keep their spacing
  // instead of piling onto one another.
  for (const row of [-1, 1]) {
    const members = placed.filter((card) => card.row === row);
    if (members.length === 0) {
      continue;
    }
    const minX = Math.min(...members.map((card) => card.x)) - halfW;
    const maxX = Math.max(...members.map((card) => card.x)) + halfW;
    const shift =
      minX < EDGE_PX
        ? EDGE_PX - minX
        : maxX > anchor.containerWidth - EDGE_PX
          ? anchor.containerWidth - EDGE_PX - maxX
          : 0;
    for (const card of members) {
      card.x += shift;
    }
  }
  return placed.map((card) => ({
    x: clamp(card.x, halfW + EDGE_PX, anchor.containerWidth - halfW - EDGE_PX) - centreX,
    y:
      clamp(card.y, anchor.viewTop + halfH + EDGE_PX, anchor.viewBottom - halfH - EDGE_PX) -
      centreY,
    rotate: card.rotate,
  }));
}

/**
 * A project's stack, opened: the front card stays exactly where it was and up
 * to six cards from behind it scatter out around it, slightly smaller and
 * tilted, floating gently. Clicking any card opens its conversation;
 * Escape or a click outside gathers them back into the stack.
 */
export function ProjectStackFan({
  group,
  anchor,
  openKey,
  conversationOpen,
  closing,
  reduceMotion,
  onClose,
  onOpen,
}: {
  group: TaskStackGroup;
  anchor: TaskStackFanAnchor;
  /** Gathering back into the stack (the stack fades in underneath). */
  closing: boolean;
  /** The card whose conversation is open; it steps aside while open. */
  openKey: string | null;
  /** A conversation is open over the Stack (it handles Escape then). */
  conversationOpen: boolean;
  reduceMotion: boolean;
  onClose: () => void;
  onOpen: (entry: TaskStackEntry) => void;
}) {
  const { intl } = useZCodeIntl();
  const frontRef = useRef<HTMLDivElement>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [front, ...rest] = group.entries;
  const blades = rest.slice(0, MAX_BLADES);
  const offsets = scatterOffsets(blades.length, anchor);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !conversationOpen) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [conversationOpen, onClose]);

  useEffect(() => {
    frontRef.current?.querySelector<HTMLElement>("[role=button]")?.focus({ preventScroll: true });
  }, []);

  if (!front) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-label={group.name}
      // The conversation opened from the fan covers it; it's taken away underneath.
      className={cn("absolute z-30", closing && "pointer-events-none", conversationOpen && "invisible")}
      style={{ left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }}
    >
      {blades.map((entry, index) => {
        const offset = offsets[index] ?? { x: 0, y: 0, rotate: 0 };
        const hovered = !closing && entry.key === hoveredKey;
        // Where this card sits in the stack: it flies out from there and
        // gathers back to exactly there.
        const inStack = centredStackDepthPose(index + 1, anchor.height);
        const stackPose = { x: 0, y: inStack.y, rotate: 0, scale: inStack.scale };
        return (
          // Outer layer: a slow, tiny drift so the open cards feel like they float.
          <motion.div
            key={entry.key}
            className="absolute inset-0"
            style={{ zIndex: hovered ? 150 : 100 + index }}
            animate={reduceMotion || hovered || closing ? { y: 0 } : { y: [0, -4, 0] }}
            transition={
              reduceMotion || hovered || closing
                ? { duration: 0.2 }
                : {
                    duration: 3.4 + index * 0.45,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: 0.7 + index * 0.3,
                  }
            }
          >
            <TaskGlassCard
              entry={entry}
              variant="front"
              projectName={group.name}
              originId={entry.taskId}
              // Nearly opaque: the open cards float over the grid's text.
              className="absolute inset-0 bg-card/95"
              initial={reduceMotion ? false : { ...stackPose, opacity: inStack.opacity }}
              animate={
                closing
                  ? { ...stackPose, opacity: 0 }
                  : {
                      x: offset.x,
                      y: offset.y,
                      rotate: hovered ? 0 : offset.rotate,
                      scale: hovered ? BLADE_SCALE + 0.04 : BLADE_SCALE,
                      opacity: entry.key === openKey ? 0 : 1,
                    }
              }
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : closing
                    ? {
                        type: "spring",
                        visualDuration: GATHER_S,
                        bounce: 0,
                        delay: (blades.length - 1 - index) * BLADE_STAGGER_S * 0.5,
                        // Hands over to the stack's own cards as it lands.
                        opacity: { delay: GATHER_S * 0.45, duration: GATHER_S * 0.5 },
                      }
                    : {
                        type: "spring",
                        stiffness: 200,
                        damping: 22,
                        delay: hoveredKey ? 0 : index * BLADE_STAGGER_S,
                        opacity:
                          entry.key === openKey
                            ? // Steps aside at once: the conversation covers its spot.
                              { duration: 0 }
                            : { duration: 0.12, delay: index * BLADE_STAGGER_S },
                      }
              }
              ariaLabel={entry.title}
              onOpen={onOpen}
              onHoverChange={(hovering) => setHoveredKey(hovering ? entry.key : null)}
            />
          </motion.div>
        );
      })}
      <div ref={frontRef} className="absolute inset-0" style={{ zIndex: 200 }}>
        <TaskGlassCard
          entry={front}
          variant="front"
          projectName={group.name}
          footnote={formatConversationCount(intl, group.conversationCount)}
          originId={front.taskId}
          // Same glass as in the stack, so nothing changes as the fan swaps in.
          className="size-full"
          animate={{ opacity: front.key === openKey ? 0 : 1 }}
          transition={{ opacity: { duration: 0 } }}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}
