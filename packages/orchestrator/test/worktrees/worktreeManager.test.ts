import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunIdentity } from "../../src/types.js";
import {
  branchName,
  createGitRunner,
  createWorktreeManager,
  MARKER_FILE,
  withTrailers,
  type WorktreeManager,
  type WorktreeRef,
} from "../../src/worktrees/index.js";

// Real repositories spawn many git processes; give them room on a busy machine.
const TIMEOUT = 60_000;

const runner = createGitRunner();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runner(args, cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commit(cwd: string, file: string, message: string): Promise<string> {
  await writeFile(join(cwd, file), `${file} ${Date.now()} ${Math.random()}\n`);
  await git(cwd, "add", "--", file);
  await git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * Settings for a throwaway repository only: who commits, no signing, and a hooks folder of
 * its own, empty unless a test puts a hook there.
 */
async function configure(dir: string, repo: string): Promise<void> {
  const hooks = join(dir, "hooks");
  await mkdir(hooks, { recursive: true });
  for (const [key, value] of [
    ["user.name", "xatlas test"],
    ["user.email", "test@xatlas.local"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", hooks],
    ["core.autocrlf", "false"],
  ] as const) {
    await git(repo, "config", "--local", key, value);
  }
}

interface Fixture {
  readonly dir: string;
  readonly repo: string;
  readonly root: string;
  readonly hooks: string;
  readonly snapshot: () => Promise<string>;
}

/**
 * A repository with `main` checked out and a `develop` branch to use as the base, so a merge
 * into the base can be made without touching the main checkout; and a bare remote.
 */
async function makeFixture(): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "xatlas-worktrees-")));
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  await git(dir, "init", "-q", "-b", "main", repo);
  await configure(dir, repo);
  await writeFile(join(repo, "README.md"), "hello\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.env\n*.log\ndist/\n");
  await git(repo, "add", "README.md", ".gitignore");
  await git(repo, "commit", "-q", "-m", "First commit");
  await git(repo, "branch", "develop");
  await git(dir, "init", "-q", "--bare", remote);
  await configure(dir, remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-q", "origin", "main", "develop");
  // Everything about the main checkout that a worktree must never change.
  const snapshot = async () =>
    [
      await git(repo, "symbolic-ref", "HEAD"),
      await git(repo, "rev-parse", "HEAD"),
      await git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
      await readFile(join(repo, "README.md"), "utf8"),
      await git(repo, "config", "--local", "--list"),
    ].join("\n");
  return { dir, repo, root: join(dir, "worktrees"), hooks: join(dir, "hooks"), snapshot };
}

/** Merges `branch` into `develop` with a real merge commit, without checking anything out. */
async function mergeIntoDevelop(repo: string, branch: string): Promise<void> {
  const develop = await git(repo, "rev-parse", "develop");
  const tree = await git(repo, "rev-parse", `${branch}^{tree}`);
  const merge = await git(repo, "commit-tree", tree, "-p", develop, "-p", branch, "-m", "Merge");
  await git(repo, "update-ref", "refs/heads/develop", merge, develop);
}

const identity: RunIdentity = { runId: "r1", taskId: "t1", agent: "claude", model: "opus" };

describe("worktree manager", { timeout: TIMEOUT }, () => {
  let fixture: Fixture;
  let before: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    fixture = await makeFixture();
    before = await fixture.snapshot();
    manager = createWorktreeManager({ now: () => new Date("2026-11-15T10:00:00Z") });
  }, TIMEOUT);

  afterEach(async () => {
    try {
      // The main checkout is untouched by everything a test did.
      expect(await fixture.snapshot()).toBe(before);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }, TIMEOUT);

  const ensure = (run: RunIdentity = identity) =>
    manager.ensure({ repoPath: fixture.repo, root: fixture.root, identity: run, base: "develop" });

  it("makes the worktree and its branch from the base, with the marker in its own git directory", async () => {
    const ref = await ensure();
    const developSha = await git(fixture.repo, "rev-parse", "develop");

    expect(ref).toEqual({
      repoPath: fixture.repo,
      path: join(fixture.root, "t1-claude-r1"),
      branch: "xatlas/t1/claude-r1",
      baseSha: developSha,
      baseRef: "refs/heads/develop",
      identity,
      createdAt: "2026-11-15T10:00:00.000Z",
    });
    expect(await git(ref.path, "symbolic-ref", "HEAD")).toBe("refs/heads/xatlas/t1/claude-r1");
    expect(await git(ref.path, "rev-parse", "HEAD")).toBe(developSha);

    const gitDir = await git(ref.path, "rev-parse", "--absolute-git-dir");
    expect(gitDir).toBe(join(fixture.repo, ".git", "worktrees", basename(ref.path)));
    const marker = JSON.parse(await readFile(join(gitDir, MARKER_FILE), "utf8"));
    expect(marker).toMatchObject({ version: 1, identity, branch: ref.branch, baseSha: developSha });
    // Nothing in the working tree, and no upstream written to the repository's config.
    expect(existsSync(join(ref.path, MARKER_FILE))).toBe(false);
    expect(await git(ref.path, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const upstream = await runner(["config", "--get", `branch.${ref.branch}.merge`], fixture.repo);
    expect(upstream.code).toBe(1);
  });

  it("returns the same worktree for the same run and changes nothing", async () => {
    const first = await ensure();
    const gitDir = await git(first.path, "rev-parse", "--absolute-git-dir");
    const marker = await readFile(join(gitDir, MARKER_FILE), "utf8");
    const later = createWorktreeManager({ now: () => new Date("2030-01-01T00:00:00Z") });

    const again = await later.ensure({
      repoPath: fixture.repo,
      root: fixture.root,
      identity,
      base: "main",
    });
    const together = await Promise.all([ensure(), ensure()]);

    expect(again).toEqual(first);
    expect(together).toEqual([first, first]);
    expect(await readFile(join(gitDir, MARKER_FILE), "utf8")).toBe(marker);
    expect(await manager.list(fixture.repo)).toHaveLength(1);
  });

  it("makes branch names git accepts from odd ids", async () => {
    const odd: RunIdentity = { runId: "0.9_RC-1", taskId: "T_2026.11.15-a", agent: "opencode" };
    expect(await git(fixture.repo, "check-ref-format", "--branch", branchName(odd))).toBe(
      branchName(odd),
    );
    const ref = await ensure(odd);
    expect(await git(ref.path, "symbolic-ref", "--short", "HEAD")).toBe(branchName(odd));
  });

  it("won't take over a branch that is open without this run's marker", async () => {
    await git(
      fixture.repo,
      "worktree",
      "add",
      "-q",
      "-b",
      branchName(identity),
      join(fixture.dir, "by-hand"),
      "main",
    );
    await expect(ensure()).rejects.toThrow(/without this run's marker/);
  });

  it("lists only the worktrees that carry the marker", async () => {
    const ours = await ensure();
    const second = await ensure({ ...identity, runId: "r2" });
    await git(
      fixture.repo,
      "worktree",
      "add",
      "-q",
      "-b",
      "xatlas/t1/claude-r3",
      join(fixture.dir, "by-hand"),
      "main",
    );

    const listed = await manager.list(fixture.repo);

    expect(listed).toEqual([ours, second]);
  });

  it("writes trailers git reads, and finds the commits that lack them", async () => {
    const ref = await ensure();
    const message = withTrailers(
      "Add dark mode\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      identity,
    );
    const stamped = await commit(ref.path, "a.txt", message);
    const unstamped = await commit(ref.path, "b.txt", "Forgot the trailers");
    const otherRun = await commit(
      ref.path,
      "c.txt",
      withTrailers("Not mine", { ...identity, runId: "r9" }),
    );

    const trailers = await git(
      ref.path,
      "log",
      "-1",
      "--format=%(trailers:key=Xatlas-Run,valueonly)|%(trailers:key=Co-Authored-By,valueonly)|%(trailers:key=Xatlas-Model,valueonly)",
      stamped,
    );
    expect(trailers.replace(/\n/g, "")).toBe("r1|Claude <noreply@anthropic.com>|opus");

    expect(await manager.missingTrailers(ref)).toEqual([otherRun, unstamped]);
  });

  it("doesn't count commits brought in by merging the base as the run's own", async () => {
    const ref = await ensure();
    await commit(ref.path, "a.txt", withTrailers("Mine", identity));
    // Someone else's commit lands on the base, made in a scratch worktree off to the side.
    const side = join(fixture.dir, "side");
    await git(fixture.repo, "worktree", "add", "-q", side, "develop");
    await commit(side, "theirs.txt", "Theirs, with no trailers");
    await git(fixture.repo, "worktree", "remove", side);
    await git(
      ref.path,
      "merge",
      "-q",
      "--no-edit",
      "-m",
      withTrailers("Merge develop", identity),
      "develop",
    );

    expect(await manager.missingTrailers(ref)).toEqual([]);
  });

  it("refuses to clean up while the run is active", async () => {
    const ref = await ensure();
    const result = await manager.cleanUp(ref, { runActive: true });
    expect(result).toMatchObject({ removed: false, refusedBecause: "The run is still active." });
    expect(existsSync(ref.path)).toBe(true);
  });

  it("refuses to clean up a worktree without the marker, whatever its branch is called", async () => {
    const path = join(fixture.dir, "by-hand");
    await git(fixture.repo, "worktree", "add", "-q", "-b", branchName(identity), path, "develop");
    const forged: WorktreeRef = {
      repoPath: fixture.repo,
      path,
      branch: branchName(identity),
      baseSha: await git(fixture.repo, "rev-parse", "develop"),
      baseRef: "refs/heads/develop",
      identity,
      createdAt: "2026-11-15T10:00:00.000Z",
    };

    const result = await manager.cleanUp(forged, { runActive: false, deleteBranch: true });

    expect(result.removed).toBe(false);
    expect(result.refusedBecause).toMatch(/no xatlas marker/);
    expect(existsSync(path)).toBe(true);
  });

  it("refuses to clean up the main checkout", async () => {
    const ref = await ensure();
    const result = await manager.cleanUp({ ...ref, path: fixture.repo }, { runActive: false });
    expect(result.refusedBecause).toMatch(/main checkout/);
  });

  it("refuses to clean up a worktree with a changed file", async () => {
    const ref = await ensure();
    await writeFile(join(ref.path, "README.md"), "changed\n");
    const result = await manager.cleanUp(ref, { runActive: false });
    expect(result.removed).toBe(false);
    expect(result.refusedBecause).toBe(
      "The worktree has 1 changed file and 0 untracked files (README.md).",
    );
    expect(existsSync(ref.path)).toBe(true);
  });

  it("refuses to clean up a worktree with an untracked file", async () => {
    const ref = await ensure();
    await mkdir(join(ref.path, "notes"));
    await writeFile(join(ref.path, "notes", "todo.md"), "keep me\n");
    const result = await manager.cleanUp(ref, { runActive: false });
    expect(result.refusedBecause).toBe(
      "The worktree has 0 changed files and 1 untracked file (notes/todo.md).",
    );
    expect(existsSync(join(ref.path, "notes", "todo.md"))).toBe(true);
  });

  it("refuses to clean up a branch with a commit that is neither merged nor pushed", async () => {
    const ref = await ensure();
    const sha = await commit(ref.path, "work.txt", withTrailers("Work", identity));
    const result = await manager.cleanUp(ref, { runActive: false, deleteBranch: true });
    expect(result.removed).toBe(false);
    expect(result.refusedBecause).toBe(
      `1 commit on xatlas/t1/claude-r1 is neither merged into the base nor pushed (${sha.slice(0, 12)}). If its pull request was squash-merged, git can't see that: confirm the pull request is merged (for example \`gh pr view xatlas/t1/claude-r1 --json state\`) before removing the worktree yourself.`,
    );
    expect(existsSync(ref.path)).toBe(true);
  });

  it("judges merged and pushed by the marker's base, not by a base the caller hands in", async () => {
    const ref = await ensure();
    const tip = await commit(ref.path, "work.txt", withTrailers("Work", identity));
    const forged: WorktreeRef = { ...ref, baseSha: tip, baseRef: `refs/heads/${ref.branch}` };

    const result = await manager.cleanUp(forged, { runActive: false, deleteBranch: true });

    expect(result.removed).toBe(false);
    expect(result.refusedBecause).toMatch(/neither merged into the base nor pushed/);
    expect(existsSync(ref.path)).toBe(true);
    expect(await git(fixture.repo, "rev-parse", ref.branch)).toBe(tip);
  });

  it("refuses when the worktree has moved to another branch", async () => {
    const ref = await ensure();
    await git(ref.path, "switch", "-q", "-c", "side");
    const result = await manager.cleanUp(ref, { runActive: false });
    expect(result.refusedBecause).toBe(
      "The worktree is on side instead of its run's branch xatlas/t1/claude-r1.",
    );
  });

  it("removes a clean worktree whose commits are pushed, and keeps the branch even when asked to delete it", async () => {
    const ref = await ensure();
    const sha = await commit(ref.path, "work.txt", withTrailers("Work", identity));
    await git(ref.path, "push", "-q", "origin", ref.branch);

    const result = await manager.cleanUp(ref, { runActive: false, deleteBranch: true });

    expect(result).toEqual({
      removed: true,
      branchDeleted: false,
      discarded: [],
      branchKeptBecause: "xatlas/t1/claude-r1 isn't merged into the base.",
    });
    expect(existsSync(ref.path)).toBe(false);
    expect(await git(fixture.repo, "rev-parse", ref.branch)).toBe(sha);
    expect(await manager.list(fixture.repo)).toEqual([]);
  });

  it("removes a merged worktree and keeps its branch unless asked to delete it", async () => {
    const ref = await ensure();
    await commit(ref.path, "work.txt", withTrailers("Work", identity));
    await mergeIntoDevelop(fixture.repo, ref.branch);

    const result = await manager.cleanUp(ref, { runActive: false });

    expect(result).toEqual({ removed: true, branchDeleted: false, discarded: [] });
    expect(existsSync(ref.path)).toBe(false);
    expect(await git(fixture.repo, "branch", "--list", ref.branch)).not.toBe("");
  });

  it("deletes a merged branch when asked", async () => {
    const ref = await ensure();
    await commit(ref.path, "work.txt", withTrailers("Work", identity));
    await mergeIntoDevelop(fixture.repo, ref.branch);

    const result = await manager.cleanUp(ref, { runActive: false, deleteBranch: true });

    expect(result).toEqual({ removed: true, branchDeleted: true, discarded: [] });
    expect(await git(fixture.repo, "branch", "--list", ref.branch)).toBe("");
    expect(await git(fixture.repo, "worktree", "list", "--porcelain")).not.toContain(ref.path);
  });

  it("removes an untouched worktree and its branch, which the base already contains", async () => {
    const ref = await ensure();
    const result = await manager.cleanUp(ref, { runActive: false, deleteBranch: true });
    expect(result).toEqual({ removed: true, branchDeleted: true, discarded: [] });
    const again = await manager.cleanUp(ref, { runActive: false });
    expect(again.refusedBecause).toMatch(/No worktree at .* is registered/);
  });

  describe("ignored files", () => {
    async function put(root: string, ...files: string[]): Promise<void> {
      for (const file of files) {
        await mkdir(join(root, file, ".."), { recursive: true });
        await writeFile(join(root, file), `${file}\n`);
      }
    }

    it("refuses to clean up a worktree holding an ignored file, and names it", async () => {
      const ref = await ensure();
      await put(ref.path, ".env");

      const result = await manager.cleanUp(ref, { runActive: false });

      expect(result).toEqual({
        removed: false,
        branchDeleted: false,
        discarded: [],
        refusedBecause:
          "Removing the worktree would delete 1 ignored entry (.env); name them as disposable to let them go.",
      });
      expect(await readFile(join(ref.path, ".env"), "utf8")).toBe(".env\n");
    });

    it("names an ignored folder once, without listing what is in it, and caps the list", async () => {
      const ref = await ensure();
      await put(ref.path, "node_modules/a/index.js", "node_modules/b/lib/deep.js", "dist/out.js");
      await put(ref.path, "1.log", "2.log", "3.log", "4.log", "5.log");

      const result = await manager.cleanUp(ref, { runActive: false });

      expect(result.refusedBecause).toBe(
        "Removing the worktree would delete 7 ignored entries (1.log, 2.log, 3.log, 4.log, 5.log and 2 more); name them as disposable to let them go.",
      );
      expect(existsSync(join(ref.path, "node_modules/b/lib/deep.js"))).toBe(true);
    });

    it("removes a worktree whose ignored entries are all disposable, and says what went", async () => {
      const ref = await ensure();
      await put(ref.path, "node_modules/a/index.js", "node_modules/b/lib/deep.js", "dist/out.js");

      const result = await manager.cleanUp(ref, {
        runActive: false,
        disposable: ["node_modules", "./dist/"],
      });

      expect(result).toEqual({
        removed: true,
        branchDeleted: false,
        discarded: ["dist/", "node_modules/"],
      });
      expect(existsSync(ref.path)).toBe(false);
    });

    it("refuses when an ignored entry lies outside the disposable paths", async () => {
      const ref = await ensure();
      await put(ref.path, "node_modules/a/index.js", ".env", "packages/app/node_modules/x.js");

      const result = await manager.cleanUp(ref, { runActive: false, disposable: ["node_modules"] });

      // A bare name covers the folder at any depth, so only .env is left to stop it.
      expect(result.refusedBecause).toBe(
        "Removing the worktree would delete 1 ignored entry (.env); name them as disposable to let them go.",
      );
      expect(existsSync(join(ref.path, ".env"))).toBe(true);
    });

    it("applies the disposable names inside an ignored folder git reports as one entry", async () => {
      const ref = await ensure();
      await put(ref.path, "dist/node_modules/a/index.js");

      expect(
        await manager.canRemove(ref, { runActive: false, disposable: ["node_modules"] }),
      ).toEqual({
        safe: true,
        discarded: ["dist/"],
      });

      await put(ref.path, "dist/out.js");
      expect(
        (await manager.canRemove(ref, { runActive: false, disposable: ["node_modules"] })).reason,
      ).toBe(
        "Removing the worktree would delete 1 ignored entry (dist/); name them as disposable to let them go.",
      );
    });

    it("matches a bare name at any depth and keeps a path with a slash anchored at the root", async () => {
      const ref = await ensure();
      await put(
        ref.path,
        "node_modules/a/index.js",
        "packages/app/node_modules/x.js",
        "packages/web/node_modules/y.js",
        "dist/out.js",
        "packages/web/dist/out.js",
      );

      const anchored = await manager.canRemove(ref, {
        runActive: false,
        disposable: ["packages/app/node_modules", "./dist", "node_modules/"],
      });
      const bare = await manager.canRemove(ref, {
        runActive: false,
        disposable: ["packages/app/node_modules", "./dist"],
      });
      const everywhere = await manager.canRemove(ref, {
        runActive: false,
        disposable: ["node_modules", "dist"],
      });

      // "node_modules/" ends in a slash and nothing else, so it is still a bare name.
      expect(anchored).toEqual({
        safe: false,
        discarded: [],
        reason:
          "Removing the worktree would delete 1 ignored entry (packages/web/dist/); name them as disposable to let them go.",
      });
      expect(bare.reason).toBe(
        "Removing the worktree would delete 3 ignored entries (node_modules/, packages/web/dist/, packages/web/node_modules/); name them as disposable to let them go.",
      );
      expect(everywhere).toEqual({
        safe: true,
        discarded: [
          "dist/",
          "node_modules/",
          "packages/app/node_modules/",
          "packages/web/dist/",
          "packages/web/node_modules/",
        ],
      });
      expect(existsSync(join(ref.path, "packages/web/node_modules/y.js"))).toBe(true);
    });

    it("never lets a disposable path cover changed or untracked files", async () => {
      const ref = await ensure();
      await put(ref.path, "notes/todo.md");
      await writeFile(join(ref.path, "README.md"), "changed\n");

      const result = await manager.cleanUp(ref, {
        runActive: false,
        disposable: ["notes", "README.md"],
      });

      expect(result.refusedBecause).toBe(
        "The worktree has 1 changed file and 1 untracked file (README.md, notes/todo.md).",
      );
      expect(existsSync(join(ref.path, "notes/todo.md"))).toBe(true);
    });

    it("refuses a disposable path that leaves the repository", async () => {
      const ref = await ensure();
      for (const path of ["../repo", "/tmp", "a/../../b", ""]) {
        const result = await manager.cleanUp(ref, { runActive: false, disposable: [path] });
        expect(result.refusedBecause).toBe(
          `"${path}" isn't a folder or file inside the repository.`,
        );
      }
      expect(existsSync(ref.path)).toBe(true);
    });
  });

  describe("when the marker can't be written", () => {
    /**
     * A post-checkout hook that writes a marker of its own first, so xatlas's write fails, and
     * then whatever else a hook might leave in the new worktree.
     */
    async function hookThatWrites(...files: string[]): Promise<void> {
      const script = [
        "#!/bin/sh",
        `printf '{}' > "$(git rev-parse --absolute-git-dir)/${MARKER_FILE}"`,
        ...files.map((file) => `printf 'from the hook\\n' > '${file}'`),
        "",
      ].join("\n");
      await writeFile(join(fixture.hooks, "post-checkout"), script, { mode: 0o755 });
    }

    const path = () => join(fixture.root, "t1-claude-r1");

    it("removes the fresh worktree and its branch when nothing else is in it", async () => {
      await hookThatWrites();

      await expect(ensure()).rejects.toThrow(/EEXIST/);

      expect(existsSync(path())).toBe(false);
      expect(await git(fixture.repo, "branch", "--list", branchName(identity))).toBe("");
    });

    it("leaves the worktree and branch when a hook added an untracked file", async () => {
      await hookThatWrites("setup-notes.txt");

      await expect(ensure()).rejects.toThrow(
        `the worktree at ${path()} was left for a person to look at.`,
      );

      expect(existsSync(join(path(), "setup-notes.txt"))).toBe(true);
      expect(await git(fixture.repo, "branch", "--list", branchName(identity))).not.toBe("");
    });

    it("leaves the worktree and branch when a hook added an ignored file", async () => {
      await hookThatWrites(".env");

      await expect(ensure()).rejects.toThrow(/already holds files xatlas didn't make \(\.env\)/);

      expect(await readFile(join(path(), ".env"), "utf8")).toBe("from the hook\n");
      expect(await git(fixture.repo, "branch", "--list", branchName(identity))).not.toBe("");
    });
  });

  /** A worktree as the host makes one: detached at `base`, outside the root xatlas uses. */
  async function hostWorktree(name = "host-made", base = "develop"): Promise<string> {
    const path = join(fixture.dir, "host", name);
    await mkdir(join(fixture.dir, "host"), { recursive: true });
    await git(fixture.repo, "worktree", "add", "-q", "--detach", path, base);
    return path;
  }

  async function writeIn(root: string, file: string, content = `${file}\n`): Promise<void> {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }

  const adopt = (path: string, run: RunIdentity = identity, baseRef?: string) =>
    manager.adopt({
      repoPath: fixture.repo,
      path,
      identity: run,
      ...(baseRef === undefined ? {} : { baseRef }),
    });

  describe("adopting a worktree the host made", () => {
    it("gives a detached worktree the run's branch at its HEAD, and the marker ensure writes", async () => {
      const path = await hostWorktree();
      const developSha = await git(fixture.repo, "rev-parse", "develop");
      // What the host may have put there before handing it over.
      await writeIn(path, ".env", "SECRET=1\n");
      await writeIn(path, "carried.txt");

      const ref = await adopt(path);

      expect(ref).toEqual({
        repoPath: fixture.repo,
        path,
        branch: "xatlas/t1/claude-r1",
        baseSha: developSha,
        identity,
        createdAt: "2026-11-15T10:00:00.000Z",
      });
      expect(await git(path, "symbolic-ref", "HEAD")).toBe("refs/heads/xatlas/t1/claude-r1");
      expect(await git(fixture.repo, "rev-parse", ref.branch)).toBe(developSha);
      const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
      const marker = JSON.parse(await readFile(join(gitDir, MARKER_FILE), "utf8"));
      expect(marker).toEqual({
        version: 1,
        identity,
        branch: ref.branch,
        baseSha: developSha,
        createdAt: ref.createdAt,
      });
      // The files the host left are untouched, and list and missingTrailers take the worktree.
      expect(await readFile(join(path, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(await git(path, "status", "--porcelain", "--untracked-files=all")).toBe(
        "?? carried.txt",
      );
      expect(await manager.list(fixture.repo)).toEqual([ref]);
      const unstamped = await commit(path, "work.txt", "No trailers");
      expect(await manager.missingTrailers(ref)).toEqual([unstamped]);
    });

    it("records the ref the base was taken from", async () => {
      const path = await hostWorktree();
      const ref = await adopt(path, identity, "develop");
      expect(ref.baseRef).toBe("refs/heads/develop");
      expect(await manager.list(fixture.repo)).toEqual([ref]);
    });

    it("returns the same ref when asked again for the same run, and changes nothing", async () => {
      const path = await hostWorktree();
      const first = await adopt(path);
      const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
      const marker = await readFile(join(gitDir, MARKER_FILE), "utf8");
      const later = createWorktreeManager({ now: () => new Date("2030-01-01T00:00:00Z") });

      const again = await later.adopt({ repoPath: fixture.repo, path, identity });
      const together = await Promise.all([adopt(path), adopt(path)]);

      expect(again).toEqual(first);
      expect(together).toEqual([first, first]);
      expect(await readFile(join(gitDir, MARKER_FILE), "utf8")).toBe(marker);
    });

    it("adopts two host worktrees for two runs at once", async () => {
      const [a, b] = await Promise.all([hostWorktree("a"), hostWorktree("b")]);
      const refs = await Promise.all([adopt(a), adopt(b, { ...identity, runId: "r2" })]);
      expect(refs.map((ref) => ref.branch)).toEqual(["xatlas/t1/claude-r1", "xatlas/t1/claude-r2"]);
      expect(await manager.list(fixture.repo)).toHaveLength(2);
    });

    describe("refuses, and leaves things as they were", () => {
      async function expectUntouched(path: string, run: RunIdentity = identity): Promise<void> {
        expect(await git(fixture.repo, "branch", "--list", branchName(run))).toBe("");
        expect((await runner(["symbolic-ref", "-q", "HEAD"], path)).code).toBe(1);
        const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
        expect(existsSync(join(gitDir, MARKER_FILE))).toBe(false);
      }

      it("a worktree already adopted by another run", async () => {
        const path = await hostWorktree();
        await adopt(path);
        await expect(adopt(path, { ...identity, runId: "r2" })).rejects.toThrow(
          `The worktree at ${path} already belongs to run r1 (xatlas/t1/claude-r1); give this run a worktree of its own.`,
        );
        expect(await git(fixture.repo, "branch", "--list", "xatlas/t1/claude-r2")).toBe("");
      });

      it("a worktree that is on a branch", async () => {
        const path = join(fixture.dir, "on-a-branch");
        await git(fixture.repo, "worktree", "add", "-q", "-b", "side", path, "develop");
        await expect(adopt(path)).rejects.toThrow(
          `The worktree at ${path} is on side, not on a detached HEAD as the host leaves it; xatlas won't take over a branch.`,
        );
        expect(await git(fixture.repo, "branch", "--list", branchName(identity))).toBe("");
        expect(await git(path, "symbolic-ref", "HEAD")).toBe("refs/heads/side");
      });

      it("an adopted worktree that has moved to another branch", async () => {
        const path = await hostWorktree();
        await adopt(path);
        await git(path, "switch", "-q", "-c", "side");
        await expect(adopt(path)).rejects.toThrow(
          `The worktree at ${path} was adopted for this run but is now on side; switch it back to xatlas/t1/claude-r1 before going on.`,
        );
      });

      it("a branch name open in another worktree", async () => {
        const ours = await ensure();
        const path = await hostWorktree();
        await expect(adopt(path)).rejects.toThrow(
          `Branch xatlas/t1/claude-r1 is already open in ${ours.path}; finish that worktree or give this run another id.`,
        );
        expect((await runner(["symbolic-ref", "-q", "HEAD"], path)).code).toBe(1);
      });

      it("a branch name that already exists", async () => {
        await git(fixture.repo, "branch", branchName(identity), "main");
        const path = await hostWorktree();
        await expect(adopt(path)).rejects.toThrow(
          "Branch xatlas/t1/claude-r1 already exists; delete it if nothing on it is needed, or give this run another id.",
        );
        expect((await runner(["symbolic-ref", "-q", "HEAD"], path)).code).toBe(1);
      });

      it("a folder that isn't one of the repository's worktrees, or is its main checkout", async () => {
        const elsewhere = join(fixture.dir, "elsewhere");
        await mkdir(elsewhere);
        await expect(adopt(elsewhere)).rejects.toThrow(
          `${elsewhere} isn't a worktree of ${fixture.repo}.`,
        );
        await expect(adopt(fixture.repo)).rejects.toThrow(/is the main checkout of/);
        expect(await git(fixture.repo, "branch", "--list", branchName(identity))).toBe("");
      });

      it("a file in the marker's place that isn't a marker", async () => {
        const path = await hostWorktree();
        const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
        await writeFile(join(gitDir, MARKER_FILE), "{}");
        await expect(adopt(path)).rejects.toThrow(/exists but isn't a marker xatlas can read/);
        expect(await readFile(join(gitDir, MARKER_FILE), "utf8")).toBe("{}");
        expect(await git(fixture.repo, "branch", "--list", branchName(identity))).toBe("");
      });

      it("a base that isn't a branch or tag, or doesn't hold the HEAD", async () => {
        const path = await hostWorktree();
        const sha = await git(fixture.repo, "rev-parse", "develop");
        await expect(adopt(path, identity, sha)).rejects.toThrow(
          `The base "${sha}" isn't a branch or tag in ${fixture.repo}.`,
        );
        await expect(adopt(path, identity, "--all")).rejects.toThrow(/isn't a branch or tag/);
        // A branch that doesn't contain the worktree's commit.
        const side = join(fixture.dir, "side");
        await git(fixture.repo, "worktree", "add", "-q", "-b", "elsewhere", side, "develop");
        await git(side, "checkout", "-q", "--orphan", "unrelated");
        await commit(side, "other.txt", "Unrelated history");
        await expect(adopt(path, identity, "unrelated")).rejects.toThrow(
          `isn't on refs/heads/unrelated, so that can't be its base.`,
        );
        await expectUntouched(path);
      });

      it("an invalid identity", async () => {
        const path = await hostWorktree();
        await expect(adopt(path, { ...identity, runId: "../x" })).rejects.toThrow(
          /Invalid run identity/,
        );
        await expectUntouched(path);
      });

      describe("when a step fails half-way", () => {
        /** The real git, except `symbolic-ref HEAD` runs `instead` of itself. */
        function managerWhere(
          instead: (args: readonly string[], cwd: string) => ReturnType<typeof runner>,
        ): WorktreeManager {
          return createWorktreeManager({
            git: (args, cwd) =>
              args[0] === "symbolic-ref" && args.includes("HEAD") && !args.includes("-q")
                ? instead(args, cwd)
                : runner(args, cwd),
          });
        }

        it("deletes the new branch when the worktree can't be switched to it", async () => {
          const path = await hostWorktree();
          const failing = managerWhere(async () => ({ code: 1, stdout: "", stderr: "no way" }));

          await expect(failing.adopt({ repoPath: fixture.repo, path, identity })).rejects.toThrow(
            `Couldn't adopt the worktree at ${path} (Couldn't switch to xatlas/t1/claude-r1 for ${path}: no way); it was left detached as before.`,
          );
          await expectUntouched(path);
        });

        it("detaches the worktree again and deletes the branch when the marker can't be written", async () => {
          const path = await hostWorktree();
          const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
          // Something takes the marker's place between the switch and the write.
          const racing = managerWhere(async (args, cwd) => {
            const result = await runner(args, cwd);
            await mkdir(join(gitDir, MARKER_FILE));
            return result;
          });

          await expect(racing.adopt({ repoPath: fixture.repo, path, identity })).rejects.toThrow(
            /EEXIST.*it was left detached as before\.$/,
          );
          expect(await git(fixture.repo, "branch", "--list", branchName(identity))).toBe("");
          expect((await runner(["symbolic-ref", "-q", "HEAD"], path)).code).toBe(1);
          expect(await git(path, "rev-parse", "HEAD")).toBe(
            await git(fixture.repo, "rev-parse", "develop"),
          );

          // Once the way is clear, adopting works.
          await rm(join(gitDir, MARKER_FILE), { recursive: true });
          expect((await adopt(path)).branch).toBe(branchName(identity));
        });

        it("leaves the worktree as it is when another run marked it while this one was adopting", async () => {
          const path = await hostWorktree();
          const gitDir = await git(path, "rev-parse", "--absolute-git-dir");
          const other: RunIdentity = { ...identity, runId: "r9" };
          const theirs = JSON.stringify({
            version: 1,
            identity: other,
            branch: branchName(other),
            baseSha: await git(fixture.repo, "rev-parse", "develop"),
            createdAt: "2026-11-15T10:00:00.000Z",
          });
          const racing = managerWhere(async (args, cwd) => {
            const result = await runner(args, cwd);
            await writeFile(join(gitDir, MARKER_FILE), theirs);
            return result;
          });

          await expect(racing.adopt({ repoPath: fixture.repo, path, identity })).rejects.toThrow(
            /EEXIST.*its HEAD stays on xatlas\/t1\/claude-r1 because run r9 has marked it/,
          );
          // Nothing this call can't vouch for was undone.
          expect(await git(path, "symbolic-ref", "HEAD")).toBe(
            `refs/heads/${branchName(identity)}`,
          );
          expect(await readFile(join(gitDir, MARKER_FILE), "utf8")).toBe(theirs);
          expect(await git(fixture.repo, "branch", "--list", branchName(identity))).not.toBe("");
        });
      });

      it("lets exactly one of two runs racing for the same worktree win", async () => {
        const path = await hostWorktree();
        // The first call stops just before it makes its branch, until `go`.
        let go!: () => void;
        const gate = new Promise<void>((resolve) => (go = resolve));
        let stopped!: () => void;
        const reached = new Promise<void>((resolve) => (stopped = resolve));
        let used = false;
        const pausing = createWorktreeManager({
          now: () => new Date("2026-11-15T10:00:00Z"),
          git: async (args, cwd) => {
            if (!used && args[0] === "update-ref" && args.at(-1) === "") {
              used = true;
              stopped();
              await gate;
            }
            return runner(args, cwd);
          },
        });
        const second: RunIdentity = { ...identity, runId: "r2" };

        const first = pausing.adopt({ repoPath: fixture.repo, path, identity });
        await reached;
        const other = pausing.adopt({ repoPath: fixture.repo, path, identity: second });
        await new Promise((resolve) => setTimeout(resolve, 300));
        go();
        const results = await Promise.allSettled([first, other]);

        const won = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const lost = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        expect(won).toHaveLength(1);
        expect(String(lost[0])).toMatch(/already belongs to run/);
        const winner = won[0]!;
        const loser = winner.identity.runId === "r1" ? second : identity;
        expect(await git(path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${winner.branch}`);
        expect(await git(fixture.repo, "branch", "--list", branchName(loser))).toBe("");
        expect(await manager.list(fixture.repo)).toEqual([winner]);
      });
    });
  });

  describe("canRemove", () => {
    /**
     * The main checkout names `.env` and `config/local/` in `.worktreeinclude`. Both, and the
     * include file itself, are ignored through info/exclude, which every worktree shares, so the
     * main checkout's status stays as the snapshot has it.
     */
    async function withInclude(): Promise<void> {
      await writeFile(
        join(fixture.repo, ".git", "info", "exclude"),
        ".worktreeinclude\nconfig/local/\n",
      );
      await writeIn(fixture.repo, ".worktreeinclude", ".env\nconfig/local/\n");
      await writeIn(fixture.repo, ".env", "SECRET=1\n");
      await writeIn(fixture.repo, "config/local/settings.json", "{}\n");
      await writeIn(fixture.repo, "config/local/keys/a.json", '{"a":1}\n');
      // Ignored but not named in .worktreeinclude: the host doesn't copy it.
      await writeIn(fixture.repo, "debug.log", "main's log\n");
    }

    /**
     * Copies what the host copies, found the way the host finds it. The host passes `-z` to
     * `check-ignore` without `--stdin`, which git refuses; this reads its answer line by line.
     */
    async function copyLikeTheHost(worktree: string): Promise<string[]> {
      const listed = (
        await git(
          fixture.repo,
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-from=.worktreeinclude",
          "-z",
        )
      )
        .split("\0")
        .filter(Boolean);
      const ignored = (await git(fixture.repo, "check-ignore", "--", ...listed))
        .split("\n")
        .filter(Boolean);
      for (const file of ignored) {
        await writeIn(worktree, file, await readFile(join(fixture.repo, file), "utf8"));
      }
      return ignored.sort();
    }

    async function adoptedWithCopies(): Promise<WorktreeRef> {
      await withInclude();
      const path = await hostWorktree();
      expect(await copyLikeTheHost(path)).toEqual([
        ".env",
        "config/local/keys/a.json",
        "config/local/settings.json",
      ]);
      return adopt(path, identity, "develop");
    }

    it("lets copies the host made go, and removes nothing itself", async () => {
      const ref = await adoptedWithCopies();

      const check = await manager.canRemove(ref, { runActive: false });

      expect(check).toEqual({ safe: true, discarded: [".env", "config/local/"] });
      expect(existsSync(join(ref.path, "config/local/keys/a.json"))).toBe(true);
      expect(await manager.list(fixture.repo)).toEqual([ref]);

      const result = await manager.cleanUp(ref, { runActive: false, deleteBranch: true });
      expect(result).toEqual({
        removed: true,
        branchDeleted: true,
        discarded: [".env", "config/local/"],
      });
      expect(existsSync(ref.path)).toBe(false);
      // The originals in the main checkout stay.
      expect(await readFile(join(fixture.repo, ".env"), "utf8")).toBe("SECRET=1\n");
    });

    it("stops at a copy that has changed, and names it", async () => {
      const ref = await adoptedWithCopies();
      await writeIn(ref.path, ".env", "SECRET=2\n");

      const check = await manager.canRemove(ref, { runActive: false });
      const cleanUp = await manager.cleanUp(ref, { runActive: false });

      expect(check).toEqual({
        safe: false,
        discarded: [],
        reason:
          "Removing the worktree would delete 1 ignored entry (.env); .env matches .worktreeinclude but isn't the same as in the main checkout; name them as disposable to let them go.",
      });
      expect(cleanUp.refusedBecause).toBe(check.reason);
      expect(await readFile(join(ref.path, ".env"), "utf8")).toBe("SECRET=2\n");
    });

    it("stops at a copied-in folder holding a file the main checkout doesn't have", async () => {
      const ref = await adoptedWithCopies();
      await writeIn(ref.path, "config/local/keys/b.json");
      await writeFile(join(fixture.repo, "config/local/settings.json"), '{"changed":true}\n');

      const check = await manager.canRemove(ref, { runActive: false });

      expect(check.reason).toBe(
        "Removing the worktree would delete 1 ignored entry (config/local/); config/local/keys/b.json, config/local/settings.json match .worktreeinclude but aren't the same as in the main checkout; name them as disposable to let them go.",
      );
    });

    it("stops at a copy whose original is gone, and at ignored files .worktreeinclude doesn't name", async () => {
      const ref = await adoptedWithCopies();
      await rm(join(fixture.repo, ".env"));
      // The same bytes as the main checkout's, but the host never copies a .log file.
      await writeIn(ref.path, "debug.log", "main's log\n");

      const check = await manager.canRemove(ref, { runActive: false });

      expect(check.reason).toBe(
        "Removing the worktree would delete 2 ignored entries (.env, debug.log); .env matches .worktreeinclude but isn't the same as in the main checkout; name them as disposable to let them go.",
      );
      await writeIn(fixture.repo, ".env", "SECRET=1\n");
    });

    it("lets a dependency folder inside a copied-in folder go, without walking into it", async () => {
      const ref = await adoptedWithCopies();
      await writeIn(ref.path, "config/local/node_modules/pkg/index.js");

      expect((await manager.canRemove(ref, { runActive: false })).reason).toBe(
        "Removing the worktree would delete 1 ignored entry (config/local/); config/local/node_modules/pkg/index.js matches .worktreeinclude but isn't the same as in the main checkout; name them as disposable to let them go.",
      );
      // A folder that can't be read shows it is never walked.
      const modules = join(ref.path, "config/local/node_modules");
      await chmod(modules, 0o000);
      try {
        expect(
          await manager.canRemove(ref, { runActive: false, disposable: ["node_modules"] }),
        ).toEqual({ safe: true, discarded: [".env", "config/local/"] });
      } finally {
        await chmod(modules, 0o755);
      }
    });

    it("lets copies and nested dependency folders go together", async () => {
      const ref = await adoptedWithCopies();
      await writeIn(ref.path, "node_modules/a/index.js");
      await writeIn(ref.path, "packages/app/node_modules/b/index.js");

      expect(await manager.canRemove(ref, { runActive: false })).toMatchObject({ safe: false });
      expect(
        await manager.canRemove(ref, { runActive: false, disposable: ["node_modules"] }),
      ).toEqual({
        safe: true,
        discarded: [".env", "config/local/", "node_modules/", "packages/app/node_modules/"],
      });
    });

    it("never lets a copy excuse an untracked file", async () => {
      const ref = await adoptedWithCopies();
      await writeIn(ref.path, "notes.md");
      expect(await manager.canRemove(ref, { runActive: false })).toEqual({
        safe: false,
        discarded: [],
        reason: "The worktree has 0 changed files and 1 untracked file (notes.md).",
      });
    });

    it("gives the same answers cleanUp gives", async () => {
      const ref = await ensure();
      expect(await manager.canRemove(ref, { runActive: true })).toEqual({
        safe: false,
        discarded: [],
        reason: "The run is still active.",
      });
      const sha = await commit(ref.path, "work.txt", withTrailers("Work", identity));
      const check = await manager.canRemove(ref, { runActive: false });
      expect(check.reason).toMatch(`(${sha.slice(0, 12)})`);
      expect((await manager.cleanUp(ref, { runActive: false })).refusedBecause).toBe(check.reason);
      expect(await manager.canRemove({ ...ref, path: fixture.repo }, { runActive: false })).toEqual(
        {
          safe: false,
          discarded: [],
          reason: "That is the repository's main checkout, which is never removed.",
        },
      );
    });
  });
});
