import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { gitOk, type GitRunner } from "./git.js";

/** What is in a worktree that removing it could lose, and how clean-up talks about it. */

/**
 * What `git status` shows: changed files, untracked files, and ignored ones, which `git
 * worktree remove` deletes without asking. `--ignored=matching` names an ignored folder once
 * ("node_modules/") and doesn't walk into it, so a large one costs nothing.
 */
export async function readLocalChanges(
  git: GitRunner,
  path: string,
): Promise<{ changed: string[]; untracked: string[]; ignored: string[] }> {
  const output = await gitOk(
    git,
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ],
    path,
  );
  const changed: string[] = [];
  const untracked: string[] = [];
  const ignored: string[] = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    if (code === "??") untracked.push(file);
    else if (code === "!!") ignored.push(file);
    else changed.push(file);
    // A rename or copy is followed by the name it had before.
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return { changed, untracked, ignored };
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** Up to five names, and how many more there are. */
export function names(files: readonly string[]): string {
  const shown = files.slice(0, 5).join(", ");
  return files.length > 5 ? `${shown} and ${files.length - 5} more` : shown;
}

/**
 * A path whose ignored contents may go. A bare name ("node_modules", "dist/", ".next") matches
 * a folder or file of that name at any depth, so it covers `node_modules` in every package of a
 * workspace. A path with a slash anywhere but at its end ("packages/app/dist", "./dist") is
 * anchored at the repository root and covers only that folder or file.
 */
export interface Disposable {
  /** As git writes paths: forward slashes, no leading "./" and no trailing "/". */
  readonly path: string;
  readonly anyDepth: boolean;
}

/** Reads one disposable path, or undefined when it leaves the repository. */
export function disposablePath(path: string): Disposable | undefined {
  const given = path.trim().replace(/\\/g, "/");
  const clean = given.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (clean === "" || isAbsolute(path.trim()) || /^[A-Za-z]:/.test(clean)) return undefined;
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return { path: clean, anyDepth: !given.replace(/\/+$/, "").includes("/") };
}

/** Whether an ignored entry from git ("node_modules/", "a.log") lies in a disposable path. */
export function covers(disposable: Disposable, entry: string): boolean {
  const file = entry.replace(/\/$/, "");
  if (disposable.anyDepth) return file.split("/").includes(disposable.path);
  return file === disposable.path || file.startsWith(`${disposable.path}/`);
}

/** The file in the main checkout that names what the host copies into a new worktree. */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

const PATHSPEC_BATCH = 100;

/**
 * Sorts a worktree's ignored entries (as `git status` lists them) into the ones that may go and
 * the ones that would lose something.
 *
 * An entry may go when a disposable path covers it, or when every file in it is either covered
 * by a disposable path or a copy the host made. Git names an ignored folder once ("config/"),
 * so the disposable paths are applied to what is inside it too ("config/node_modules/"), and a
 * disposable folder found there is skipped, never walked.
 *
 * The host (packages/services/src/git/managed-worktree/gitWorktreeRepo.ts) copies the regular
 * files that `git ls-files --others --ignored --exclude-from=.worktreeinclude` lists in the main
 * checkout and that git ignores there. The same command, run in the worktree with the main
 * checkout's `.worktreeinclude`, says which files that rule could have copied. Such a file is a
 * copy when it is a regular file byte for byte the same as the regular file at the same path in
 * the main checkout. One that differs, or whose original is gone, is the run's work.
 *
 * Returns the entries that would lose something, and the files in them that match
 * `.worktreeinclude` without being copies, so the person can be told which ones changed. A
 * folder is looked at a batch of files at a time and no further than its first loss.
 */
export async function sortOutIgnored(
  git: GitRunner,
  mainPath: string,
  worktreePath: string,
  ignored: readonly string[],
  disposable: readonly Disposable[],
): Promise<{ kept: string[]; changedCopies: string[] }> {
  const goes = (path: string) => disposable.some((rule) => covers(rule, path));
  const entries = ignored.filter((entry) => !goes(entry));
  const kept: string[] = [];
  const changedCopies: string[] = [];
  if (entries.length === 0) return { kept, changedCopies };
  const include = join(mainPath, WORKTREE_INCLUDE_FILE);
  const hasInclude = (await stat(include).catch(() => undefined)) !== undefined;

  /**
   * Which of these files the host's rule names. Callers pass at most PATHSPEC_BATCH files, as
   * the host batches, to keep each command line short (Windows caps it near 32K).
   */
  const named = async (files: readonly string[]): Promise<Set<string>> => {
    if (!hasInclude) return new Set();
    const output = await gitOk(
      git,
      [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--ignored",
        `--exclude-from=${include}`,
        "-z",
        "--",
        ...files,
      ],
      worktreePath,
    );
    return new Set(output.split("\0").filter(Boolean));
  };

  /** Whether every file in this batch is a copy; the changed copies are noted on the way. */
  const allCopies = async (files: readonly string[]): Promise<boolean> => {
    const matched = await named(files);
    let copies = true;
    for (const file of files) {
      if (!matched.has(file)) copies = false;
      else if (!(await sameFile(worktreePath, mainPath, file))) {
        copies = false;
        changedCopies.push(file);
      }
    }
    return copies;
  };

  for (const entry of entries) {
    const files = entry.endsWith("/") ? filesUnder(worktreePath, entry, goes) : [entry];
    let safe = true;
    let batch: string[] = [];
    for await (const file of files) {
      if (file === undefined || !hasInclude) {
        safe = false;
        break;
      }
      batch.push(file);
      if (batch.length === PATHSPEC_BATCH) {
        safe = await allCopies(batch);
        batch = [];
        if (!safe) break;
      }
    }
    if (batch.length > 0 && !(await allCopies(batch))) safe = false;
    if (!safe) kept.push(entry);
  }
  return { kept, changedCopies };
}

/**
 * The files under a folder of the worktree, relative to it with "/" between parts, in name
 * order. What `skip` names is passed over without being walked. Anything that is neither a
 * file nor a folder (a link, a socket) comes back as undefined, because it is never a copy.
 */
async function* filesUnder(
  root: string,
  folder: string,
  skip: (path: string) => boolean,
): AsyncGenerator<string | undefined> {
  const items = await readdir(join(root, folder), { withFileTypes: true });
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const item of items) {
    const path = `${folder}${item.name}`;
    if (skip(path)) continue;
    if (item.isDirectory()) yield* filesUnder(root, `${path}/`, skip);
    else yield item.isFile() ? path : undefined;
  }
}

/** Whether `file` is a regular file with the same bytes in both checkouts. */
async function sameFile(worktreePath: string, mainPath: string, file: string): Promise<boolean> {
  const [ours, theirs] = await Promise.all(
    [worktreePath, mainPath].map((root) => lstat(join(root, file)).catch(() => undefined)),
  );
  if (!ours?.isFile() || !theirs?.isFile() || ours.size !== theirs.size) return false;
  const [a, b] = await Promise.all([
    readFile(join(worktreePath, file)),
    readFile(join(mainPath, file)),
  ]);
  return a.equals(b);
}
