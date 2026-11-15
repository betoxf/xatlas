import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LedgerLockTimeoutError } from "./errors.js";

/**
 * A lock between processes. It is never broken because of its age; only a lock whose owner
 * process is gone is taken over.
 *
 * The lock is a folder holding one owner file, named by the owner's random token. A writer
 * fills a private folder beside it and renames that folder into place, which fails while the
 * lock folder exists with something in it. So the lock appears whole, in one step.
 *
 * Nothing is ever removed by a "read, then remove" of a path that someone could make again.
 * Releasing or taking over removes one owner file by its exact token name, then the folder
 * with rmdir, which refuses a folder that isn't empty. A waiter that still believes a dead
 * owner holds the lock, after someone else has taken it over and a new writer has moved in,
 * can then only miss: the dead token's file is gone, and the new folder isn't empty.
 *
 * Where a crash leaves things:
 * - before the rename: the writer's private folder stays beside the lock. The next writer to
 *   get the lock removes it once its owner's pid is gone (an empty one, from a crash between
 *   making the folder and writing the file, is left alone, since it can't be judged).
 * - holding the lock: the lock folder names a dead pid, and the next writer takes it over.
 * - between removing the owner file and the folder: the lock folder is empty. A rename onto an
 *   empty folder works on macOS and Linux; a waiter also removes an empty lock folder first,
 *   for systems where it doesn't.
 *
 * Known limit, pid reuse: after a crash, the dead owner's pid can come back as an unrelated,
 * long-lived process. The lock then looks alive and every write waits until it times out. Telling
 * the two apart needs each process's start time, which Node can't read without spawning a tool,
 * so instead the timeout error names the pid, when it took the lock, and the folder to remove.
 */

/** The file operations the lock uses; tests pass their own to pause between steps. */
export interface LockFs {
  mkdir(path: string): Promise<unknown>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  /** Removes a folder and what is in it. */
  removeTree(path: string): Promise<void>;
}

export const realLockFs: LockFs = {
  mkdir: (path) => nodeFs.mkdir(path),
  writeFile: (path, text) => nodeFs.writeFile(path, text),
  rename: (from, to) => nodeFs.rename(from, to),
  readdir: (path) => nodeFs.readdir(path),
  readFile: (path) => nodeFs.readFile(path, "utf8"),
  unlink: (path) => nodeFs.unlink(path),
  rmdir: (path) => nodeFs.rmdir(path),
  removeTree: (path) => nodeFs.rm(path, { recursive: true, force: true }),
};

interface LockOwner {
  readonly pid: number;
  /** Shown to a person reading the file; liveness is judged by pid alone. */
  readonly host: string;
  readonly token: string;
  /** When the lock was taken, for the timeout error. */
  readonly since: string;
}

export interface HeldLock {
  readonly token: string;
  release(): Promise<void>;
}

/** Callers in one process take turns here first, so they don't poll the folder against each other. */
const turns = new Map<string, Promise<unknown>>();

export async function withLedgerLock<T>(
  lockDir: string,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const before = turns.get(lockDir) ?? Promise.resolve();
  const mine = before.then(async () => {
    const lock = await acquireLock(lockDir, timeoutMs);
    try {
      return await work();
    } finally {
      await lock.release();
    }
  });
  const settled = mine.catch(() => undefined);
  turns.set(lockDir, settled);
  void settled.then(() => {
    if (turns.get(lockDir) === settled) turns.delete(lockDir);
  });
  return mine;
}

/** Takes the lock, waiting for a live owner and taking over a dead one. */
export async function acquireLock(
  lockDir: string,
  timeoutMs: number,
  fs: LockFs = realLockFs,
): Promise<HeldLock> {
  const token = randomUUID();
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token,
    since: new Date().toISOString(),
  };
  const draft = `${lockDir}.${token}.tmp`;
  await fs.mkdir(draft);
  try {
    await fs.writeFile(join(draft, ownerFile(token)), `${JSON.stringify(owner)}\n`);
    await waitForLock(lockDir, draft, timeoutMs, fs);
  } catch (error) {
    await fs.removeTree(draft).catch(() => undefined);
    throw error;
  }
  await removeDeadDrafts(lockDir, fs);
  return { token, release: () => removeLock(lockDir, token, fs) };
}

async function waitForLock(
  lockDir: string,
  draft: string,
  timeoutMs: number,
  fs: LockFs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let wait = 2;
  for (;;) {
    if (await publish(draft, lockDir, fs)) return;
    const holder = await readHolder(lockDir, fs);
    if (Date.now() >= deadline) {
      throw new LedgerLockTimeoutError(
        lockDir,
        typeof holder === "object" ? holder.pid : undefined,
        typeof holder === "object" ? holder.since : undefined,
        holder === "not-a-folder",
      );
    }
    if (holder === "gone") continue; // released between the two looks: try again at once
    if (holder === "empty") {
      await ignoring(fs.rmdir(lockDir), "ENOENT", "ENOTEMPTY");
    } else if (typeof holder === "object" && isDead(holder)) {
      await removeLock(lockDir, holder.token, fs);
    } else {
      // A little jitter keeps several waiting processes from retrying in step.
      await delay(wait + Math.random() * wait);
      wait = Math.min(wait * 2, 50);
    }
  }
}

/** Renames the filled private folder into place; false while a lock is there. */
async function publish(draft: string, lockDir: string, fs: LockFs): Promise<boolean> {
  try {
    await fs.rename(draft, lockDir);
    return true;
  } catch (error) {
    const code = codeOf(error);
    // ENOTDIR: something that isn't a folder is at the lock path; `readHolder` says so.
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") return false;
    // Windows refuses a rename onto any existing folder with one of these.
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return false;
    throw error;
  }
}

/**
 * Removes one owner's lock: its own file by exact name, then the folder only if empty. Safe to
 * call with a stale token: it then finds no file to remove and a folder that isn't empty.
 */
async function removeLock(lockDir: string, token: string, fs: LockFs): Promise<void> {
  await ignoring(fs.unlink(join(lockDir, ownerFile(token))), "ENOENT");
  await ignoring(fs.rmdir(lockDir), "ENOENT", "ENOTEMPTY", "EEXIST");
}

/**
 * Who holds the lock. Anything other than one well-formed owner file is "unreadable", and
 * anything at the path that isn't a folder is "not-a-folder": both are waited on and never
 * removed.
 *
 * A plain file there is never taken over, even a readable owner record in an earlier build's
 * single-file format naming a dead pid. Unlinking it by path can't remove a folder lock, but it
 * could remove a fresh plain-file lock written by that earlier build in the meantime, so it isn't
 * as safe as the folder take-over. The timeout error says it can be removed by hand instead.
 */
async function readHolder(
  folder: string,
  fs: LockFs,
): Promise<LockOwner | "gone" | "empty" | "unreadable" | "not-a-folder"> {
  let names: string[];
  try {
    names = await fs.readdir(folder);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return "gone";
    if (codeOf(error) === "ENOTDIR") return "not-a-folder";
    throw error;
  }
  if (names.length === 0) return "empty";
  const [name] = names;
  if (names.length !== 1 || !name?.endsWith(".json")) return "unreadable";
  let text: string;
  try {
    text = await fs.readFile(join(folder, name));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return "gone";
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.token === "string" &&
      name === ownerFile(parsed.token)
    ) {
      return {
        pid: parsed.pid,
        host: String(parsed.host),
        token: parsed.token,
        since: String(parsed.since),
      };
    }
  } catch {
    // Not ours to judge.
  }
  return "unreadable";
}

/**
 * Private folders left beside the lock by writers that died before getting it. Only the
 * writer that made one ever renames it, so once that writer's pid is gone it is safe to remove.
 */
async function removeDeadDrafts(lockDir: string, fs: LockFs): Promise<void> {
  const prefix = `${basename(lockDir)}.`;
  let names: string[];
  try {
    names = await fs.readdir(dirname(lockDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const folder = join(dirname(lockDir), name);
    const holder = await readHolder(folder, fs).catch(() => "unreadable" as const);
    if (typeof holder === "object" && isDead(holder)) {
      await fs.removeTree(folder).catch(() => undefined);
    }
  }
}

function ownerFile(token: string): string {
  return `${token}.json`;
}

/** Judged by pid alone: a Mac's host name changes between networks. See "pid reuse" above. */
function isDead(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return codeOf(error) === "ESRCH";
  }
}

async function ignoring(step: Promise<unknown>, ...codes: string[]): Promise<void> {
  try {
    await step;
  } catch (error) {
    if (!codes.includes(codeOf(error) ?? "")) throw error;
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
