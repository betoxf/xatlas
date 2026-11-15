import { execFile } from "node:child_process";

/** What one `git` run gave back. A non-zero `code` is an answer, not an error. */
export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `git` with `args` in `cwd`. It rejects only when git couldn't be run at all; a git
 * that ran and said no resolves with its exit code, because some questions (`merge-base
 * --is-ancestor`) are answered that way.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

/**
 * Variables that tell git which repository to use. Git sets them for its hooks, so a test
 * run from a hook would otherwise point every command at the hook's repository.
 */
const LOCATING_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of LOCATING_VARIABLES) delete env[name];
  return env;
}

/** The real `git`, run without a shell, from an argument array. */
export function createGitRunner(options: { timeoutMs?: number } = {}): GitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          env: gitEnv(),
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (error && typeof code !== "number") {
            reject(error);
            return;
          }
          resolve({
            code: error ? (code as number) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(
      `git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(-400)}`,
    );
    this.name = "GitError";
  }
}

/** Runs git and returns stdout, throwing when it exits with anything but 0. */
export async function gitOk(
  runner: GitRunner,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await runner(args, cwd);
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout;
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  /** The full ref, e.g. `refs/heads/main`; absent when detached. */
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/** Reads `git worktree list --porcelain -z`; the main worktree comes first. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { -readonly [K in keyof WorktreeEntry]: WorktreeEntry[K] } | undefined;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, bare: false, detached: false, locked: false, prunable: false };
    } else if (current) {
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value;
      else if (key === "bare") current.bare = true;
      else if (key === "detached") current.detached = true;
      else if (key === "locked") current.locked = true;
      else if (key === "prunable") current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}
