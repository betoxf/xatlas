import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerLockTimeoutError } from "../../src/tasks/index.js";
import { acquireLock, realLockFs, type HeldLock, type LockFs } from "../../src/tasks/lock.js";
import { deadPid, plantLock } from "./fixtures/locks.js";

let folder: string;
let lockDir: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "xatlas-lock-"));
  lockDir = join(folder, "project.jsonl.lock");
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/**
 * File operations that stop once, just before the first step `stopAt` picks, until `go` is
 * called. That is how two writers are interleaved by hand at the exact point of a race.
 */
function pausingFs(stopAt: (step: "unlink" | "rmdir", path: string) => boolean) {
  let go!: () => void;
  const gate = new Promise<void>((resolve) => (go = resolve));
  let stopped!: () => void;
  const reached = new Promise<void>((resolve) => (stopped = resolve));
  let used = false;
  const pause = async (step: "unlink" | "rmdir", path: string) => {
    if (used || !stopAt(step, path)) return;
    used = true;
    stopped();
    await gate;
  };
  const fs: LockFs = {
    ...realLockFs,
    unlink: async (path) => {
      await pause("unlink", path);
      return realLockFs.unlink(path);
    },
    rmdir: async (path) => {
      await pause("rmdir", path);
      return realLockFs.rmdir(path);
    },
  };
  return { fs, reached, go };
}

const holderOf = (lock: HeldLock) => [`${lock.token}.json`];
const settleFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ledger lock folder", () => {
  it("is a folder holding one owner file while held, and is gone once released", async () => {
    const lock = await acquireLock(lockDir, 1_000);

    expect(await readdir(lockDir)).toEqual(holderOf(lock));
    const owner = JSON.parse(await readFile(join(lockDir, `${lock.token}.json`), "utf8"));
    expect(owner).toMatchObject({ pid: process.pid, token: lock.token });
    expect(Number.isNaN(Date.parse(owner.since))).toBe(false);

    await lock.release();
    expect(await readdir(folder)).toEqual([]);
  });

  it("can't let a waiter that saw a dead owner remove the lock a new writer took meanwhile", async () => {
    await plantLock(lockDir, deadPid(), "dead");
    // The stale waiter judges the owner dead, then stops just before removing its file.
    const stale = pausingFs((step, path) => step === "unlink" && path.endsWith("dead.json"));
    const staleWriter = acquireLock(lockDir, 5_000, stale.fs);
    await stale.reached;

    // Meanwhile another writer takes the dead owner's lock over and moves in.
    const fresh = await acquireLock(lockDir, 5_000);
    expect(await readdir(lockDir)).toEqual(holderOf(fresh));

    // The stale waiter carries on with what it believed: the fresh lock must survive it.
    stale.go();
    await settleFor(100);
    expect(await readdir(lockDir)).toEqual(holderOf(fresh));

    await fresh.release();
    const later = await staleWriter;
    expect(await readdir(lockDir)).toEqual(holderOf(later));
    await later.release();
  });

  it("can't let a waiter stopped between a dead owner's file and its folder remove a fresh lock", async () => {
    await plantLock(lockDir, deadPid(), "dead");
    // This waiter removes the dead owner's file, then stops before removing the (empty) folder.
    const stale = pausingFs((step, path) => step === "rmdir" && path === lockDir);
    const staleWriter = acquireLock(lockDir, 5_000, stale.fs);
    await stale.reached;
    expect(await readdir(lockDir)).toEqual([]);

    const fresh = await acquireLock(lockDir, 5_000);
    stale.go();
    await settleFor(100);
    expect(await readdir(lockDir)).toEqual(holderOf(fresh));

    await fresh.release();
    await (await staleWriter).release();
  });

  it("can't let an owner stopped between releasing its file and its folder remove the next lock", async () => {
    const slow = pausingFs((step, path) => step === "rmdir" && path === lockDir);
    const first = await acquireLock(lockDir, 5_000, slow.fs);
    const releasing = first.release();
    await slow.reached;

    const next = await acquireLock(lockDir, 5_000);
    slow.go();
    await releasing;
    expect(await readdir(lockDir)).toEqual(holderOf(next));
    await next.release();
  });

  it("takes over an empty lock folder left by a crash between removing the file and the folder", async () => {
    await mkdir(lockDir);

    const lock = await acquireLock(lockDir, 1_000);

    expect(await readdir(lockDir)).toEqual(holderOf(lock));
    await lock.release();
  });

  it("waits on a lock folder holding anything but one owner record, and never removes it", async () => {
    const cases: Record<string, string>[] = [
      { "junk.json": "not json" },
      { "notes.txt": "hello" },
      // An owner record whose token doesn't match its file name can't be judged.
      { "a.json": JSON.stringify({ pid: deadPid(), token: "b" }) },
      { "a.json": JSON.stringify({ pid: deadPid(), token: "a" }), "b.json": "{}" },
    ];
    for (const files of cases) {
      await mkdir(lockDir);
      for (const [name, text] of Object.entries(files)) await writeFile(join(lockDir, name), text);

      const waiting = acquireLock(lockDir, 100);

      await expect(waiting).rejects.toBeInstanceOf(LedgerLockTimeoutError);
      await expect(waiting).rejects.toMatchObject({ ownerPid: undefined });
      await expect(waiting).rejects.toThrow(`remove ${lockDir}`);
      expect((await readdir(lockDir)).sort()).toEqual(Object.keys(files).sort());
      await rm(lockDir, { recursive: true });
    }
  });

  it("waits on a plain file at the lock path, never removes it, and says it isn't a lock xatlas made", async () => {
    const cases = [
      "not a lock at all",
      // The single-file format an earlier build wrote, naming a pid that is gone.
      JSON.stringify({ pid: deadPid(), host: "mac", token: "old-build" }),
    ];
    for (const text of cases) {
      await writeFile(lockDir, text);

      const waiting = acquireLock(lockDir, 100);

      await expect(waiting).rejects.toBeInstanceOf(LedgerLockTimeoutError);
      await expect(waiting).rejects.toMatchObject({ ownerPid: undefined, notALock: true });
      await expect(waiting).rejects.toThrow(`${lockDir} is not a lock xatlas made`);
      await expect(waiting).rejects.toThrow(`remove ${lockDir}`);
      expect(await readFile(lockDir, "utf8")).toBe(text);
      // The writer that gave up leaves nothing of its own behind.
      expect(await readdir(folder)).toEqual(["project.jsonl.lock"]);
      await rm(lockDir);
    }
  });

  it("removes private folders left by writers that died before getting the lock, and keeps the rest", async () => {
    const dead = await plantLock(`${lockDir}.dead.tmp`, deadPid(), "dead");
    const live = await plantLock(`${lockDir}.live.tmp`, process.pid, "live");
    // A writer that died between making its folder and writing its file can't be judged.
    await mkdir(`${lockDir}.unwritten.tmp`);
    // Another project's lock is not this lock's business.
    const other = await plantLock(join(folder, "other.jsonl.lock.gone.tmp"), deadPid(), "gone");

    await (await acquireLock(lockDir, 1_000)).release();

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(`${lockDir}.unwritten.tmp`)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
