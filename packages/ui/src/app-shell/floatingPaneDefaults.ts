import type { FloatingPaneRect } from "@/app-shell/floatingPane.js";

/** First place of the floating side pane: over the right of the conversation. */
export function defaultFloatingSidePaneRect(
  viewportWidth: number,
  viewportHeight: number,
): FloatingPaneRect {
  const width = Math.min(720, Math.max(380, Math.round(viewportWidth * 0.4)));
  const top = 112;
  return { x: viewportWidth - width - 20, y: top, width, height: viewportHeight - top - 20 };
}

/** First place of the floating terminal: over the bottom of the conversation. */
export function defaultFloatingTerminalRect(
  viewportWidth: number,
  viewportHeight: number,
): FloatingPaneRect {
  const width = Math.min(960, viewportWidth - 192);
  const height = Math.min(420, Math.max(200, Math.round(viewportHeight * 0.32)));
  return {
    x: Math.round((viewportWidth - width) / 2),
    y: viewportHeight - height - 20,
    width,
    height,
  };
}
