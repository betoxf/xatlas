import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunIdentity } from "../types.js";
import {
  createGitRunner,
  gitOk,
  parseWorktreeList,
  type GitRunner,
  type WorktreeEntry,
} from "./git.js";
import {
  disposablePath,
  names,
  plural,
  readLocalChanges,
  sortOutIgnored,
  type Disposable,
} from "./status.js";
import {
  assertIdentity,
  branchName,
  fieldsFromTrailerLines,
  identityFromFields,
  identityProblem,
} from "./identity.js";

/** One run's worktree, as xatlas made it. */
export interface WorktreeRef {
  /** The repository path the caller gave, made absolute. */
  readonly repoPath: string;
  /** The worktree's folder, as git records it. */
  readonly path: string;
  readonly branch: string;
  /** The commit the branch started from. */
  readonly baseSha: string;
  /**
   * The full ref the base named, e.g. `refs/heads/main`, so "merged" can be judged against
   * where the base is now. Absent when the base was given as a commit.
   */
  readonly baseRef?: string;
  readonly identity: RunIdentity;
  readonly createdAt: string;
}

export interface EnsureInput {
  readonly repoPath: string;
  /** The folder the worktree goes in; a relative one is taken from `repoPath`. */
  readonly root: string;
  readonly identity: RunIdentity;
  /** A branch, tag or commit to start from. */
  readonly base: string;
}

export interface AdoptInput {
  readonly repoPath: string;
  /** A worktree of `repoPath` that the host made, with a detached HEAD. */
  readonly path: string;
  readonly identity: RunIdentity;
  /**
   * The branch or tag the host took the HEAD from ("main", "refs/heads/main"), so "merged" is
   * judged against where it is now. Without it the adopted commit is the base.
   */
  readonly baseRef?: string;
}

export interface CleanUpOptions {
  readonly runActive: boolean;
  /** Delete the branch too, which happens only when it is merged into the base. */
  readonly deleteBranch?: boolean;
  /**
   * Folders or files whose ignored contents may be thrown away, such as "node_modules", "dist"
   * or ".next". A bare name matches a folder or file of that name at any depth
   * ("node_modules" covers packages/app/node_modules too); a path with a slash anywhere but at
   * its end ("packages/app/dist", "./dist") is anchored at the repository root. It covers
   * ignored files only, never changed or untracked ones. Without it, any ignored file that
   * isn't a copy the host made from `.worktreeinclude` stops the clean-up.
   */
  readonly disposable?: readonly string[];
}

/** Whether a worktree can go without losing anything, decided as `cleanUp` decides it. */
export interface RemovalCheck {
  readonly safe: boolean;
  /** Why it can't go, in a sentence for the person. */
  readonly reason?: string;
  /**
   * The ignored entries that would go with it, as git lists them (a folder ends in "/"):
   * disposable ones and copies made from `.worktreeinclude`. Empty when it isn't safe.
   */
  readonly discarded: readonly string[];
}

export interface CleanUpResult {
  readonly removed: boolean;
  /** Why nothing was removed, in a sentence for the person. */
  readonly refusedBecause?: string;
  readonly branchDeleted: boolean;
  /** Why the branch was kept when deleting it was asked for. */
  readonly branchKeptBecause?: string;
  /**
   * The ignored entries that went with the worktree, as git lists them (a folder ends in
   * "/" and stands for everything in it). Empty when nothing was removed.
   */
  readonly discarded: readonly string[];
}

export interface WorktreeManager {
  ensure(input: EnsureInput): Promise<WorktreeRef>;
  /**
   * Gives a worktree the host made (detached HEAD) the run's branch, at that HEAD, and the
   * marker `ensure` writes. Adopting again for the same run returns the same ref.
   */
  adopt(input: AdoptInput): Promise<WorktreeRef>;
  list(repoPath: string): Promise<readonly WorktreeRef[]>;
  /** Hashes of the branch's own commits since the base that don't carry the run's trailers. */
  missingTrailers(ref: WorktreeRef): Promise<readonly string[]>;
  /** The checks `cleanUp` makes, removing nothing. */
  canRemove(ref: WorktreeRef, options: CleanUpOptions): Promise<RemovalCheck>;
  cleanUp(ref: WorktreeRef, options: CleanUpOptions): Promise<CleanUpResult>;
}

/** The marker's file name inside the worktree's own git directory. */
export const MARKER_FILE = "xatlas-run.json";

interface Marker {
  readonly version: 1;
  readonly identity: RunIdentity;
  readonly branch: string;
  readonly baseSha: string;
  readonly baseRef?: string;
  readonly createdAt: string;
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

async function realOrResolved(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

async function samePath(a: string, b: string): Promise<boolean> {
  return (await realOrResolved(a)) === (await realOrResolved(b));
}

function isMarker(value: unknown): value is Marker {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Partial<Marker>;
  return (
    marker.version === 1 &&
    typeof marker.identity === "object" &&
    marker.identity !== null &&
    identityProblem(marker.identity) === undefined &&
    marker.branch === branchName(marker.identity) &&
    typeof marker.baseSha === "string" &&
    SHA.test(marker.baseSha) &&
    (marker.baseRef === undefined ||
      (typeof marker.baseRef === "string" && marker.baseRef.startsWith("refs/"))) &&
    typeof marker.createdAt === "string"
  );
}

function sameRun(a: RunIdentity, b: RunIdentity): boolean {
  return a.runId === b.runId && a.taskId === b.taskId && a.agent === b.agent;
}

/** "on <branch>" or "detached", for sentences about where a worktree is. */
function where(entry: WorktreeEntry): string {
  return entry.branch ? `on ${entry.branch.replace(/^refs\/heads\//, "")}` : "detached";
}

/**
 * Writes a marker only where none is, and takes back a file it started but couldn't finish,
 * so a failed write never leaves half a marker.
 */
async function writeMarker(path: string, marker: Marker): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

/** The adoption under way for each worktree (by real path), shared by every manager here. */
const adopting = new Map<string, Promise<unknown>>();

export function createWorktreeManager(
  options: { git?: GitRunner; now?: () => Date } = {},
): WorktreeManager {
  const git = options.git ?? createGitRunner();
  const now = options.now ?? (() => new Date());
  /** Two calls for the same run at once share one creation. */
  const ensuring = new Map<string, Promise<WorktreeRef>>();

  async function worktrees(repoPath: string) {
    return parseWorktreeList(await gitOk(git, ["worktree", "list", "--porcelain", "-z"], repoPath));
  }

  /** The position of the worktree at `path` in git's list, or -1. */
  async function indexOf(entries: readonly WorktreeEntry[], path: string): Promise<number> {
    for (const [position, entry] of entries.entries()) {
      if (await samePath(entry.path, path)) return position;
    }
    return -1;
  }

  /** The worktree's own git directory (under the main repository's .git/worktrees). */
  async function gitDirOf(worktreePath: string): Promise<string | undefined> {
    const result = await git(["rev-parse", "--absolute-git-dir"], worktreePath).catch(
      () => undefined,
    );
    return result?.code === 0 ? result.stdout.trim() : undefined;
  }

  async function readMarker(worktreePath: string): Promise<Marker | undefined> {
    const gitDir = await gitDirOf(worktreePath);
    if (!gitDir) return undefined;
    try {
      const value: unknown = JSON.parse(await readFile(join(gitDir, MARKER_FILE), "utf8"));
      return isMarker(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function toRef(repoPath: string, path: string, marker: Marker): WorktreeRef {
    return {
      repoPath,
      path,
      branch: marker.branch,
      baseSha: marker.baseSha,
      ...(marker.baseRef ? { baseRef: marker.baseRef } : {}),
      identity: marker.identity,
      createdAt: marker.createdAt,
    };
  }

  /**
   * Undoes a creation whose marker couldn't be written. The worktree goes only while it holds
   * nothing but the fresh checkout (a hook or a person may already have put files there, even
   * ignored ones), and the branch only once the worktree is gone and still at the base.
   */
  async function rollBack(
    repoPath: string,
    path: string,
    branch: string,
    baseSha: string,
    cause: unknown,
  ): Promise<void> {
    const leave = (why: string) =>
      new Error(
        `Couldn't finish the worktree for ${branch} (${cause instanceof Error ? cause.message : String(cause)}), and ${why}; the worktree at ${path} was left for a person to look at.`,
      );
    const local = await readLocalChanges(git, path).catch(() => undefined);
    if (!local) throw leave("git couldn't say what is in it");
    const found = [...local.changed, ...local.untracked, ...local.ignored];
    if (found.length > 0)
      throw leave(`it already holds files xatlas didn't make (${names(found)})`);
    const removal = await git(["worktree", "remove", path], repoPath).catch(() => undefined);
    if (removal?.code !== 0) {
      throw leave(`git wouldn't remove it: ${removal?.stderr.trim() || "git didn't run"}`);
    }
    await git(["update-ref", "-d", `refs/heads/${branch}`, baseSha], repoPath).catch(
      () => undefined,
    );
  }

  async function create(input: EnsureInput): Promise<WorktreeRef> {
    const repoPath = resolve(input.repoPath);
    const { identity, base } = input;
    const branch = branchName(identity);

    const open = (await worktrees(repoPath)).find(
      (entry) => entry.branch === `refs/heads/${branch}`,
    );
    if (open) {
      const marker = await readMarker(open.path);
      if (marker && sameRun(marker.identity, identity) && marker.branch === branch) {
        return toRef(repoPath, open.path, marker);
      }
      throw new Error(
        `Branch ${branch} is open in ${open.path} without this run's marker; xatlas won't take it over.`,
      );
    }
    const exists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
    if (exists.code === 0) {
      throw new Error(`Branch ${branch} already exists and no worktree has it open.`);
    }

    if (base.trim() === "" || base.startsWith("-")) {
      throw new Error(`The base "${base}" isn't a branch, tag or commit.`);
    }
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], repoPath);
    const baseSha = resolved.stdout.trim();
    if (resolved.code !== 0 || !SHA.test(baseSha)) {
      throw new Error(`The base "${base}" doesn't name a commit in ${repoPath}.`);
    }
    const symbolic = await git(["rev-parse", "--symbolic-full-name", base], repoPath);
    const fullName = symbolic.code === 0 ? symbolic.stdout.trim() : "";
    const baseRef = /^refs\/\S+$/.test(fullName) ? fullName : undefined;

    const rootPath = resolve(repoPath, input.root);
    await mkdir(rootPath, { recursive: true });
    const path = join(
      await realOrResolved(rootPath),
      `${identity.taskId}-${identity.agent}-${identity.runId}`,
    );
    // A commit, not a remote branch, as the start point: git then sets no upstream config.
    await gitOk(git, ["worktree", "add", "-b", branch, path, baseSha], repoPath);

    const marker: Marker = {
      version: 1,
      identity,
      branch,
      baseSha,
      ...(baseRef ? { baseRef } : {}),
      createdAt: now().toISOString(),
    };
    try {
      const gitDir = await gitDirOf(path);
      if (!gitDir) throw new Error(`git couldn't find the new worktree's git directory.`);
      await writeFile(join(gitDir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, {
        flag: "wx",
      });
    } catch (error) {
      await rollBack(repoPath, path, branch, baseSha, error);
      throw error;
    }
    const recorded = (await worktrees(repoPath)).find(
      (entry) => entry.branch === `refs/heads/${branch}`,
    );
    return toRef(repoPath, recorded?.path ?? path, marker);
  }

  async function ensure(input: EnsureInput): Promise<WorktreeRef> {
    assertIdentity(input.identity);
    const key = `${resolve(input.repoPath)}\0${input.identity.runId}`;
    const pending = ensuring.get(key);
    if (pending) return pending;
    const created = create(input).finally(() => ensuring.delete(key));
    ensuring.set(key, created);
    return created;
  }

  async function adoptOnce(input: AdoptInput): Promise<WorktreeRef> {
    const repoPath = resolve(input.repoPath);
    const { identity } = input;
    const branch = branchName(identity);

    const entries = await worktrees(repoPath);
    const index = await indexOf(entries, input.path);
    const entry = entries[index];
    if (!entry) throw new Error(`${input.path} isn't a worktree of ${repoPath}.`);
    if (index === 0 || entry.bare) {
      throw new Error(
        `${entry.path} is the main checkout of ${repoPath}; xatlas adopts only a worktree the host made.`,
      );
    }
    if (entry.prunable) {
      throw new Error(
        `The worktree at ${entry.path} is gone from disk; ask the host for a new one.`,
      );
    }

    const marker = await readMarker(entry.path);
    if (marker) {
      if (!sameRun(marker.identity, identity)) {
        throw new Error(
          `The worktree at ${entry.path} already belongs to run ${marker.identity.runId} (${marker.branch}); give this run a worktree of its own.`,
        );
      }
      if (entry.branch === `refs/heads/${branch}`) return toRef(repoPath, entry.path, marker);
      throw new Error(
        `The worktree at ${entry.path} was adopted for this run but is now ${where(entry)}; switch it back to ${branch} before going on.`,
      );
    }
    const gitDir = await gitDirOf(entry.path);
    if (!gitDir) throw new Error(`git couldn't find the git directory of ${entry.path}.`);
    const markerPath = join(gitDir, MARKER_FILE);
    if (await lstat(markerPath).catch(() => undefined)) {
      throw new Error(
        `${markerPath} exists but isn't a marker xatlas can read; remove it if no run owns the worktree at ${entry.path}.`,
      );
    }
    if (!entry.detached || entry.branch) {
      throw new Error(
        `The worktree at ${entry.path} is ${where(entry)}, not on a detached HEAD as the host leaves it; xatlas won't take over a branch.`,
      );
    }
    const head = entry.head ?? "";
    if (!SHA.test(head))
      throw new Error(`The worktree at ${entry.path} has no commit checked out.`);

    const open = entries.find((other) => other.branch === `refs/heads/${branch}`);
    if (open) {
      throw new Error(
        `Branch ${branch} is already open in ${open.path}; finish that worktree or give this run another id.`,
      );
    }
    const exists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
    if (exists.code === 0) {
      throw new Error(
        `Branch ${branch} already exists; delete it if nothing on it is needed, or give this run another id.`,
      );
    }

    let baseRef: string | undefined;
    if (input.baseRef !== undefined) {
      const given = input.baseRef;
      const symbolic =
        given.trim() === "" || given.startsWith("-")
          ? undefined
          : await git(
              ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", given],
              repoPath,
            );
      const fullName = symbolic?.code === 0 ? symbolic.stdout.trim() : "";
      if (!/^refs\/\S+$/.test(fullName)) {
        throw new Error(`The base "${given}" isn't a branch or tag in ${repoPath}.`);
      }
      const contains = await git(["merge-base", "--is-ancestor", head, fullName], repoPath);
      if (contains.code !== 0) {
        throw new Error(
          `The worktree's HEAD (${head.slice(0, 12)}) isn't on ${fullName}, so that can't be its base.`,
        );
      }
      baseRef = fullName;
    }

    // Nothing has been written yet. The branch is made only if it doesn't exist (the empty old
    // value), and HEAD is pointed at it in place: the commit is the same, so the index and the
    // files, copied-in ones included, stay as they are, and no checkout hook runs.
    const fail = (what: string, result: { stderr: string; stdout: string }) =>
      new Error(`Couldn't ${what} for ${entry.path}: ${(result.stderr || result.stdout).trim()}`);
    const created = await git(
      ["update-ref", "-m", "xatlas: adopt worktree", `refs/heads/${branch}`, head, ""],
      repoPath,
    );
    if (created.code !== 0) throw fail(`create branch ${branch}`, created);

    /**
     * Takes back what this call made, and only while it is still this call's: HEAD is detached
     * again only while it is on this call's branch and no marker claims the worktree, and the
     * branch is deleted only once no worktree has it checked out and it is still at `head`.
     */
    const undo = async (cause: unknown, switched: boolean): Promise<never> => {
      const problems: string[] = [];
      const ours = `refs/heads/${branch}`;
      const onOurs = async () =>
        (
          await git(["symbolic-ref", "-q", "HEAD"], entry.path).catch(() => undefined)
        )?.stdout.trim() === ours;
      if (switched && (await onOurs())) {
        const claim = await readMarker(entry.path);
        if (claim) {
          problems.push(
            `its HEAD stays on ${branch} because run ${claim.identity.runId} has marked it`,
          );
        } else {
          const detached = await git(
            ["update-ref", "--no-deref", "-m", "xatlas: undo adopt", "HEAD", head],
            entry.path,
          ).catch(() => undefined);
          if (detached?.code !== 0) problems.push("its HEAD couldn't be detached again");
        }
      }
      const open = (await worktrees(repoPath).catch(() => undefined))?.find(
        (other) => other.branch === ours,
      );
      if (open) {
        if (problems.length === 0) problems.push(`branch ${branch} is checked out in ${open.path}`);
      } else {
        const deleted = await git(["update-ref", "-d", ours, head], repoPath).catch(
          () => undefined,
        );
        if (deleted?.code !== 0) problems.push(`branch ${branch} couldn't be deleted`);
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        problems.length === 0
          ? `Couldn't adopt the worktree at ${entry.path} (${message}); it was left detached as before.`
          : `Couldn't adopt the worktree at ${entry.path} (${message}), and ${problems.join(" and ")}; look at it before using it.`,
      );
    };

    const written: Marker = {
      version: 1,
      identity,
      branch,
      baseSha: head,
      ...(baseRef ? { baseRef } : {}),
      createdAt: now().toISOString(),
    };
    let switched = false;
    try {
      // HEAD must still be the commit the branch was made at, or pointing it at the branch
      // would leave one commit's files under another.
      const current = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], entry.path);
      if (current.stdout.trim() !== head) throw new Error("its HEAD moved while it was adopted");
      const result = await git(
        ["symbolic-ref", "-m", "xatlas: adopt worktree", "HEAD", `refs/heads/${branch}`],
        entry.path,
      );
      if (result.code !== 0) throw fail(`switch to ${branch}`, result);
      switched = true;
      await writeMarker(markerPath, written);
    } catch (error) {
      return undo(error, switched);
    }
    return toRef(repoPath, entry.path, written);
  }

  async function adopt(input: AdoptInput): Promise<WorktreeRef> {
    assertIdentity(input.identity);
    // One adoption at a time per worktree in this process, whichever runs ask, so two runs
    // can't both pass the checks before either has written its marker.
    const key = await realOrResolved(input.path);
    const turn = (adopting.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => adoptOnce(input));
    adopting.set(key, turn);
    try {
      return await turn;
    } finally {
      if (adopting.get(key) === turn) adopting.delete(key);
    }
  }

  async function list(repoPath: string): Promise<readonly WorktreeRef[]> {
    const absolute = resolve(repoPath);
    const refs: WorktreeRef[] = [];
    // The first entry is the main checkout, which is never a run's.
    for (const entry of (await worktrees(absolute)).slice(1)) {
      if (entry.bare || entry.prunable) continue;
      const marker = await readMarker(entry.path);
      if (marker) refs.push(toRef(absolute, entry.path, marker));
    }
    return refs;
  }

  /** Throws when a ref handed in from outside couldn't have come from this manager. */
  function checkRef(ref: WorktreeRef): void {
    assertIdentity(ref.identity);
    if (ref.branch !== branchName(ref.identity) || !SHA.test(ref.baseSha)) {
      throw new Error("The worktree reference doesn't match its run's branch and base.");
    }
  }

  async function missingTrailers(ref: WorktreeRef): Promise<readonly string[]> {
    checkRef(ref);
    // First parent only: commits brought in by merging the base belong to someone else.
    const output = await gitOk(
      git,
      [
        "log",
        "--first-parent",
        "-z",
        "--format=%H%x00%(trailers:only,unfold)",
        `${ref.baseSha}..refs/heads/${ref.branch}`,
        "--",
      ],
      ref.repoPath,
    );
    const fields = output.split("\0");
    const missing: string[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const hash = fields[index]!.trim();
      if (!hash) continue;
      const found = identityFromFields(fieldsFromTrailerLines(fields[index + 1]!));
      const stamped =
        found !== undefined &&
        sameRun(found, ref.identity) &&
        (ref.identity.model === undefined || found.model === ref.identity.model);
      if (!stamped) missing.push(hash);
    }
    return missing;
  }

  /** The base's commit now, or where it started when the base was a commit or is gone. */
  async function baseTip(ref: WorktreeRef): Promise<string> {
    if (!ref.baseRef) return ref.baseSha;
    const result = await git(
      ["rev-parse", "--verify", "--quiet", `${ref.baseRef}^{commit}`],
      ref.repoPath,
    );
    const sha = result.stdout.trim();
    return result.code === 0 && SHA.test(sha) ? sha : ref.baseSha;
  }

  /**
   * Everything that decides whether a worktree can go, for `canRemove` and `cleanUp` alike: a
   * sentence saying why it can't, or what removing it needs and would discard.
   */
  async function inspect(
    ref: WorktreeRef,
    options: CleanUpOptions,
  ): Promise<
    | { readonly refusal: string }
    | {
        readonly refusal?: undefined;
        readonly entry: WorktreeEntry;
        readonly ref: WorktreeRef;
        readonly base: string;
        readonly discarded: readonly string[];
      }
  > {
    const refuse = (refusal: string) => ({ refusal });
    if (options.runActive) return refuse("The run is still active.");
    checkRef(ref);
    const disposable = (options.disposable ?? []).map(disposablePath);
    const badDisposable = (options.disposable ?? []).find((_, at) => disposable[at] === undefined);
    if (badDisposable !== undefined) {
      return refuse(`"${badDisposable}" isn't a folder or file inside the repository.`);
    }

    const entries = await worktrees(ref.repoPath);
    const index = await indexOf(entries, ref.path);
    const entry = entries[index];
    if (!entry) return refuse(`No worktree at ${ref.path} is registered with this repository.`);
    if (index === 0 || entry.bare) {
      return refuse("That is the repository's main checkout, which is never removed.");
    }

    // The marker, not the branch name, is what says xatlas made this worktree.
    const marker = await readMarker(entry.path);
    if (!marker) return refuse("The worktree has no xatlas marker, so xatlas didn't make it.");
    if (!sameRun(marker.identity, ref.identity) || marker.branch !== ref.branch) {
      return refuse(`The worktree's marker belongs to run ${marker.identity.runId}, not this one.`);
    }
    // From here the marker's base and branch are used, never the caller's: a ref rebuilt by
    // hand with another base must not make unpushed work look merged.
    ref = toRef(ref.repoPath, entry.path, marker);
    if (entry.branch !== `refs/heads/${ref.branch}`) {
      return refuse(`The worktree is ${where(entry)} instead of its run's branch ${ref.branch}.`);
    }
    if (entry.locked) return refuse("The worktree is locked.");

    const { changed, untracked, ignored } = await readLocalChanges(git, entry.path);
    if (changed.length > 0 || untracked.length > 0) {
      return refuse(
        `The worktree has ${plural(changed.length, "changed file")} and ${plural(untracked.length, "untracked file")} (${names([...changed, ...untracked])}).`,
      );
    }
    // `git worktree remove` deletes ignored files, so each must be disposable or a copy.
    const { kept, changedCopies } = await sortOutIgnored(
      git,
      entries[0]!.path,
      entry.path,
      ignored,
      disposable.filter((rule): rule is Disposable => rule !== undefined),
    );
    if (kept.length > 0) {
      const changedNote =
        changedCopies.length === 0
          ? ""
          : `; ${names(changedCopies)} ${changedCopies.length === 1 ? "matches" : "match"} .worktreeinclude but ${changedCopies.length === 1 ? "isn't" : "aren't"} the same as in the main checkout`;
      return refuse(
        `Removing the worktree would delete ${plural(kept.length, "ignored entry", "ignored entries")} (${names(kept)})${changedNote}; name them as disposable to let them go.`,
      );
    }

    const base = await baseTip(ref);
    const unsafe = (
      await gitOk(
        git,
        ["rev-list", `refs/heads/${ref.branch}`, "--not", base, "--remotes", "--"],
        ref.repoPath,
      )
    )
      .split("\n")
      .filter(Boolean);
    if (unsafe.length > 0) {
      const shas = unsafe
        .slice(0, 5)
        .map((sha) => sha.slice(0, 12))
        .join(", ");
      return refuse(
        `${plural(unsafe.length, "commit")} on ${ref.branch} ${unsafe.length === 1 ? "is" : "are"} neither merged into the base nor pushed (${shas}). If its pull request was squash-merged, git can't see that: confirm the pull request is merged (for example \`gh pr view ${ref.branch} --json state\`) before removing the worktree yourself.`,
      );
    }
    return { entry, ref, base, discarded: ignored };
  }

  async function canRemove(ref: WorktreeRef, options: CleanUpOptions): Promise<RemovalCheck> {
    const found = await inspect(ref, options);
    return found.refusal === undefined
      ? { safe: true, discarded: found.discarded }
      : { safe: false, reason: found.refusal, discarded: [] };
  }

  async function cleanUp(given: WorktreeRef, options: CleanUpOptions): Promise<CleanUpResult> {
    const refuse = (reason: string): CleanUpResult => ({
      removed: false,
      refusedBecause: reason,
      branchDeleted: false,
      discarded: [],
    });
    const found = await inspect(given, options);
    if (found.refusal !== undefined) return refuse(found.refusal);
    const { entry, ref, base } = found;

    // Without --force, git checks again and refuses if anything changed since.
    const removal = await git(["worktree", "remove", entry.path], ref.repoPath);
    if (removal.code !== 0) {
      return refuse(
        `git wouldn't remove the worktree: ${removal.stderr.trim() || removal.stdout.trim()}`,
      );
    }
    const { discarded } = found;
    if (!options.deleteBranch) return { removed: true, branchDeleted: false, discarded };

    const keep = (reason: string): CleanUpResult => ({
      removed: true,
      branchDeleted: false,
      branchKeptBecause: reason,
      discarded,
    });
    const tip = (
      await gitOk(git, ["rev-parse", "--verify", `refs/heads/${ref.branch}^{commit}`], ref.repoPath)
    ).trim();
    const merged = await git(["merge-base", "--is-ancestor", tip, base], ref.repoPath);
    if (merged.code !== 0) return keep(`${ref.branch} isn't merged into the base.`);
    const openElsewhere = (await worktrees(ref.repoPath)).some(
      (other) => other.branch === `refs/heads/${ref.branch}`,
    );
    if (openElsewhere) return keep(`${ref.branch} is open in another worktree.`);
    // Deletes only if the branch still points at the commit just checked.
    const deleted = await git(["update-ref", "-d", `refs/heads/${ref.branch}`, tip], ref.repoPath);
    if (deleted.code !== 0) return keep(`${ref.branch} moved while it was being deleted.`);
    return { removed: true, branchDeleted: true, discarded };
  }

  return { ensure, adopt, list, missingTrailers, canRemove, cleanUp };
}
