import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseTrainResult } from "@zcode/shared";

/** Runs `git` with `args` in `cwd` and returns stdout. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

export function createGitRunner(): GitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
          // No prompts, no LFS downloads for a throwaway checkout. A sandboxed dev
          // run moves HOME; git's credentials stay with the real one.
          env: {
            ...process.env,
            ...(process.env.XATLAS_GH_HOME ? { HOME: process.env.XATLAS_GH_HOME } : {}),
            GIT_TERMINAL_PROMPT: "0",
            GIT_LFS_SKIP_SMUDGE: "1",
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stderr: String(stderr ?? "") }));
            return;
          }
          resolve(String(stdout));
        },
      );
    });
}

/** A merge identity and no hooks: the train never commits anywhere that matters. */
const SCRATCH_MERGE_CONFIG = [
  "-c",
  "user.name=xatlas merge train",
  "-c",
  "user.email=merge-train@xatlas.local",
  "-c",
  "core.hooksPath=/dev/null",
];

/**
 * Merges each pull request head, in order, onto the latest base in a detached
 * scratch worktree; a conflicting one is recorded with its files and left out,
 * and the train continues. The worktree is removed afterwards.
 */
export async function runMergeTrain(
  git: GitRunner,
  workspacePath: string,
  baseBranch: string,
  order: readonly number[],
  now: () => Date = () => new Date(),
): Promise<ReleaseTrainResult> {
  const root = (await git(["rev-parse", "--show-toplevel"], workspacePath)).trim();
  await git(["fetch", "--quiet", "origin", baseBranch], root);
  const baseCommit = (await git(["rev-parse", "FETCH_HEAD"], root)).trim();
  const scratch = await mkdtemp(join(tmpdir(), "xatlas-merge-train-"));
  await git(["worktree", "add", "--detach", "--quiet", scratch, baseCommit], root);
  const steps: ReleaseTrainResult["steps"][number][] = [];
  try {
    for (const pullRequest of order) {
      let head: string;
      try {
        await git(["fetch", "--quiet", "origin", `pull/${pullRequest}/head`], root);
        head = (await git(["rev-parse", "FETCH_HEAD"], root)).trim();
      } catch {
        steps.push({ pullRequest, status: "unavailable", conflictFiles: [] });
        continue;
      }
      try {
        await git(
          [...SCRATCH_MERGE_CONFIG, "merge", "--no-ff", "--no-edit", "-m", `train #${pullRequest}`, head],
          scratch,
        );
        steps.push({ pullRequest, status: "merged", conflictFiles: [] });
      } catch {
        const conflictFiles = (await git(["diff", "--name-only", "--diff-filter=U"], scratch).catch(() => ""))
          .split("\n")
          .map((file) => file.trim())
          .filter(Boolean);
        await git(["merge", "--abort"], scratch).catch(() => undefined);
        steps.push({ pullRequest, status: "conflict", conflictFiles });
      }
    }
  } finally {
    await git(["worktree", "remove", "--force", scratch], root).catch(() => undefined);
    await git(["worktree", "prune"], root).catch(() => undefined);
  }
  return { baseBranch, baseCommit, checkedAt: now().toISOString(), steps };
}
