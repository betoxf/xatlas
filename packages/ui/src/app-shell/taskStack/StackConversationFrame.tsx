import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Where the conversation card sits over the Stack: the inset leaves room for
 * the window chrome above and the dimmed Stack around it. Fixed to the window,
 * so an open side pane or terminal floats over the card instead of shrinking it.
 */
const STACK_CONVERSATION_INSET_CLASS = "fixed inset-1 z-20 flex px-16 pt-[5.5rem] pb-10";

/** Marks the Stack card a conversation grows out of (and shrinks back into). */
export const STACK_ORIGIN_ATTR = "data-stack-origin";

const OPEN_MS = 480;
const CLOSE_MS = 400;
const FALLBACK_MS = 240;
/** Decelerates into place, like a well-damped spring. */
const SETTLE_EASING = "cubic-bezier(0.2, 0.9, 0.22, 1)";

/** Where a conversation grows from: its Stack card, relative to the open card. */
interface Origin {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * Measures the Stack card against the open card's slot and puts a snapshot of
 * the card's face, at the card's size, into `ghost`.
 */
function measureOrigin(
  originId: string | null,
  slot: HTMLElement,
  ghost: HTMLElement,
): Origin | null {
  ghost.replaceChildren();
  const origin = originId
    ? document.querySelector<HTMLElement>(`[${STACK_ORIGIN_ATTR}="${CSS.escape(originId)}"]`)
    : null;
  if (!origin) {
    return null;
  }
  const slotRect = slot.getBoundingClientRect();
  const rect = origin.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0 || slotRect.width === 0 || slotRect.height === 0) {
    return null;
  }
  // The card may be scaled (fanned cards are), so lay the snapshot out at
  // the card's own size and scale it the same way.
  const width = origin.offsetWidth || rect.width;
  const snapshot = origin.cloneNode(true) as HTMLElement;
  snapshot.removeAttribute(STACK_ORIGIN_ATTR);
  snapshot.removeAttribute("tabindex");
  snapshot.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${
    origin.offsetHeight || rect.height
  }px;transform:scale(${rect.width / width});transform-origin:0 0;opacity:1`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.replaceChildren(snapshot);
  return {
    dx: rect.left - slotRect.left,
    dy: rect.top - slotRect.top,
    scaleX: rect.width / slotRect.width,
    scaleY: rect.height / slotRect.height,
  };
}

/**
 * Keyframes that carry the open card between its Stack card and its place.
 * Only transform and opacity change, so the compositor runs them at full
 * frame rate whatever the main thread is doing.
 */
function containerTransform(origin: Origin, opening: boolean) {
  const cardAtOrigin = `translate(${origin.dx}px, ${origin.dy}px) scale(${origin.scaleX}, ${origin.scaleY})`;
  // The snapshot of the card's face rides the card's corner and grows with it.
  const ghostAtOrigin = `translate(${origin.dx}px, ${origin.dy}px)`;
  const ghostOpen = `scale(${1 / origin.scaleX}, ${1 / origin.scaleY})`;
  if (opening) {
    return {
      card: [{ transform: cardAtOrigin }, { transform: "none" }],
      // The card appears just after its face starts to grow, so its squeezed
      // corners never show around the snapshot.
      cardOpacity: [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1 }],
      content: [{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1, offset: 0.8 }, { opacity: 1 }],
      ghost: [{ transform: ghostAtOrigin }, { transform: ghostOpen }],
      ghostOpacity: [{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }],
      backdrop: [{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }],
    };
  }
  return {
    card: [{ transform: "none" }, { transform: cardAtOrigin }],
    cardOpacity: [{ opacity: 1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }],
    content: [{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }],
    ghost: [{ transform: ghostOpen }, { transform: ghostAtOrigin }],
    ghostOpacity: [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1, offset: 0.85 }, { opacity: 1 }],
    backdrop: [{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }],
  };
}

/**
 * An open conversation floating as a card over the dimmed Stack. It grows out
 * of its Stack card (container transform: the card zooms up while its face
 * fades into the conversation) and shrinks back into it on close. Clicking
 * around it, or Escape while not typing, closes it.
 */
function StackConversationFrame({
  originId,
  header,
  onClose,
  children,
}: {
  originId: string | null;
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const backdropRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef<Animation[]>([]);
  const closingRef = useRef(false);
  const originIdRef = useRef(originId);
  originIdRef.current = originId;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /** Plays the open or close transition; resolves when it has finished. */
  const play = useCallback((opening: boolean): Promise<unknown> | null => {
    const backdrop = backdropRef.current;
    const slot = slotRef.current;
    const card = cardRef.current;
    const content = contentRef.current;
    const ghost = ghostRef.current;
    if (!backdrop || !slot || !card || !content || !ghost) {
      return null;
    }
    const origin = measureOrigin(originIdRef.current, slot, ghost);
    const eased: KeyframeAnimationOptions = {
      duration: origin ? (opening ? OPEN_MS : CLOSE_MS) : FALLBACK_MS,
      easing: SETTLE_EASING,
      fill: "both",
    };
    const linear: KeyframeAnimationOptions = { ...eased, easing: "linear" };
    let animations: Animation[];
    if (origin) {
      const frames = containerTransform(origin, opening);
      animations = [
        card.animate(frames.card, eased),
        card.animate(frames.cardOpacity, linear),
        content.animate(frames.content, linear),
        ghost.animate(frames.ghost, eased),
        ghost.animate(frames.ghostOpacity, linear),
        backdrop.animate(frames.backdrop, linear),
      ];
    } else {
      // Its card is not on screen in the Stack: a plain fade and settle.
      const hidden = { opacity: 0, transform: "translateY(8px) scale(0.98)" };
      const shown = { opacity: 1, transform: "none" };
      animations = [
        card.animate(opening ? [hidden, shown] : [shown, hidden], eased),
        backdrop.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], eased),
      ];
    }
    runningRef.current = animations;
    return Promise.all(animations.map((animation) => animation.finished));
  }, []);

  useLayoutEffect(() => {
    if (reduceMotion) {
      return;
    }
    // Plays once, when the frame opens; switching conversations keeps it open.
    const opening = play(true);
    opening?.then(
      () => {
        if (closingRef.current) {
          return;
        }
        // Settled: drop the animations, whose end state is the natural one.
        for (const animation of runningRef.current) {
          animation.cancel();
        }
        runningRef.current = [];
        ghostRef.current?.replaceChildren();
      },
      () => {
        // Cancelled on unmount.
      },
    );
  }, [play, reduceMotion]);

  const close = useCallback(() => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    if (reduceMotion) {
      onCloseRef.current();
      return;
    }
    const stillOpening = runningRef.current.filter(
      (animation) => animation.playState === "running",
    );
    let finished: Promise<unknown> | null;
    if (stillOpening.length > 0) {
      // Closed mid-open: run the same motion back from where it is.
      for (const animation of stillOpening) {
        animation.reverse();
      }
      finished = Promise.all(stillOpening.map((animation) => animation.finished));
    } else {
      finished = play(false);
    }
    // The end state holds (fill) until the Stack takes over.
    const done = () => onCloseRef.current();
    (finished ?? Promise.resolve()).then(done, done);
  }, [play, reduceMotion]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !isEditableTarget(event.target)) {
        close();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  return (
    <div className={STACK_CONVERSATION_INSET_CLASS}>
      {/* The dim covers the whole window, under the floating side pane and
          terminal too. */}
      <div
        ref={backdropRef}
        aria-hidden
        className="fixed inset-0 bg-background/45"
        onClick={close}
      />
      <div ref={slotRef} className="relative flex min-h-0 min-w-0 flex-1">
        <div
          ref={cardRef}
          role="dialog"
          className="relative flex min-h-0 min-w-0 flex-1 origin-top-left flex-col overflow-hidden rounded-2xl border border-glass-border bg-card shadow-[inset_0_1px_0_var(--color-glass-highlight),0_24px_60px_-20px_var(--color-glass-edge),0_2px_10px_var(--color-glass-edge)]"
        >
          <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
            {header}
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </div>
        </div>
        {/* The Stack card's face, growing with the card as it fades. */}
        <div
          ref={ghostRef}
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 origin-top-left"
        />
      </div>
    </div>
  );
}

/** Renders the conversation in the floating frame when `active`, inline otherwise. */
export function StackConversationFrameSwitch({
  active,
  originId,
  header,
  onClose,
  children,
}: {
  active: boolean;
  /** Task whose Stack card the frame grows out of, if it is on screen. */
  originId: string | null;
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!active) {
    return <>{children}</>;
  }
  return (
    <StackConversationFrame originId={originId} header={header} onClose={onClose}>
      {children}
    </StackConversationFrame>
  );
}
