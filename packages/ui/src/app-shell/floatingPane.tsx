import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

/** A floating pane's place on screen, in viewport pixels. */
export interface FloatingPaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 160;
const SCREEN_MARGIN = 8;
/** Pressing in this band at the top of a pane (off its controls) drags it. */
const DRAG_BAND_PX = 44;
const INTERACTIVE_SELECTOR =
  "button,a,input,textarea,select,[role=tab],[role=button],[role=menuitem],[contenteditable=true],.xterm";

export function clampFloatingPaneRect(
  rect: FloatingPaneRect,
  viewportWidth: number,
  viewportHeight: number,
): FloatingPaneRect {
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), viewportWidth - SCREEN_MARGIN * 2);
  const height = Math.min(Math.max(rect.height, MIN_HEIGHT), viewportHeight - SCREEN_MARGIN * 2);
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, SCREEN_MARGIN), viewportWidth - width - SCREEN_MARGIN),
    y: Math.min(Math.max(rect.y, SCREEN_MARGIN), viewportHeight - height - SCREEN_MARGIN),
  };
}

/** The rect after dragging `edge` (or the whole pane, for "move") by dx/dy. */
export function resizeFloatingPaneRect(
  start: FloatingPaneRect,
  edge: Edge | "move",
  dx: number,
  dy: number,
): FloatingPaneRect {
  if (edge === "move") {
    return { ...start, x: start.x + dx, y: start.y + dy };
  }
  let { x, y, width, height } = start;
  if (edge.includes("e")) {
    width = Math.max(MIN_WIDTH, start.width + dx);
  }
  if (edge.includes("s")) {
    height = Math.max(MIN_HEIGHT, start.height + dy);
  }
  if (edge.includes("w")) {
    width = Math.max(MIN_WIDTH, start.width - dx);
    x = start.x + start.width - width;
  }
  if (edge.includes("n")) {
    height = Math.max(MIN_HEIGHT, start.height - dy);
    y = start.y + start.height - height;
  }
  return { x, y, width, height };
}

function readStoredRect(storageKey: string): FloatingPaneRect | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (
      parsed &&
      typeof parsed === "object" &&
      ["x", "y", "width", "height"].every(
        (key) => typeof (parsed as Record<string, unknown>)[key] === "number",
      )
    ) {
      return parsed as FloatingPaneRect;
    }
  } catch {
    // Unreadable storage: fall back to the default place.
  }
  return null;
}

/**
 * Where a floating pane sits, remembered across sessions and kept on screen
 * when the window shrinks.
 */
export function useFloatingPaneRect(
  storageKey: string,
  defaultRect: (viewportWidth: number, viewportHeight: number) => FloatingPaneRect,
) {
  const [rect, setRect] = useState(() => {
    if (typeof window === "undefined") {
      // Rendered without a window (server/static render): any place will do.
      return defaultRect(1280, 800);
    }
    return clampFloatingPaneRect(
      readStoredRect(storageKey) ?? defaultRect(window.innerWidth, window.innerHeight),
      window.innerWidth,
      window.innerHeight,
    );
  });
  useEffect(() => {
    const handleResize = () =>
      setRect((current) => clampFloatingPaneRect(current, window.innerWidth, window.innerHeight));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  const commit = useCallback(
    (next: FloatingPaneRect) => {
      const clamped = clampFloatingPaneRect(next, window.innerWidth, window.innerHeight);
      setRect(clamped);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(clamped));
      } catch {
        // Not remembered this time; the pane still moves.
      }
    },
    [storageKey],
  );
  return [rect, commit] as const;
}

export function floatingPaneStyle(rect: FloatingPaneRect): CSSProperties {
  return { position: "fixed", left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function applyRect(element: HTMLElement, rect: FloatingPaneRect) {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

const EDGE_HANDLES: { edge: Edge; className: string }[] = [
  { edge: "n", className: "inset-x-3 top-0 h-1.5 cursor-ns-resize" },
  { edge: "s", className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize" },
  { edge: "w", className: "inset-y-3 left-0 w-1.5 cursor-ew-resize" },
  { edge: "e", className: "inset-y-3 right-0 w-1.5 cursor-ew-resize" },
  { edge: "nw", className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { edge: "se", className: "right-0 bottom-0 size-3 cursor-nwse-resize" },
  { edge: "ne", className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
];

/**
 * Drag and resize for a pane floating over the conversation. Rendered inside
 * the pane's frame (a fixed-position element): its top band moves the pane,
 * its edges and corners resize it. While dragging, the frame is moved directly
 * so the pane's contents don't re-render; the result is committed on release.
 */
export function FloatingPaneHandles({
  rect,
  onCommit,
}: {
  rect: FloatingPaneRect;
  onCommit: (rect: FloatingPaneRect) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const startGesture = useCallback(
    (edge: Edge | "move", event: PointerEvent | ReactPointerEvent) => {
      const frame = rootRef.current?.parentElement;
      if (!frame || event.button !== 0) {
        return;
      }
      event.preventDefault();
      const start = rectRef.current;
      const startX = event.clientX;
      const startY = event.clientY;
      let latest = start;
      let raf = 0;
      const previousCursor = document.body.style.cursor;
      document.body.style.cursor =
        edge === "move" ? "grabbing" : getComputedStyle(event.target as Element).cursor;
      document.body.classList.add("select-none");
      const handleMove = (moveEvent: PointerEvent) => {
        latest = clampFloatingPaneRect(
          resizeFloatingPaneRect(
            start,
            edge,
            moveEvent.clientX - startX,
            moveEvent.clientY - startY,
          ),
          window.innerWidth,
          window.innerHeight,
        );
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            applyRect(frame, latest);
          });
        }
      };
      const handleUp = () => {
        cancelAnimationFrame(raf);
        applyRect(frame, latest);
        document.body.style.cursor = previousCursor;
        document.body.classList.remove("select-none");
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        onCommit(latest);
        // Content that tracks its own box (an embedded browser) re-syncs.
        window.dispatchEvent(new Event("resize"));
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [onCommit],
  );

  // The header band moves the pane wherever it isn't a control.
  useEffect(() => {
    const frame = rootRef.current?.parentElement;
    if (!frame) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const top = frame.getBoundingClientRect().top;
      if (
        event.clientY - top > DRAG_BAND_PX ||
        !target ||
        target.closest(INTERACTIVE_SELECTOR) ||
        rootRef.current?.contains(target)
      ) {
        return;
      }
      startGesture("move", event);
    };
    frame.addEventListener("pointerdown", handlePointerDown);
    return () => frame.removeEventListener("pointerdown", handlePointerDown);
  }, [startGesture]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-50">
      {EDGE_HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          aria-hidden
          className={`pointer-events-auto absolute ${className}`}
          onPointerDown={(event) => startGesture(edge, event)}
        />
      ))}
      {/* Grabber: shows where to hold the pane; sits just under the top
          resize edge so the two don't fight over the press. */}
      <div
        aria-hidden
        className="group/grabber pointer-events-auto absolute top-1.5 left-1/2 flex h-3 w-16 -translate-x-1/2 cursor-grab items-start justify-center"
        onPointerDown={(event) => startGesture("move", event)}
      >
        <span className="h-1 w-10 rounded-full bg-foreground-subtlest/30 transition-colors group-hover/grabber:bg-foreground-subtlest/60" />
      </div>
    </div>
  );
}
