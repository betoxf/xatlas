import { describe, expect, it } from "vitest";
import {
  EMPTY_REVIEW_LINES,
  outsideOwns,
  reminderFor,
  turnEndFlags,
} from "../../src/oversight/index.js";

const executor = (overrides: Partial<Parameters<typeof turnEndFlags>[0] & { role: "executor" }>) =>
  ({
    role: "executor",
    owns: ["packages/orchestrator/src/oversight", "packages/orchestrator/test/oversight"],
    changedPaths: ["packages/orchestrator/src/oversight/index.ts"],
    newCommits: 1,
    uncommittedPaths: [],
    commitsMissingTrailers: 0,
    ...overrides,
  }) as const;

describe("turnEndFlags for an executor", () => {
  it("records nothing for a clean turn inside what the step owns", () => {
    expect(turnEndFlags(executor({}))).toEqual([]);
  });

  it("pauses a run that changed paths outside what its step owns, and lists them", () => {
    const flags = turnEndFlags(
      executor({
        changedPaths: [
          "packages/orchestrator/src/oversight/chair.ts",
          "packages/orchestrator/src/types.ts",
          "packages/orchestrator/src/oversight2/x.ts",
        ],
      }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      check: "outside-owns",
      action: "paused",
      paths: ["packages/orchestrator/src/types.ts", "packages/orchestrator/src/oversight2/x.ts"],
    });
    expect(flags[0]!.detail).toContain("2 paths outside");
    expect(flags[0]!.detail).toContain("packages/orchestrator/src/types.ts");
  });

  it("counts uncommitted changes outside the step too", () => {
    const flags = turnEndFlags(executor({ uncommittedPaths: ["README.md"] }));
    expect(flags.map((flag) => flag.check)).toEqual(["outside-owns"]);
    expect(flags[0]!.paths).toEqual(["README.md"]);
  });

  it("treats an empty owns as the whole repository", () => {
    expect(turnEndFlags(executor({ owns: [], changedPaths: ["anything/at/all.ts"] }))).toEqual([]);
  });

  it("tests a path one way, ignoring case and spelling", () => {
    const owns = ["src/ui", "docs/DESIGN.md"];
    expect(outsideOwns(owns, ["./src/ui/Button.tsx", "SRC/UI/x.css", "docs/design.md"])).toEqual(
      [],
    );
    expect(
      outsideOwns(owns, ["src/ui2/a.ts", "src", "../outside.ts", "docs/DESIGN.md.bak"]),
    ).toEqual(["src/ui2/a.ts", "src", "../outside.ts", "docs/DESIGN.md.bak"]);
    expect(outsideOwns(owns, ["a.ts", "a.ts", " "])).toEqual(["a.ts"]);
  });

  it("names at most five paths in the detail and keeps them all in paths", () => {
    const changed = Array.from({ length: 7 }, (_, index) => `other/${index}.ts`);
    const [flag] = turnEndFlags(executor({ changedPaths: changed }));
    expect(flag!.paths).toHaveLength(7);
    expect(flag!.detail).toContain("other/4.ts and 2 more");
  });

  it("flags a turn with no new commit", () => {
    expect(turnEndFlags(executor({ newCommits: 0 }))).toEqual([
      { check: "no-commit", action: "flagged", detail: "The turn ended with nothing committed." },
    ]);
    const [flag] = turnEndFlags(
      executor({
        newCommits: 0,
        uncommittedPaths: ["packages/orchestrator/src/oversight/a.ts"],
      }),
    );
    expect(flag!.detail).toContain("1 path is changed but not committed");
  });

  it("records both flags when both happen, outside-owns first", () => {
    const flags = turnEndFlags(executor({ newCommits: 0, uncommittedPaths: ["package.json"] }));
    expect(flags.map((flag) => [flag.check, flag.action])).toEqual([
      ["outside-owns", "paused"],
      ["no-commit", "flagged"],
    ]);
  });

  it("does not flag missing trailers on their own", () => {
    expect(turnEndFlags(executor({ commitsMissingTrailers: 3 }))).toEqual([]);
  });
});

describe("turnEndFlags for a reviewer", () => {
  it("flags a pass of more than 400 changed lines with no finding", () => {
    expect(EMPTY_REVIEW_LINES).toBe(400);
    expect(
      turnEndFlags({ role: "reviewer", verdict: "pass", findings: 0, changedLines: 401 }),
    ).toEqual([
      {
        check: "empty-review",
        action: "flagged",
        detail: "The reviewer passed 401 changed lines with no finding at all.",
      },
    ]);
  });

  it("leaves 400 lines, a pass with findings, and a findings verdict alone", () => {
    expect(
      turnEndFlags({ role: "reviewer", verdict: "pass", findings: 0, changedLines: 400 }),
    ).toEqual([]);
    expect(
      turnEndFlags({ role: "reviewer", verdict: "pass", findings: 1, changedLines: 5000 }),
    ).toEqual([]);
    expect(
      turnEndFlags({ role: "reviewer", verdict: "findings", findings: 0, changedLines: 5000 }),
    ).toEqual([]);
  });
});

describe("reminderFor", () => {
  const trailers = ["Run-Id: run-1", "Task-Id: job.step"];

  it("has nothing to say when the turn committed with trailers", () => {
    expect(reminderFor({ newCommits: 2, commitsMissingTrailers: 0, trailers })).toBeUndefined();
  });

  it("reminds an executor that committed nothing", () => {
    const text = reminderFor({
      newCommits: 0,
      commitsMissingTrailers: 0,
      uncommittedPaths: ["a"],
    })!;
    expect(text).toContain("nothing committed");
    expect(text).toContain("1 path is changed but not committed");
    expect(text).toContain("the run's trailers");
  });

  it("reminds about missing trailers and lists the lines", () => {
    const one = reminderFor({ newCommits: 1, commitsMissingTrailers: 1, trailers })!;
    expect(one).toContain("One of your commits does not end with the run's trailers");
    expect(one).toContain("Run-Id: run-1\nTask-Id: job.step");
    expect(one).not.toContain("nothing committed");
    const three = reminderFor({ newCommits: 3, commitsMissingTrailers: 3 })!;
    expect(three).toContain("3 of your commits do not");
  });

  it("words both in one reminder", () => {
    const text = reminderFor({ newCommits: 0, commitsMissingTrailers: 2, trailers })!;
    expect(text).toContain("nothing committed");
    expect(text).toContain("2 of your commits");
    expect(text.match(/Run-Id/g)).toHaveLength(1);
  });
});
