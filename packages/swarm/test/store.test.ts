import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRuns,
  loadRun,
  SAVED_SWARM_RUN_VERSION,
  saveRun,
  type SwarmResult,
  type SwarmRunToSave,
} from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xatlas-swarm-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const result: SwarmResult = {
  task: "Add dark mode",
  plans: [
    { letter: "A", memberId: "claude:fable", plan: "Plan A" },
    { letter: "B", memberId: "codex:gpt-6-astra", plan: "Plan B" },
  ],
  debate: [],
  ballots: [
    { voterId: "claude:fable", ranking: ["B"], reasons: { B: "clear" } },
    { voterId: "codex:gpt-6-astra", ranking: ["A"], reasons: {}, weight: 2 },
  ],
  scores: [
    { letter: "A", memberId: "claude:fable", points: 2, firstPlaces: 1, weightedFirstPlaces: 2 },
    {
      letter: "B",
      memberId: "codex:gpt-6-astra",
      points: 1,
      firstPlaces: 1,
      weightedFirstPlaces: 1,
    },
  ],
  winner: {
    letter: "A",
    memberId: "claude:fable",
    points: 2,
    firstPlaces: 1,
    weightedFirstPlaces: 2,
  },
  dropped: [],
  members: [
    { id: "claude:fable", agent: "claude", model: "fable" },
    {
      id: "codex:gpt-6-astra",
      agent: "codex",
      model: "gpt-6-astra",
      weight: 2,
      effort: "xhigh",
      fast: true,
    },
  ],
  unsupported: [],
};

function run(id: string, savedAt: string, extra: Partial<SwarmRunToSave> = {}): SwarmRunToSave {
  return {
    id,
    savedAt,
    status: "done",
    task: result.task,
    members: result.members!,
    rounds: 1,
    events: [
      { type: "phase", phase: "propose", round: 0 },
      { type: "unsupported", memberId: "gemini", option: "effort", detail: "none" },
    ],
    result,
    ...extra,
  };
}

describe("saved swarm runs", () => {
  it("round-trips a run with its version", async () => {
    const saved = run("2026-11-15-a", "2026-11-15T10:00:00.000Z");
    const file = await saveRun(dir, saved);
    expect(file).toBe(join(dir, "2026-11-15-a.json"));
    expect(await loadRun(dir, "2026-11-15-a")).toEqual({
      version: SAVED_SWARM_RUN_VERSION,
      ...saved,
    });
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(SAVED_SWARM_RUN_VERSION);
    // Nothing but the run is left in the folder.
    expect(await readdir(dir)).toEqual(["2026-11-15-a.json"]);
  });

  it("saves a failed run without a result, and replaces an earlier save of the same id", async () => {
    await saveRun(dir, run("r1", "2026-11-15T10:00:00.000Z"));
    const { result: _result, ...failed } = run("r1", "2026-11-15T10:05:00.000Z", {
      status: "failed",
      error: "only one left",
    });
    await saveRun(dir, failed);
    const loaded = await loadRun(dir, "r1");
    expect(loaded).toMatchObject({
      status: "failed",
      error: "only one left",
      savedAt: "2026-11-15T10:05:00.000Z",
    });
    expect(loaded?.result).toBeUndefined();
  });

  it("lists runs newest first, with their winners", async () => {
    await saveRun(dir, run("old", "2026-11-14T09:00:00.000Z"));
    await saveRun(
      dir,
      run("new", "2026-11-15T09:00:00.000Z", { status: "cancelled", result: undefined }),
    );
    const listing = await listRuns(dir);
    expect(listing.unreadable).toEqual([]);
    expect(listing.runs).toEqual([
      {
        id: "new",
        savedAt: "2026-11-15T09:00:00.000Z",
        status: "cancelled",
        task: "Add dark mode",
        memberIds: ["claude:fable", "codex:gpt-6-astra"],
      },
      {
        id: "old",
        savedAt: "2026-11-14T09:00:00.000Z",
        status: "done",
        task: "Add dark mode",
        memberIds: ["claude:fable", "codex:gpt-6-astra"],
        winner: { letter: "A", memberId: "claude:fable" },
      },
    ]);
  });

  it("gives nothing for a missing run or folder", async () => {
    expect(await loadRun(dir, "nope")).toBeUndefined();
    expect(await listRuns(join(dir, "missing"))).toEqual({ runs: [], unreadable: [] });
  });

  it("refuses a file from a newer version, and lists it as unreadable", async () => {
    await saveRun(dir, run("ok", "2026-11-15T09:00:00.000Z"));
    await writeFile(
      join(dir, "future.json"),
      JSON.stringify({
        ...run("future", "2026-11-15T10:00:00.000Z"),
        version: SAVED_SWARM_RUN_VERSION + 1,
      }),
    );
    await expect(loadRun(dir, "future")).rejects.toThrow(/newer xatlas \(version 2/);
    const listing = await listRuns(dir);
    expect(listing.runs.map((entry) => entry.id)).toEqual(["ok"]);
    expect(listing.unreadable).toEqual([
      { file: join(dir, "future.json"), reason: expect.stringMatching(/newer/) },
    ]);
  });

  it("reports a half-written file and ignores a save's leftover temporary file", async () => {
    await saveRun(dir, run("ok", "2026-11-15T09:00:00.000Z"));
    const whole = JSON.stringify({ version: 1, ...run("cut", "2026-11-15T10:00:00.000Z") });
    await writeFile(join(dir, "cut.json"), whole.slice(0, whole.length / 2));
    await writeFile(join(dir, ".crashed.1a2b3c.tmp"), whole.slice(0, 10));
    await expect(loadRun(dir, "cut")).rejects.toThrow(/not complete JSON/);
    const listing = await listRuns(dir);
    expect(listing.runs.map((entry) => entry.id)).toEqual(["ok"]);
    expect(listing.unreadable).toEqual([
      { file: join(dir, "cut.json"), reason: expect.stringMatching(/not complete JSON/) },
    ]);
  });

  it("refuses ids that aren't safe file names", async () => {
    for (const id of ["", "../escape", ".hidden", "a/b", "a b"]) {
      await expect(saveRun(dir, run(id, "2026-11-15T09:00:00.000Z"))).rejects.toThrow(
        /can't name a saved swarm run/,
      );
      await expect(loadRun(dir, id)).rejects.toThrow(/can't name a saved swarm run/);
    }
    expect(await readdir(dir)).toEqual([]);
  });
});
