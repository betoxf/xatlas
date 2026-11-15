import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskStackEntries,
  buildTaskStackGroups,
} from "@/app-shell/taskStack/taskStackEntries.js";
import type { TaskStackEntry } from "@/app-shell/taskStack/taskStackEntries.js";
import { fanOpensUp, scatterOffsets } from "@/app-shell/taskStack/ProjectStackFan.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

function task(id: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: id,
    title: `Task ${id}`,
    workspacePath: "/Users/me/projects/atlas",
    createdAt: 0,
    updatedAt: 0,
    mode: "default",
    ...overrides,
  } as ZCodeTaskMeta;
}

describe("buildTaskStackEntries", () => {
  it("orders newest activity first and derives the workspace name from the path", () => {
    const entries = buildTaskStackEntries([
      task("a", { updatedAt: 10 }),
      task("b", { updatedAt: 30 }),
      task("c", { updatedAt: 20 }),
    ]);
    expect(entries.map((entry) => entry.taskId)).toEqual(["b", "c", "a"]);
    expect(entries[0]?.workspaceName).toBe("atlas");
  });

  it("prefers the workspace tab label and keeps identity in the key", () => {
    const [entry] = buildTaskStackEntries(
      [task("a", { workspaceIdentity: "ssh://box/atlas" })],
      () => "atlas (box)",
    );
    expect(entry?.workspaceName).toBe("atlas (box)");
    expect(entry?.key).toBe("ssh://box/atlas::a");
    expect(entry?.workspaceIdentity).toBe("ssh://box/atlas");
  });

  it("maps live activity to stack status, with waiting outranking running", () => {
    const running = attachTaskListRowActivity(task("r"), {
      phase: "running",
      lastActivityAt: 1,
      hasBackgroundWork: false,
    });
    const waiting = attachTaskListRowActivity(task("w"), {
      phase: "running",
      lastActivityAt: 2,
      hasBackgroundWork: false,
      pendingInteractions: { permissionCount: 1, userInputCount: 0 },
    } as Parameters<typeof attachTaskListRowActivity>[1]);
    const statuses = Object.fromEntries(
      buildTaskStackEntries([
        running,
        waiting,
        task("e", { status: "error" }),
        task("u", { unreadAt: 5 }),
        task("i"),
      ]).map((entry) => [entry.taskId, entry.status]),
    );
    expect(statuses).toEqual({ r: "running", w: "waiting", e: "error", u: "unread", i: "idle" });
  });

  it("carries the change summary when present", () => {
    const [entry] = buildTaskStackEntries([
      task("a", {
        changeSummary: { fileCount: 2, added: 12, removed: 3 } as ZCodeTaskMeta["changeSummary"],
      }),
    ]);
    expect(entry).toMatchObject({ added: 12, removed: 3 });
  });
});

describe("buildTaskStackGroups", () => {
  const entry = (
    key: string,
    groupKey: string,
    status: TaskStackEntry["status"],
    updatedAt: number,
  ): TaskStackEntry => ({
    key,
    groupKey,
    taskId: key,
    workspacePath: groupKey,
    workspaceName: groupKey,
    title: key,
    status,
    updatedAt,
  });

  it("puts actionable conversations at the front of each stack", () => {
    const [group] = buildTaskStackGroups([
      entry("new", "a", "idle", 50),
      entry("err", "a", "error", 10),
      entry("run", "a", "running", 40),
      entry("ask", "a", "waiting", 20),
    ]);
    expect(group?.entries.map((item) => item.key)).toEqual(["ask", "err", "new", "run"]);
    expect(group?.actionableCount).toBe(2);
    expect(group?.counts).toMatchObject({ error: 1, waiting: 1, running: 1, idle: 1 });
  });

  it("orders projects needing action first, then by latest activity", () => {
    const groups = buildTaskStackGroups([
      entry("a1", "quiet-recent", "idle", 100),
      entry("b1", "needs-me", "waiting", 5),
      entry("c1", "quiet-old", "idle", 50),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["needs-me", "quiet-recent", "quiet-old"]);
  });
});

describe("scatterOffsets", () => {
  const anchor = (left: number, top: number, viewBottom = 900) => ({
    left,
    top,
    width: 300,
    height: 180,
    containerWidth: 1200,
    viewTop: 0,
    viewBottom,
  });

  it("puts the first card straight above when there is room", () => {
    const [first] = scatterOffsets(1, anchor(450, 500));
    expect(first?.x).toBeCloseTo(0);
    expect(first?.y).toBeLessThan(-150);
  });

  it("opens downward for a stack near the top of the view", () => {
    expect(fanOpensUp(anchor(450, 20))).toBe(false);
    const [first] = scatterOffsets(1, anchor(450, 20));
    expect(first?.y).toBeGreaterThan(150);
  });

  it("keeps every card inside the container", () => {
    const a = anchor(10, 500);
    const halfW = (300 * 0.78) / 2;
    for (const offset of scatterOffsets(6, a)) {
      const centreX = a.left + a.width / 2 + offset.x;
      expect(centreX - halfW).toBeGreaterThanOrEqual(0);
      expect(centreX + halfW).toBeLessThanOrEqual(a.containerWidth);
    }
  });
});
