import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { motion, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TaskGlassCard } from "./TaskGlassCard.js";
import { formatConversationCount } from "./taskStackEntries.js";
import type { TaskStackEntry, TaskStackGroup } from "./taskStackEntries.js";
import {
  STACK_LIFT_HOVER_PX,
  STACK_LIFT_PX,
  TILE_STACK_DEPTH,
  stackDepthPose,
} from "./stackGeometry.js";

const SPRING = { type: "spring", stiffness: 240, damping: 26 } as const;

function ParallaxLayer({
  depth,
  pointerX,
  pointerY,
  children,
}: {
  depth: number;
  pointerX: MotionValue<number>;
  pointerY: MotionValue<number>;
  children: ReactNode;
}) {
  // Deeper cards drift further with the pointer.
  const x = useTransform(pointerX, (value) => value * (depth + 1) * 4);
  const y = useTransform(pointerY, (value) => value * (depth + 1) * 2.5);
  return (
    <motion.div className="absolute inset-0" style={{ x, y, zIndex: TILE_STACK_DEPTH - depth }}>
      {children}
    </motion.div>
  );
}

/**
 * One project as a Time Machine-style stack: the most pressing conversation
 * in front, older ones receding upward and fading. Clicking the front card
 * opens its conversation; clicking a card behind fans the stack
 * open around the front card.
 */
export function ProjectStackTile({
  group,
  fanned,
  returning,
  openKey,
  dimmed,
  pointerX,
  pointerY,
  rotateX,
  rotateY,
  onFan,
  onOpen,
}: {
  group: TaskStackGroup;
  /** The stack's cards are out in the fan overlay. */
  fanned: boolean;
  /** The fan is gathering back into this stack: its cards fade in under it. */
  returning: boolean;
  /** The card whose conversation is open; it steps aside while open. */
  openKey: string | null;
  dimmed: boolean;
  pointerX: MotionValue<number>;
  pointerY: MotionValue<number>;
  rotateX: MotionValue<number>;
  rotateY: MotionValue<number>;
  onFan: (groupKey: string, cardArea: HTMLElement) => void;
  onOpen: (entry: TaskStackEntry) => void;
}) {
  const { intl } = useZCodeIntl();
  const [hovered, setHovered] = useState(false);
  const cardAreaRef = useRef<HTMLDivElement>(null);
  // Each card behind peeks out by this much — enough for its header row.
  const lift = hovered ? STACK_LIFT_HOVER_PX : STACK_LIFT_PX;
  const footnote = formatConversationCount(intl, group.conversationCount);
  const fanLabel = intl.formatMessage(
    { id: "taskStack.showAll" },
    { project: group.name, count: String(group.entries.length) },
  );
  const handleFan = () => {
    if (cardAreaRef.current) {
      onFan(group.key, cardAreaRef.current);
    }
  };

  return (
    <motion.div
      role="group"
      aria-label={group.name}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      animate={{ opacity: dimmed ? 0.35 : 1, scale: dimmed ? 0.97 : 1 }}
      transition={{ duration: 0.25 }}
      className="relative aspect-[5/4] w-full min-w-0"
    >
      <motion.div
        ref={cardAreaRef}
        className="absolute inset-x-0 top-[28%] bottom-0"
        style={{ transformPerspective: 1100, rotateX, rotateY }}
      >
        {fanned
          ? null
          : group.entries.map((entry, index) => {
              const { depth, parked, y, scale, opacity } = stackDepthPose(index, lift);
              const isFront = index === 0;
              const canFan = !isFront && !parked && group.entries.length > 1;
              const open = entry.key === openKey;
              return (
                <ParallaxLayer
                  key={entry.key}
                  depth={depth}
                  pointerX={pointerX}
                  pointerY={pointerY}
                >
                  <TaskGlassCard
                    entry={entry}
                    variant={isFront ? "front" : "back"}
                    projectName={group.name}
                    footnote={footnote}
                    layoutId={entry.key}
                    originId={isFront ? entry.taskId : undefined}
                    // Anchored at the top so each card behind peeks out above
                    // the one in front, receding and fading like Time Machine.
                    className={cn("size-full origin-top", parked && "pointer-events-none")}
                    initial={returning ? { opacity: 0 } : undefined}
                    animate={{
                      y: isFront ? (hovered ? -3 : 0) : y,
                      scale,
                      opacity: open ? 0 : opacity,
                    }}
                    transition={
                      returning
                        ? // Fades in as the fanned cards land on it.
                          { ...SPRING, opacity: { delay: 0.14, duration: 0.18 } }
                        : isFront || open
                          ? // Steps aside and back at once, under the open
                            // conversation's outline.
                            { ...SPRING, opacity: { duration: 0 } }
                          : SPRING
                    }
                    ariaLabel={canFan ? fanLabel : undefined}
                    // One tab stop opens the fan; the other peeks stay pointer-only.
                    focusable={isFront || depth === 1}
                    onOpen={isFront ? onOpen : canFan ? handleFan : undefined}
                  />
                </ParallaxLayer>
              );
            })}
      </motion.div>
    </motion.div>
  );
}
