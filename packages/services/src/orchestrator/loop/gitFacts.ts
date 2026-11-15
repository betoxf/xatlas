import { access } from "node:fs/promises";
import { join } from "node:path";
import type { RunIdentity } from "@zcode/orchestrator/types";
import { readTrailers, type GitRunner } from "@zcode/orchestrator/worktrees";

/**
 * What git says about a run's worktree when a turn ends, and the commit a step starts from.
 * Every path is relative to the repository root, as division writes `owns`.
 */

async function ok(git: GitRunner, args: readonly string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

export async function headOf(git: GitRunner, cwd: string): Promise<string> {
  return (await ok(git, ["rev-parse", "--verify", "HEAD^{commit}"], cwd)).trim();
}

/** The paths committed between two commits. */
export async function changedPaths(
  git: GitRunner,
  cwd: string,
  base: string,
  head: string,
): Promise<string[]> {
  if (base === head) return [];
  const output = await ok(git, ["diff", "--name-only", "-z", "--no-renames", base, head], cwd);
  return output.split("\0").filter(Boolean);
}

/** How many commits `to` has on its first-parent line since `from`. */
export async function commitCount(
  git: GitRunner,
  cwd: string,
  from: string,
  to: string,
): Promise<number> {
  if (from === to) return 0;
  const output = await ok(git, ["rev-list", "--count", "--first-parent", `${from}..${to}`], cwd);
  return Number.parseInt(output.trim(), 10) || 0;
}

/** Paths changed in the worktree and not committed, untracked ones included, ignored ones not. */
export async function uncommittedPaths(git: GitRunner, cwd: string): Promise<string[]> {
  const output = await ok(
    git,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    cwd,
  );
  const paths: string[] = [];
  for (const record of output.split("\0")) {
    if (record.length > 3) paths.push(record.slice(3));
  }
  return paths;
}

/**
 * The commits on the first-parent line from `base` to `head` whose trailers don't name this
 * run. The loop's own base is used, not the worktree marker's: the agent may commit before the
 * worktree is adopted, and the marker then starts after that commit.
 */
export async function commitsMissingTrailers(
  git: GitRunner,
  cwd: string,
  base: string,
  head: string,
  identity: RunIdentity,
): Promise<number> {
  if (base === head) return 0;
  const output = await ok(
    git,
    ["log", "--first-parent", "--format=%H%x00%B%x1e", `${base}..${head}`, "--"],
    cwd,
  );
  let missing = 0;
  for (const record of output.split("\x1e")) {
    const [hash, body = ""] = record.replace(/^\s+/, "").split("\0");
    if (!hash) continue;
    const found = readTrailers(body);
    if (found?.runId !== identity.runId || found.taskId !== identity.taskId) missing += 1;
  }
  return missing;
}

/** Lines added and removed between two commits. */
export async function changedLines(
  git: GitRunner,
  cwd: string,
  base: string,
  head: string,
): Promise<number> {
  if (base === head) return 0;
  const output = await ok(git, ["diff", "--numstat", base, head], cwd);
  let lines = 0;
  for (const row of output.split("\n")) {
    const [added, removed] = row.split("\t");
    lines += (Number.parseInt(added ?? "", 10) || 0) + (Number.parseInt(removed ?? "", 10) || 0);
  }
  return lines;
}

export async function hasDesignDoc(worktreePath: string): Promise<boolean> {
  return access(join(worktreePath, "DESIGN.md")).then(
    () => true,
    () => false,
  );
}

export type StartCommit =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The commit a step's worktree starts from: the first dependency's reviewed commit (the
 * project's HEAD when it has none), with the other dependencies' reviewed commits merged in.
 * The merges are made in the project's object store with `merge-tree` and `commit-tree`, with
 * no worktree, before the executor starts: the agent never works on a half-merged tree, the
 * merged files are part of its base (so they are not its changes), and a conflict stops the
 * step before anything runs.
 */
export async function startCommit(
  git: GitRunner,
  repoPath: string,
  start: { readonly startFrom: string | null; readonly mergeIn: readonly string[] },
  label: string,
): Promise<StartCommit> {
  let current = start.startFrom ?? (await headOf(git, repoPath));
  for (const other of start.mergeIn) {
    const contained = await git(["merge-base", "--is-ancestor", other, current], repoPath);
    if (contained.code === 0) continue;
    const merged = await git(
      ["merge-tree", "--write-tree", "--name-only", current, other],
      repoPath,
    );
    const [tree = "", ...rest] = merged.stdout.split("\n");
    if (merged.code === 1) {
      // The conflicted names come first; the messages follow after an empty line.
      const end = rest.indexOf("");
      const files = (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== "");
      const shown = files.slice(0, 5).join(", ");
      return {
        ok: false,
        reason: `The reviewed commits ${current.slice(0, 12)} and ${other.slice(0, 12)} conflict when merged for ${label}${shown ? ` (${shown}${files.length > 5 ? " and more" : ""})` : ""}. Merge them by hand on a branch, or change the steps, then try again.`,
      };
    }
    if (merged.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree.trim())) {
      return {
        ok: false,
        reason: `Git couldn't merge the reviewed commits for ${label}: ${(merged.stderr || merged.stdout).trim() || "merge-tree failed"}.`,
      };
    }
    const commit = await git(
      [
        "commit-tree",
        tree.trim(),
        "-p",
        current,
        "-p",
        other,
        "-m",
        `Merge reviewed work for ${label}`,
      ],
      repoPath,
    );
    if (commit.code !== 0) {
      return {
        ok: false,
        reason: `Git couldn't make the merge commit for ${label}: ${(commit.stderr || commit.stdout).trim()}. Set user.name and user.email in the repository and try again.`,
      };
    }
    current = commit.stdout.trim();
  }
  return { ok: true, sha: current };
}
