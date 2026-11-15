import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CliAgentGitDirs } from "./commands.js";

const execFileAsync = promisify(execFile);

/** Asking git takes milliseconds; one that hangs mustn't hold up the turn for long. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Where the checkout at `cwd` keeps its git data, as real paths, since that is what the
 * sandboxes compare against. Undefined outside a repository or without git: the run is then
 * confined to its folder alone.
 */
export async function readCliAgentGitDirs(
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentGitDirs | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { cwd, timeout: GIT_TIMEOUT_MS, ...(env ? { env } : {}) },
    );
    const [gitDir, commonDir] = stdout.split("\n").filter((line) => line.length > 0);
    if (!gitDir || !commonDir) return undefined;
    return { gitDir: await realpath(gitDir), commonDir: await realpath(commonDir) };
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's sandbox makes `.claude/.cc-writes/` in the folder it runs in, for writing files
 * whole. An empty folder is invisible to git, but a file left in it would be committed by
 * `git add -A`. Claude Code writes the same rule to the user's global ignore file, which another
 * machine or setup may not have, so the repository's own exclude file gets it too.
 */
export const CLAUDE_STAGING_EXCLUDE = "**/.claude/.cc-writes/";

/**
 * Adds `line` to the repository's local exclude file (`info/exclude` in the common git
 * directory, shared by its worktrees) unless it is there, leaving the rest as it was. A file
 * that can't be read or written is left alone: the turn runs without the line.
 */
export async function excludeFromGit(commonDir: string, line: string): Promise<void> {
  const file = join(commonDir, "info", "exclude");
  try {
    const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (current.split(/\r?\n/u).some((existing) => existing.trim() === line)) return;
    await mkdir(dirname(file), { recursive: true });
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(file, `${separator}${line}\n`);
  } catch {
    // Without the line the worst case is a stray file to leave out of a commit.
  }
}
