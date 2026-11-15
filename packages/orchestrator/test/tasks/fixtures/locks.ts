import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** A pid that belonged to a process that has already exited. */
export function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

/** Puts a lock folder in place as another writer would have, and returns its owner file. */
export async function plantLock(
  lockDir: string,
  pid: number,
  token = "other-writer",
  since = "2026-11-15T08:00:00.000Z",
): Promise<string> {
  await mkdir(lockDir, { recursive: true });
  const file = join(lockDir, `${token}.json`);
  await writeFile(file, `${JSON.stringify({ pid, host: hostname(), token, since })}\n`);
  return file;
}
