import { describe, expect, it } from "vitest";
import {
  clampFloatingPaneRect,
  resizeFloatingPaneRect,
} from "@/app-shell/floatingPane.js";

const start = { x: 200, y: 150, width: 600, height: 300 };

describe("floating pane geometry", () => {
  it("moves the whole pane", () => {
    expect(resizeFloatingPaneRect(start, "move", -50, 20)).toEqual({
      x: 150,
      y: 170,
      width: 600,
      height: 300,
    });
  });

  it("keeps the opposite edge fixed when resizing from the top-left", () => {
    const next = resizeFloatingPaneRect(start, "nw", 100, 40);
    expect(next).toEqual({ x: 300, y: 190, width: 500, height: 260 });
    expect(next.x + next.width).toBe(start.x + start.width);
    expect(next.y + next.height).toBe(start.y + start.height);
  });

  it("does not shrink below the minimum size", () => {
    const next = resizeFloatingPaneRect(start, "se", -1000, -1000);
    expect(next.width).toBe(320);
    expect(next.height).toBe(160);
    const fromLeft = resizeFloatingPaneRect(start, "w", 1000, 0);
    expect(fromLeft.width).toBe(320);
    expect(fromLeft.x + fromLeft.width).toBe(start.x + start.width);
  });

  it("keeps the pane on screen", () => {
    expect(clampFloatingPaneRect({ x: -40, y: 900, width: 600, height: 300 }, 1200, 800)).toEqual({
      x: 8,
      y: 492,
      width: 600,
      height: 300,
    });
    expect(clampFloatingPaneRect({ x: 0, y: 0, width: 3000, height: 3000 }, 1200, 800)).toEqual({
      x: 8,
      y: 8,
      width: 1184,
      height: 784,
    });
  });
});
