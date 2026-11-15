import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardDigest } from "../../src/board/index.js";
import { MAX_DIGEST_WORDS } from "../../src/types.js";
import { lorem, openBoard, sol, words, type Board } from "./fixture.js";

let board: Board;
beforeEach(async () => {
  board = await openBoard();
});
afterEach(async () => {
  await board.close();
});

const digest = async (taskId: string, maxWords?: number) =>
  boardDigest(await board.entries(), taskId, maxWords === undefined ? {} : { maxWords });

/** A job of three steps: ui waits on api; docs waits on nothing. */
async function threeSteps() {
  await board.job("job", [
    { key: "api", title: "The API", owns: ["packages/api", "docs/api.md"] },
    { key: "ui", title: "The screen", dependsOn: ["api"], owns: ["packages/ui"] },
    { key: "docs", title: "The docs", owns: [] },
  ]);
  await board.executor("job.api", "run-api", { branch: "xatlas/job.api/claude-run-api" });
  await board.executor("job.docs", "run-docs", { choice: sol });
}

describe("boardDigest: what a step sees", () => {
  it("gives a step with no siblings, notes or plan a short, sensible digest", async () => {
    await board.job("job", [{ key: "only", title: "Do the one thing", owns: ["src/a.ts"] }]);
    const text = await digest("job.only");
    expect(text).toBe(
      [
        'Your step: job.only, "Do the one thing".',
        "You own: src/a.ts.",
        "",
        "No notes for you yet.",
        "",
        "No other steps in this job.",
      ].join("\n"),
    );
  });

  it("names what the step owns, what it builds on, and each sibling with its agent and branch", async () => {
    await threeSteps();
    const text = await digest("job.ui");
    expect(text).toContain('Your step: job.ui, "The screen".');
    expect(text).toContain("You own: packages/ui.");
    expect(text).toContain("It builds on: job.api.");
    expect(text).toContain(
      '- job.api, "The API": working; claude opus; owns packages/api, docs/api.md; branch xatlas/job.api/claude-run-api',
    );
    expect(text).toContain(
      '- job.docs, "The docs": working; codex gpt-6.1-sol; owns the whole repository',
    );
    expect(text).not.toContain('- job.ui, "The screen"');
  });

  it("says when a sibling has no executor yet", async () => {
    await board.job("job", [{ key: "api" }, { key: "ui" }]);
    expect(await digest("job.api")).toContain(
      '- job.ui, "Step ui": planned; no executor yet; owns packages/ui',
    );
  });

  it("shows the notes meant for the step, newest first, and says who wrote each", async () => {
    await threeSteps();
    await board.job("other", [{ key: "x" }]);
    await board.executor("other.x", "run-x");
    await board.note({ from: "person", text: "N1 broadcast with no job" });
    await board.note({ from: "orchestrator", text: "N2 broadcast for this job" }, "job");
    await board.note({ from: "run-api", text: "N3 broadcast from the step it builds on" });
    await board.note({ from: "run-docs", text: "N4 to it from a sibling", to: "job.ui" });
    await board.note({ from: "watcher", text: "N5 watcher to it", to: "job.ui" });
    await board.note({ from: "person", text: "N6 broadcast on its own step" }, "job.ui");
    await board.note({ from: "run-api", text: "N7 dependency to a sibling", to: "job.docs" });
    await board.note({ from: "run-docs", text: "N8 sibling broadcast" });
    await board.note({ from: "watcher", text: "N9 watcher broadcast for this job" }, "job");

    // Not for it: notes addressed to another step by a non-dependency, and other jobs' notes.
    await board.note({ from: "person", text: "X1 broadcast for another job" }, "other");
    await board.note(
      { from: "orchestrator", text: "X2 broadcast on another job's step" },
      "other.x",
    );
    await board.note({ from: "person", text: "X3 person to another step", to: "job.api" });
    await board.note({ from: "run-docs", text: "X4 sibling to another step", to: "job.api" });
    await board.note({ from: "run-x", text: "X5 another job's run broadcast" });
    await board.note({ from: "watcher", text: "X6 watcher broadcast on another job" }, "other");

    const text = await digest("job.ui");
    expect(text.match(/N\d/g)).toEqual(["N9", "N8", "N7", "N6", "N5", "N4", "N3", "N2", "N1"]);
    expect(text).not.toMatch(/X\d/);
    expect(text).toContain("- From the watcher: N9");
    expect(text).toContain("- From job.docs's executor (codex gpt-6.1-sol, run run-docs): N8");
    expect(text).toContain("- From job.api's executor (claude opus, run run-api): N7");
    expect(text).toContain("- From the person: N6");
    expect(text).toContain("- From the orchestrator: N2");
  });

  it("never shows the orchestrator's own bookkeeping notes", async () => {
    await threeSteps();
    for (const from of ["xatlas:decision", "xatlas:answer", "xatlas:plan", "xatlas:run-base"]) {
      await board.note({ from, text: `secret of ${from}` }, "job");
      await board.note({ from, text: `secret of ${from}`, to: "job.ui" }, "job");
    }
    await board.note({ from: "person", text: "Use the new endpoint" }, "job");
    const text = await digest("job.ui");
    expect(text).not.toContain("secret of");
    expect(text).not.toContain("xatlas:");
    expect(text).toContain("Use the new endpoint");
  });

  it("does not show a step what the steps building on it address to others", async () => {
    await threeSteps();
    await board.executor("job.ui", "run-ui");
    await board.note({ from: "run-ui", text: "To docs from the dependent", to: "job.docs" });
    await board.note({ from: "run-ui", text: "Broadcast from the dependent" });
    const text = await digest("job.api");
    expect(text).not.toContain("To docs from the dependent");
    expect(text).toContain("Broadcast from the dependent");
  });

  it("ends with the job's latest plan, not an older one or another job's", async () => {
    await threeSteps();
    await board.job("other", [{ key: "x" }]);
    await board.plan("job", "First plan");
    await board.plan("job", "Second plan\n\n- api first\n- then ui", "claude:fable");
    await board.plan("other", "Another job's plan");
    const text = await digest("job.ui");
    expect(
      text.endsWith(
        "The plan the parliament chose (written by claude:fable):\nSecond plan\n\n- api first\n- then ui",
      ),
    ).toBe(true);
    expect(text).not.toContain("First plan");
    expect(text).not.toContain("Another job's plan");
  });

  it("gives a task with no parent its own plan and notes", async () => {
    await board.project.createTask({ id: "solo", title: "Solo", brief: "b", route: "direct" });
    await board.plan("solo", "The solo plan");
    await board.note({ from: "person", text: "For solo" }, "solo");
    const text = await digest("solo");
    expect(text).toContain("You own: the whole repository.");
    expect(text).toContain("- From the person: For solo");
    expect(text).toContain("No other steps in this job.");
    expect(text).toContain("The solo plan");
  });

  it("throws for an unknown task and for a limit that is not a whole number above 0", async () => {
    await board.job("job", [{ key: "only" }]);
    const entries = await board.entries();
    expect(() => boardDigest(entries, "job.nope")).toThrow("No task job.nope");
    for (const maxWords of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => boardDigest(entries, "job.only", { maxWords })).toThrow("whole number");
    }
  });

  it("refuses a limit above MAX_DIGEST_WORDS and takes the constant itself", async () => {
    await board.job("job", [{ key: "only" }]);
    await board.plan("job", lorem(5000, "p"));
    const entries = await board.entries();
    for (const maxWords of [MAX_DIGEST_WORDS + 1, 3000]) {
      expect(() => boardDigest(entries, "job.only", { maxWords })).toThrow(
        `at most ${MAX_DIGEST_WORDS}`,
      );
    }
    const text = boardDigest(entries, "job.only", { maxWords: MAX_DIGEST_WORDS });
    expect(words(text)).toBeLessThanOrEqual(MAX_DIGEST_WORDS);
  });
});

describe("boardDigest: the word limit", () => {
  it("keeps everything when it fits and uses MAX_DIGEST_WORDS by default", async () => {
    await threeSteps();
    await board.plan("job", lorem(100, "p"));
    const text = await digest("job.ui");
    expect(text).toContain("p100");
    expect(text).not.toContain("cut");

    await board.plan("job", lorem(5000, "p"));
    const long = await digest("job.ui");
    expect(words(long)).toBeLessThanOrEqual(MAX_DIGEST_WORDS);
    expect(words(long)).toBeGreaterThan(MAX_DIGEST_WORDS - 20);
  });

  it("cuts a long plan first and keeps every note and sibling", async () => {
    await threeSteps();
    await board.note({ from: "person", text: lorem(30, "n") });
    await board.plan("job", lorem(800, "p"));
    const text = await digest("job.ui", 200);
    expect(words(text)).toBeLessThanOrEqual(200);
    expect(text).toContain("n30");
    expect(text).toContain("- job.api,");
    expect(text).toContain("- job.docs,");
    expect(text).toContain("p1 p2");
    expect(text).not.toContain("p800");
    expect(text).toMatch(/\[plan cut after \d+ of 800 words\]/);
  });

  it("keeps the plan's line breaks in what is left of it", async () => {
    await board.job("job", [{ key: "only" }]);
    await board.plan("job", `Line one here\n\n${lorem(300, "p")}`);
    const text = await digest("job.only", 60);
    expect(text).toContain(":\nLine one here\n\np1");
  });

  it("then cuts the oldest notes, newest kept, and marks how many went", async () => {
    await threeSteps();
    await board.plan("job", lorem(400, "p"));
    for (let index = 1; index <= 40; index += 1) {
      await board.note({ from: "person", text: `note-${index} ${lorem(10)}`, to: "job.ui" });
    }
    const text = await digest("job.ui", 300);
    expect(words(text)).toBeLessThanOrEqual(300);
    expect(text).toContain("[The parliament's plan (400 words) was cut.]");
    expect(text).toContain("note-40 ");
    expect(text).not.toContain("note-1 ");
    const kept = text.match(/note-\d+/g) ?? [];
    expect(text).toContain(`[${40 - kept.length} older notes cut]`);
    expect(kept[0]).toBe("note-40");
    expect(text).toContain("- job.api,");
    expect(text).toContain("- job.docs,");
  });

  it("gives the plan back the room that dropping old notes freed", async () => {
    await board.job("job", [{ key: "only" }]);
    await board.note({ from: "person", text: lorem(300, "old") });
    await board.note({ from: "person", text: "the newest note" });
    await board.plan("job", lorem(1000, "p"));
    const text = await digest("job.only", 200);
    expect(words(text)).toBeLessThanOrEqual(200);
    expect(words(text)).toBeGreaterThanOrEqual(195);
    expect(text).toContain("the newest note");
    expect(text).toContain("[1 older note cut]");
    expect(text).toMatch(/\[plan cut after \d+ of 1000 words\]/);
  });

  it("shows no stub of a plan when only a few of its words would fit", async () => {
    await board.job("job", [{ key: "only" }]);
    await board.plan("job", lorem(500, "p"));
    // The full digest less the plan's 500 words is the rest plus the plan's 5-word heading.
    const rest = words(await digest("job.only", 1000)) - 500 - 5;
    // Heading (5) and marker (7) would leave 16 words of plan, under the floor of 20.
    const text = await digest("job.only", rest + 5 + 7 + 16);
    expect(text).toContain("[The parliament's plan (500 words) was cut.]");
    expect(text).not.toContain("p1");
  });

  it("cuts the text of one huge note but keeps it, and keeps the siblings", async () => {
    await threeSteps();
    await board.note({ from: "person", text: "an older note" });
    await board.note({ from: "person", text: lorem(3000, "h"), to: "job.ui" });
    const text = await digest("job.ui", 250);
    expect(words(text)).toBeLessThanOrEqual(250);
    expect(text).toContain("- From the person: h1 h2");
    expect(text).toContain("[note cut]");
    expect(text).toContain("[1 older note cut]");
    expect(text).toContain("- job.api,");
    expect(text).toContain("- job.docs,");
  });

  it("drops sibling lines last among the parts, after the newest note is down to its floor", async () => {
    const steps = Array.from({ length: 60 }, (_, index) => ({ key: `s${index + 1}` }));
    await board.job("job", [{ key: "me" }, ...steps]);
    await board.note({ from: "person", text: lorem(500, "h"), to: "job.me" });
    await board.plan("job", lorem(500, "p"));
    const text = await digest("job.me", 200);
    expect(words(text)).toBeLessThanOrEqual(200);
    expect(text).toContain('Your step: job.me, "Step me".');
    expect(text).toContain("h40 [note cut]");
    expect(text).toContain("- job.s1,");
    expect(text).not.toContain("- job.s60,");
    expect(text).toMatch(/\[\d+ more steps cut\]/);
    expect(text).toContain("[The parliament's plan (500 words) was cut.]");
  });

  it("clamps a header that is too long on its own and keeps its start", async () => {
    await board.job("job", [
      { key: "big", title: lorem(300, "t"), owns: [lorem(300, "o").replaceAll(" ", "/")] },
      { key: "other" },
    ]);
    await board.note({ from: "person", text: "hello" });
    const text = await digest("job.big", 100);
    expect(words(text)).toBe(100);
    expect(text.startsWith('Your step: job.big, "t1 t2')).toBe(true);
    expect(text.endsWith("[cut]")).toBe(true);
  });

  it("never goes over the limit, whatever overflows and however small the limit", async () => {
    const steps = Array.from({ length: 30 }, (_, index) => ({
      key: `s${index + 1}`,
      title: lorem(8, "t"),
      owns: [`packages/s${index + 1}`, "docs"],
    }));
    await board.job("job", [{ key: "me", dependsOn: ["s1", "s2"] }, ...steps]);
    await board.executor("job.s1", "run-s1", { branch: "xatlas/job.s1/claude-run-s1" });
    await board.plan("job", lorem(2000, "p"), "claude:fable");
    for (let index = 0; index < 25; index += 1) {
      await board.note({ from: "run-s1", text: lorem(60, `n${index}-`) });
    }
    await board.note({ from: "person", text: lorem(900, "h"), to: "job.me" });
    const entries = await board.entries();
    for (const limit of [1, 2, 3, 5, 8, 13, 21, 40, 75, 120, 250, 600, 1000, 1500]) {
      const text = boardDigest(entries, "job.me", { maxWords: limit });
      expect(words(text), `limit ${limit}`).toBeLessThanOrEqual(limit);
      expect(text.startsWith("Your"), `limit ${limit}`).toBe(true);
    }
    expect(boardDigest(entries, "job.me", { maxWords: 1 })).toBe("Your");
    expect(boardDigest(entries, "job.me", { maxWords: 5 })).toBe('Your step: job.me, "Step [cut]');
  });
});
