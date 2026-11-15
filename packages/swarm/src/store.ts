import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SwarmEvent, SwarmMember, SwarmMode, SwarmResult } from "./types.js";

/** The file format; a file with a higher number was written by a newer xatlas. */
export const SAVED_SWARM_RUN_VERSION = 1;

/** One swarm run on disk: `<id>.json` in the folder the caller gives. */
export interface SavedSwarmRun {
  readonly version: number;
  readonly id: string;
  /** ISO time the caller saved it. */
  readonly savedAt: string;
  readonly status: "done" | "failed" | "cancelled";
  readonly task: string;
  readonly members: readonly SwarmMember[];
  readonly rounds?: number;
  /** How the run reached its plan; absent in runs saved before there was a choice, which were contests. */
  readonly mode?: SwarmMode;
  /** Every event, in order. */
  readonly events: readonly SwarmEvent[];
  /** Absent when the run failed or was cancelled before it finished. */
  readonly result?: SwarmResult;
  readonly error?: string;
}

/** What the caller gives `saveRun`; the version is added. */
export type SwarmRunToSave = Omit<SavedSwarmRun, "version">;

export interface SavedSwarmRunSummary {
  readonly id: string;
  readonly savedAt: string;
  readonly status: SavedSwarmRun["status"];
  readonly task: string;
  readonly memberIds: readonly string[];
  readonly winner?: { readonly letter: string; readonly memberId: string };
}

export interface SwarmRunListing {
  /** Newest first. */
  readonly runs: readonly SavedSwarmRunSummary[];
  /** Files that couldn't be read (cut off, not JSON, or from a newer version), with why. */
  readonly unreadable: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function checkId(id: string): void {
  if (typeof id !== "string" || !ID.test(id)) {
    throw new Error(
      `"${id}" can't name a saved swarm run: use letters, digits, ".", "_" and "-", starting with a letter or digit.`,
    );
  }
}

function fileOf(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * Saves a run as `<id>.json`, replacing an earlier save of the same id. It writes a temporary
 * file in the same folder, flushes it to disk and renames it over the old one, so a reader
 * sees the old file or the new one, never half of one. Returns the file's path.
 */
export async function saveRun(dir: string, run: SwarmRunToSave): Promise<string> {
  checkId(run.id);
  await mkdir(dir, { recursive: true });
  const file = fileOf(dir, run.id);
  const temp = join(dir, `.${run.id}.${randomBytes(6).toString("hex")}.tmp`);
  const saved: SavedSwarmRun = { version: SAVED_SWARM_RUN_VERSION, ...run };
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(saved, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return file;
}

/** Checks a parsed file; throws with the reason when it isn't a run this version can read. */
function readSaved(text: string, file: string): SavedSwarmRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not complete JSON (cut off while it was written?)`);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`${file} is not a saved swarm run`);
  const run = parsed as Partial<SavedSwarmRun>;
  if (typeof run.version !== "number") throw new Error(`${file} has no version`);
  if (run.version > SAVED_SWARM_RUN_VERSION) {
    throw new Error(
      `${file} was saved by a newer xatlas (version ${run.version}; this one reads up to ${SAVED_SWARM_RUN_VERSION})`,
    );
  }
  if (
    typeof run.id !== "string" ||
    typeof run.task !== "string" ||
    typeof run.savedAt !== "string" ||
    !Array.isArray(run.members) ||
    !Array.isArray(run.events)
  ) {
    throw new Error(
      `${file} is missing the id, task, time, members or events of a saved swarm run`,
    );
  }
  return run as SavedSwarmRun;
}

/** The saved run, or `undefined` when there is none. Throws when the file can't be read. */
export async function loadRun(dir: string, id: string): Promise<SavedSwarmRun | undefined> {
  checkId(id);
  const file = fileOf(dir, id);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readSaved(text, file);
}

/**
 * Every saved run in the folder, newest first, and the files it couldn't read. Temporary
 * files of a save in progress (or one that crashed) are not runs and are left out.
 */
export async function listRuns(dir: string): Promise<SwarmRunListing> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], unreadable: [] };
    throw error;
  }
  const runs: SavedSwarmRunSummary[] = [];
  const unreadable: Array<{ file: string; reason: string }> = [];
  for (const name of names
    .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
    .sort()) {
    const file = join(dir, name);
    try {
      const run = readSaved(await readFile(file, "utf8"), file);
      runs.push({
        id: run.id,
        savedAt: run.savedAt,
        status: run.status,
        task: run.task,
        memberIds: run.members.map((member) => member.id),
        ...(run.result?.winner
          ? { winner: { letter: run.result.winner.letter, memberId: run.result.winner.memberId } }
          : {}),
      });
    } catch (error) {
      unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  runs.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
  return { runs, unreadable };
}
