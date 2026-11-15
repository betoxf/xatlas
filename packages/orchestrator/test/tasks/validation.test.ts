import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerDraft } from "../../src/types.js";
import {
  LedgerCorruptError,
  LedgerRuleError,
  ledgerPath,
  openLedger,
  type Ledger,
} from "../../src/tasks/index.js";

const projectKey = "/work/xatlas";
const opus = { agent: "claude", model: "opus", effort: "high" } as const;

let dataDir: string;
let ledger: Ledger;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "xatlas-ledger-validation-"));
  ledger = openLedger({ dataDir });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const file = () => ledgerPath(dataDir, projectKey);
const note = { kind: "note", data: { from: "person", text: "hi" } } as const;

/** A draft the types would refuse, as a caller in plain JavaScript or a bad cast could send. */
const loose = (draft: Record<string, unknown>) => draft as unknown as LedgerDraft;

async function expectInvalid(write: () => Promise<unknown>) {
  const before = existsSync(file()) ? await readFile(file()) : undefined;
  const error = await write().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(LedgerRuleError);
  expect(error).toMatchObject({ code: "invalid-entry" });
  expect(existsSync(file()) ? await readFile(file()) : undefined).toEqual(before);
}

describe("entry ids and project keys", () => {
  it("refuses an empty id, an id with a line break and an absurdly long id, and writes nothing", async () => {
    await ledger.append(projectKey, note);
    for (const id of ["", "two\nlines", "carriage\rreturn", "x".repeat(257)]) {
      await expectInvalid(() => ledger.append(projectKey, { ...note, id }));
    }
    expect((await ledger.read(projectKey)).map((entry) => entry.seq)).toEqual([1]);
  });

  it("refuses an id the id maker gets wrong", async () => {
    const broken = openLedger({ dataDir, newId: () => "" });
    await expectInvalid(() => broken.append(projectKey, note));
  });

  it("refuses an empty or non-text project key", async () => {
    await expectInvalid(() => ledger.append("", note));
    await expectInvalid(() => ledger.append(undefined as unknown as string, note));
    await expect(ledger.read("")).rejects.toMatchObject({ code: "invalid-entry" });
  });

  it("refuses an empty task or run id", async () => {
    await expectInvalid(() =>
      ledger.append(projectKey, {
        kind: "task.created",
        taskId: "",
        data: { title: "t", brief: "b", route: "direct" },
      }),
    );
  });
});

describe("payloads", () => {
  const malformed: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["a task with no title, brief or route", { kind: "task.created", taskId: "t", data: {} }],
    [
      "a task with no taskId",
      { kind: "task.created", data: { title: "t", brief: "b", route: "direct" } },
    ],
    [
      "a task whose dependsOn is not a list of text",
      {
        kind: "task.created",
        taskId: "t",
        data: { title: "t", brief: "b", route: "direct", dependsOn: "a" },
      },
    ],
    [
      "a task whose owns holds a number",
      {
        kind: "task.created",
        taskId: "t",
        data: { title: "t", brief: "b", route: "direct", owns: [1] },
      },
    ],
    [
      "a route that doesn't exist",
      { kind: "task.created", taskId: "t", data: { title: "t", brief: "b", route: "chat" } },
    ],
    [
      "a move to an unknown state",
      { kind: "task.moved", taskId: "t", data: { from: "idea", to: "flying" } },
    ],
    [
      "a reroute with no reason",
      { kind: "task.rerouted", taskId: "t", data: { from: "direct", to: "orchestrated" } },
    ],
    [
      "a run with no runId",
      { kind: "run.started", taskId: "t", data: { role: "executor", choice: opus } },
    ],
    [
      "a run for an unknown agent",
      {
        kind: "run.started",
        taskId: "t",
        runId: "r",
        data: { role: "executor", choice: { agent: "skynet" } },
      },
    ],
    [
      "a run with an unknown effort",
      {
        kind: "run.started",
        taskId: "t",
        runId: "r",
        data: { role: "executor", choice: { agent: "claude", effort: "huge" } },
      },
    ],
    [
      "a run with an unknown role",
      { kind: "run.started", taskId: "t", runId: "r", data: { role: "boss", choice: opus } },
    ],
    [
      "a run update to an unknown state",
      { kind: "run.updated", taskId: "t", runId: "r", data: { state: "napping" } },
    ],
    ["a triage with no decision", { kind: "triage.decided", data: { preference: "auto" } }],
    [
      "a parliament seat with a weight in words",
      {
        kind: "parliament.decided",
        taskId: "t",
        data: { seats: [{ agent: "claude", weight: "heavy" }], plan: "p" },
      },
    ],
    [
      "a division step with a number for a key",
      { kind: "plan.divided", taskId: "t", data: { steps: [{ key: 1 }] } },
    ],
    ["a note whose text is a number", { kind: "note", data: { from: "person", text: 3 } }],
    ["an entry whose data is a list", { kind: "note", data: [] }],
  ];

  it.each(malformed)("fails to read a finished line with %s, naming the line", async (_, draft) => {
    await ledger.append(projectKey, note);
    const line = { id: "bad", seq: 2, at: "2026-11-15T09:00:00.000Z", projectKey, ...draft };
    await appendFile(file(), `${JSON.stringify(line)}\n`);

    const read = ledger.read(projectKey);

    await expect(read).rejects.toBeInstanceOf(LedgerCorruptError);
    await expect(read).rejects.toMatchObject({ code: "corrupt", line: 2 });
  });

  it.each(malformed)(
    "refuses to write %s, so nothing is written that wouldn't read back",
    async (_, draft) => {
      await ledger.append(projectKey, note);
      await expectInvalid(() => ledger.append(projectKey, loose(draft)));
    },
  );

  it("still reads and writes every well-formed kind", async () => {
    const drafts: LedgerDraft[] = [
      {
        kind: "task.created",
        taskId: "t",
        data: {
          title: "t",
          brief: "b",
          route: "direct",
          parentId: undefined,
          dependsOn: [],
          owns: ["a"],
        },
      },
      { kind: "task.moved", taskId: "t", data: { from: "idea", to: "planned", reason: "ready" } },
      {
        kind: "task.rerouted",
        taskId: "t",
        data: { from: "direct", to: "orchestrated", reason: "big" },
      },
      {
        kind: "run.started",
        taskId: "t",
        runId: "r",
        data: { role: "executor", choice: opus, account: "Max" },
      },
      { kind: "run.updated", taskId: "t", runId: "r", data: { state: "working", branch: "b" } },
      {
        kind: "triage.decided",
        data: {
          decision: { route: "chat", reason: "a question", confident: true },
          preference: "auto",
        },
      },
      {
        kind: "parliament.decided",
        taskId: "t",
        data: {
          seats: [{ agent: "codex", model: "gpt-6-astra", weight: 2, votesOnly: true, fast: true }],
          plan: "p",
          winner: "codex:gpt-6-astra",
        },
      },
      {
        kind: "plan.divided",
        taskId: "t",
        data: { steps: [{ key: "api", title: "API", brief: "b", dependsOn: [], owns: ["api"] }] },
      },
      { kind: "note", runId: "r", data: { from: "r", text: "done" } },
    ];
    for (const draft of drafts) await ledger.append(projectKey, draft);

    expect((await openLedger({ dataDir }).read(projectKey)).map((entry) => entry.kind)).toEqual(
      drafts.map((draft) => draft.kind),
    );
  });
});
