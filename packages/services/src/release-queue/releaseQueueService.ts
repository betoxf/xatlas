import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  analyzeReleaseQueue,
  parseReleaseMigration,
  type ReleaseQueueChecksState,
  type ReleaseQueuePullRequest,
  type ReleaseQueueReviewDecision,
} from "@zcode/shared";
import type {
  IReleaseQueueService,
  ReleaseQueueResult,
  ReleaseQueueUnavailableReason,
  ReleaseTrainOutcome,
} from "./releaseQueue.js";
import { createGitRunner, runMergeTrain, type GitRunner } from "./mergeTrain.js";

/** Runs `gh` with `args` in `cwd` and returns stdout. */
export type GhRunner = (args: readonly string[], cwd: string) => Promise<string>;

const PULL_REQUEST_FIELDS = [
  "number",
  "title",
  "url",
  "headRefName",
  "baseRefName",
  "author",
  "isDraft",
  "updatedAt",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "statusCheckRollup",
  "files",
  "additions",
  "deletions",
].join(",");

/** Where gh usually lives on macOS when the app's PATH is minimal. */
const GH_FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function resolveGhBinary(): string {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...GH_FALLBACK_DIRS];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, "gh"))) {
      return join(dir, "gh");
    }
  }
  return "gh";
}

function createGhRunner(): GhRunner {
  const gh = resolveGhBinary();
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        gh,
        args,
        {
          cwd,
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
          // A sandboxed dev run moves HOME; gh's login (and keychain) stay in the real one.
          env: process.env.XATLAS_GH_HOME
            ? { ...process.env, HOME: process.env.XATLAS_GH_HOME }
            : process.env,
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

function classifyGhError(error: unknown): { reason: ReleaseQueueUnavailableReason; message: string } {
  const code = (error as { code?: unknown })?.code;
  const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
  const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
  if (code === "ENOENT") {
    return { reason: "gh-missing", message: "GitHub CLI (gh) isn't installed." };
  }
  if (/gh auth login|not logged in|authentication/i.test(stderr)) {
    return { reason: "gh-signed-out", message: "GitHub CLI isn't signed in (run `gh auth login`)." };
  }
  if (/no git remotes|none of the git remotes|not a git repository|could not determine/i.test(stderr)) {
    return { reason: "no-github-repository", message: "This project has no GitHub repository." };
  }
  return { reason: "failed", message };
}

interface RawCheck {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"]);

/** Collapses GitHub's check runs and commit statuses into one state. */
export function summarizeChecks(rollup: readonly RawCheck[] | null | undefined): {
  state: ReleaseQueueChecksState;
  failing: string[];
} {
  const checks = rollup ?? [];
  if (checks.length === 0) {
    return { state: "none", failing: [] };
  }
  const failing = checks
    .filter((check) => FAILED.has(check.conclusion ?? "") || FAILED.has(check.state ?? ""))
    .map((check) => check.name ?? check.context ?? "check");
  if (failing.length > 0) {
    return { state: "failure", failing };
  }
  const pending = checks.some(
    (check) =>
      PENDING.has(check.status ?? "") ||
      PENDING.has(check.state ?? "") ||
      (check.__typename === "CheckRun" && check.status !== "COMPLETED"),
  );
  return { state: pending ? "pending" : "success", failing: [] };
}

interface RawPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly author?: { readonly login?: string } | null;
  readonly isDraft: boolean;
  readonly updatedAt: string;
  readonly mergeable?: string;
  readonly mergeStateStatus?: string;
  readonly reviewDecision?: string | null;
  readonly statusCheckRollup?: readonly RawCheck[] | null;
  readonly files?: readonly { readonly path: string }[] | null;
  readonly additions?: number;
  readonly deletions?: number;
}

function toPullRequest(raw: RawPullRequest): ReleaseQueuePullRequest {
  const mergeable = raw.mergeable === "MERGEABLE" || raw.mergeable === "CONFLICTING" ? raw.mergeable : "UNKNOWN";
  const review = raw.reviewDecision;
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    branch: raw.headRefName,
    baseBranch: raw.baseRefName,
    author: raw.author?.login ?? "",
    isDraft: raw.isDraft,
    updatedAt: raw.updatedAt,
    mergeable,
    mergeState: raw.mergeStateStatus ?? "UNKNOWN",
    reviewDecision:
      review === "APPROVED" || review === "CHANGES_REQUESTED" || review === "REVIEW_REQUIRED"
        ? (review as ReleaseQueueReviewDecision)
        : null,
    checks: summarizeChecks(raw.statusCheckRollup),
    files: (raw.files ?? []).map((file) => file.path),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
  };
}

export function createReleaseQueueService(options?: {
  runGh?: GhRunner;
  runGit?: GitRunner;
  now?: () => Date;
}): IReleaseQueueService {
  const runGh = options?.runGh ?? createGhRunner();
  const runGit = options?.runGit ?? createGitRunner();
  const now = options?.now ?? (() => new Date());
  /** One train per repository at a time; a second request joins the first. */
  const trains = new Map<string, Promise<ReleaseTrainOutcome>>();

  async function readBaseMigrations(
    cwd: string,
    repository: string,
    baseBranch: string,
    directories: readonly string[],
  ): Promise<Record<string, number[]>> {
    const entries = await Promise.all(
      directories.map(async (directory) => {
        try {
          const names = await runGh(
            [
              "api",
              `repos/${repository}/contents/${directory}?ref=${encodeURIComponent(baseBranch)}`,
              "--jq",
              ".[].name",
            ],
            cwd,
          );
          const numbers = names
            .split("\n")
            .map((name) => parseReleaseMigration(`${directory}/${name.trim()}`)?.number)
            .filter((number): number is number => number !== undefined);
          return [directory, numbers] as const;
        } catch {
          return [directory, []] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  return {
    async getQueue({ workspacePath }): Promise<ReleaseQueueResult> {
      try {
        const repo = JSON.parse(
          await runGh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], workspacePath),
        ) as { nameWithOwner: string; defaultBranchRef?: { name?: string } | null };
        const baseBranch = repo.defaultBranchRef?.name || "main";
        const rawPullRequests = JSON.parse(
          await runGh(
            ["pr", "list", "--state", "open", "--limit", "100", "--json", PULL_REQUEST_FIELDS],
            workspacePath,
          ),
        ) as RawPullRequest[];
        const pullRequests = rawPullRequests.map(toPullRequest);
        const directories = [
          ...new Set(
            pullRequests.flatMap((pullRequest) =>
              pullRequest.files.flatMap((file) => parseReleaseMigration(file)?.directory ?? []),
            ),
          ),
        ];
        const snapshot = {
          repository: repo.nameWithOwner,
          baseBranch,
          fetchedAt: now().toISOString(),
          baseMigrations: await readBaseMigrations(
            workspacePath,
            repo.nameWithOwner,
            baseBranch,
            directories,
          ),
          pullRequests,
        };
        return { status: "ok", snapshot, analysis: analyzeReleaseQueue(snapshot) };
      } catch (error) {
        return { status: "unavailable", ...classifyGhError(error) };
      }
    },

    checkMergeTrain({ workspacePath, baseBranch, order }) {
      const key = `${workspacePath}\u0000${baseBranch}\u0000${order.join(",")}`;
      const running = trains.get(key);
      if (running) {
        return running;
      }
      const train = runMergeTrain(runGit, workspacePath, baseBranch, order, now)
        .then((result): ReleaseTrainOutcome => ({ status: "ok", train: result }))
        .catch(
          (error: unknown): ReleaseTrainOutcome => ({
            status: "unavailable",
            message: String((error as { stderr?: unknown })?.stderr || (error as Error)?.message || error),
          }),
        )
        .finally(() => trains.delete(key));
      trains.set(key, train);
      return train;
    },
  };
}
