import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LedgerConflictError,
  LedgerCorruptError,
  LedgerLockTimeoutError,
  ledgerPath,
  openLedger,
  type Ledger,
} from "../../src/tasks/index.js";
import { deadPid, plantLock } from "./fixtures/locks.js";

const projectKey = "/work/xatlas";

let dataDir: string;
let ledger: Ledger;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "xatlas-ledger-"));
  let tick = 0;
  let id = 0;
  ledger = openLedger({
    dataDir,
    now: () => new Date(Date.UTC(2026, 10, 15, 9, 0, tick++)),
    newId: () => `id-${++id}`,
  });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const file = () => ledgerPath(dataDir, projectKey);
const note = (text: string, id?: string) =>
  ({ kind: "note", data: { from: "person", text }, ...(id ? { id } : {}) }) as const;

describe("ledger file", () => {
  it("keeps one file per project inside the data folder, named by a hash of the key", () => {
    const one = ledgerPath(dataDir, "/work/xatlas");
    const other = ledgerPath(dataDir, "/work/other");
    expect(one.startsWith(dataDir)).toBe(true);
    expect(one).not.toBe(other);
    expect(one).not.toContain("xatlas/");
    expect(one).toMatch(/[0-9a-f]{64}\.jsonl$/);
  });

  it("reads an empty ledger when the project has no file yet", async () => {
    expect(await ledger.read(projectKey)).toEqual([]);
  });

  it("numbers entries 1, 2, 3 and stamps time, project and id", async () => {
    const first = await ledger.append(projectKey, note("one"));
    const second = await ledger.append(projectKey, note("two"));

    expect(first).toEqual({
      kind: "note",
      data: { from: "person", text: "one" },
      id: "id-1",
      seq: 1,
      at: "2026-11-15T09:00:00.000Z",
      projectKey,
    });
    expect(second.seq).toBe(2);
    expect(await ledger.read(projectKey)).toEqual([first, second]);
    const text = await readFile(file(), "utf8");
    expect(text.split("\n")).toHaveLength(3);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("treats a repeated id as a no-op that returns the entry already there", async () => {
    const first = await ledger.append(projectKey, note("first", "same"));
    const before = await readFile(file());

    const again = await ledger.append(projectKey, note("different text", "same"));

    expect(again).toEqual(first);
    expect(await readFile(file())).toEqual(before);
  });

  it("refuses a write when expectedSeq is not the last seq, and writes nothing", async () => {
    await ledger.append(projectKey, note("one"), { expectedSeq: 0 });
    const before = await readFile(file());

    const stale = ledger.append(projectKey, note("two"), { expectedSeq: 0 });

    await expect(stale).rejects.toBeInstanceOf(LedgerConflictError);
    await expect(stale).rejects.toMatchObject({ code: "conflict", expectedSeq: 0, actualSeq: 1 });
    expect(await readFile(file())).toEqual(before);
    expect((await ledger.append(projectKey, note("two"), { expectedSeq: 1 })).seq).toBe(2);
  });

  it("checks a repeated id before expectedSeq, so a retried write still returns its entry", async () => {
    const first = await ledger.append(projectKey, note("one", "retry-me"), { expectedSeq: 0 });
    await ledger.append(projectKey, note("two"));

    expect(await ledger.append(projectKey, note("one", "retry-me"), { expectedSeq: 0 })).toEqual(
      first,
    );
  });
});

describe("cut-off and bad lines", () => {
  it("ignores a last line cut off mid-write", async () => {
    await ledger.append(projectKey, note("one"));
    await ledger.append(projectKey, note("two"));
    await appendFile(file(), '{"id":"id-3","seq":3,"at":"2026-11-15T09:');

    const entries = await ledger.read(projectKey);

    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("ignores a last line with all its text but no newline, as the write never finished", async () => {
    const first = await ledger.append(projectKey, note("one"));
    await appendFile(file(), JSON.stringify({ ...first, id: "x", seq: 2 }));

    expect(await ledger.read(projectKey)).toEqual([first]);
  });

  it("cuts away a cut-off last line on the next append, so the new line reads cleanly", async () => {
    await ledger.append(projectKey, note("one"));
    await appendFile(file(), '{"id":"lost","seq":2,"kind":"no');

    const next = await ledger.append(projectKey, note("two"));

    expect(next.seq).toBe(2);
    const lines = (await readFile(file(), "utf8")).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2).map((line) => JSON.parse(line).seq)).toEqual([1, 2]);
    expect((await openLedger({ dataDir }).read(projectKey)).map((entry) => entry.seq)).toEqual([
      1, 2,
    ]);
  });

  it("fails on a bad line in the middle, naming the line", async () => {
    await ledger.append(projectKey, note("one"));
    await appendFile(file(), "this is not json\n");
    await appendFile(
      file(),
      `${JSON.stringify({ ...note("x"), id: "z", seq: 3, at: "t", projectKey })}\n`,
    );

    const read = ledger.read(projectKey);

    await expect(read).rejects.toBeInstanceOf(LedgerCorruptError);
    await expect(read).rejects.toMatchObject({ code: "corrupt", line: 2 });
    await expect(read).rejects.toThrow(/:2: not JSON/);
    // Writing is refused too; nothing is skipped silently.
    await expect(ledger.append(projectKey, note("two"))).rejects.toMatchObject({ line: 2 });
  });

  it("fails on a finished last line that can't be read", async () => {
    await ledger.append(projectKey, note("one"));
    await appendFile(file(), "{broken}\n");

    await expect(ledger.read(projectKey)).rejects.toMatchObject({ code: "corrupt", line: 2 });
  });

  it("fails on a gap in seq, a repeated id, an unknown kind and another project's entry", async () => {
    const first = await ledger.append(projectKey, note("one"));
    const cases = [
      { ...first, id: "b", seq: 3 },
      { ...first, seq: 2 },
      { ...first, id: "b", seq: 2, kind: "task.exploded" },
      { ...first, id: "b", seq: 2, projectKey: "/elsewhere" },
    ];
    const good = await readFile(file(), "utf8");
    for (const bad of cases) {
      await writeFile(file(), `${good}${JSON.stringify(bad)}\n`);
      await expect(ledger.read(projectKey)).rejects.toMatchObject({ code: "corrupt", line: 2 });
    }
  });
});

describe("ledger lock", () => {
  const lockDir = () => `${file()}.lock`;

  it("takes over a lock whose owner process is gone", async () => {
    await plantLock(lockDir(), deadPid());

    const entry = await ledger.append(projectKey, note("after a crash"));

    expect(entry.seq).toBe(1);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("waits for a lock whose owner is alive, and writes once it is released", async () => {
    await plantLock(lockDir(), process.pid);
    let finished = false;
    const pending = ledger.append(projectKey, note("waited")).then((entry) => {
      finished = true;
      return entry;
    });

    await new Promise((settle) => setTimeout(settle, 250));
    expect(finished).toBe(false);
    expect(existsSync(file())).toBe(false);

    await rm(lockDir(), { recursive: true });
    expect((await pending).seq).toBe(1);
  });

  it("never breaks a live owner's lock because of its age, and gives up waiting instead", async () => {
    const owner = await plantLock(lockDir(), process.pid);
    const body = await readFile(owner, "utf8");
    const impatient = openLedger({ dataDir, lockTimeoutMs: 150 });

    const write = impatient.append(projectKey, note("too late"));

    await expect(write).rejects.toBeInstanceOf(LedgerLockTimeoutError);
    await expect(write).rejects.toMatchObject({ code: "lock-timeout", ownerPid: process.pid });
    expect(await readFile(owner, "utf8")).toBe(body);
    expect(existsSync(file())).toBe(false);
    // The writer that gave up leaves nothing of its own behind.
    expect(await readdir(dirname(file()))).toEqual([basename(lockDir())]);
  });

  it("says in the timeout which pid holds the lock, since when, and what to remove", async () => {
    await plantLock(lockDir(), process.pid, "reused", "2026-11-15T08:30:00.000Z");
    const impatient = openLedger({ dataDir, lockTimeoutMs: 50 });

    const error = await impatient
      .append(projectKey, note("too late"))
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({
      code: "lock-timeout",
      ownerPid: process.pid,
      since: "2026-11-15T08:30:00.000Z",
      lockPath: lockDir(),
    });
    const message = (error as Error).message;
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain("since 2026-11-15T08:30:00.000Z");
    expect(message).toContain(`remove ${lockDir()}`);
  });

  it("releases the lock after a refused write", async () => {
    await ledger.append(projectKey, note("one"));
    await expect(ledger.append(projectKey, note("two"), { expectedSeq: 7 })).rejects.toThrow();

    expect(existsSync(lockDir())).toBe(false);
    expect((await ledger.append(projectKey, note("two"))).seq).toBe(2);
  });
});
