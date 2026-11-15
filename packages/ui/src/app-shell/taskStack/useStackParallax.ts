import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";

const SPRING = { stiffness: 120, damping: 20, mass: 0.6 };
const MAX_TILT_DEG = 7;

export interface StackParallax {
  /** Pointer position relative to the stage centre, -1…1 on each axis (sprung). */
  pointerX: MotionValue<number>;
  pointerY: MotionValue<number>;
  rotateX: MotionValue<number>;
  rotateY: MotionValue<number>;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
}

/**
 * Mouse parallax for the Task Stack: tilts the stacks toward the
 * pointer and exposes normalised springs that each depth layer scales.
 * Disabled (held at rest) when the user prefers reduced motion.
 */
export function useStackParallax(): StackParallax {
  const reduceMotion = useReducedMotion() ?? false;
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const pointerX = useSpring(rawX, SPRING);
  const pointerY = useSpring(rawY, SPRING);
  const rotateY = useTransform(pointerX, (value) => value * MAX_TILT_DEG);
  const rotateX = useTransform(pointerY, (value) => -value * MAX_TILT_DEG);
  const frameRef = useRef<number | null>(null);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      if (reduceMotion || frameRef.current !== null) {
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        // Inverted: layers move away from the pointer, like looking past them.
        rawX.set(1 - (localX / rect.width) * 2);
        rawY.set(1 - (localY / rect.height) * 2);
      });
    },
    [rawX, rawY, reduceMotion],
  );

  const onPointerLeave = useCallback(() => {
    rawX.set(0);
    rawY.set(0);
  }, [rawX, rawY]);

  return { pointerX, pointerY, rotateX, rotateY, onPointerMove, onPointerLeave };
}
