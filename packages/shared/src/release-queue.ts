/**
 * Release queue: a repository's open pull requests, analysed for shipping.
 *
 * The analysis is pure so it can run anywhere (host, UI, tests): it sorts pull
 * requests into lanes, finds what blocks each one (conflicts, failing checks,
 * migrations that collide), and plans which ready pull requests can ship
 * together, in which order, renumbering migrations so they stay sequential.
 */

export type ReleaseQueueMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type ReleaseQueueChecksState = "success" | "failure" | "pending" | "none";
export type ReleaseQueueReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface ReleaseQueuePullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly author: string;
  readonly isDraft: boolean;
  readonly updatedAt: string;
  readonly mergeable: ReleaseQueueMergeable;
  /** GitHub's mergeStateStatus: CLEAN, BEHIND, DIRTY, BLOCKED, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  readonly mergeState: string;
  readonly reviewDecision: ReleaseQueueReviewDecision | null;
  readonly checks: { readonly state: ReleaseQueueChecksState; readonly failing: readonly string[] };
  readonly files: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

export interface ReleaseQueueSnapshot {
  /** owner/name */
  readonly repository: string;
  readonly baseBranch: string;
  readonly fetchedAt: string;
  /** Migration numbers already on the base branch, keyed by migration directory. */
  readonly baseMigrations: Readonly<Record<string, readonly number[]>>;
  readonly pullRequests: readonly ReleaseQueuePullRequest[];
}

export type ReleaseLane = "ready" | "fix" | "waiting" | "draft";

export type ReleaseIssueKind =
  | "conflicts"
  | "behind"
  | "checks-failing"
  | "checks-pending"
  | "changes-requested"
  | "review-required"
  | "mergeability-unknown"
  | "migration-taken"
  | "migration-duplicate"
  | "file-overlap";

export interface ReleaseIssue {
  readonly kind: ReleaseIssueKind;
  /** Must be fixed before this pull request can ship (otherwise a heads-up). */
  readonly blocking: boolean;
  /** Short, plain detail for the UI (numbers, check names, files). */
  readonly detail: string;
  readonly relatedPullRequests: readonly number[];
}

export interface ReleaseMigration {
  readonly file: string;
  readonly directory: string;
  readonly number: number;
}

export interface ReleaseQueueItem {
  readonly pullRequest: ReleaseQueuePullRequest;
  readonly lane: ReleaseLane;
  readonly issues: readonly ReleaseIssue[];
  readonly migrations: readonly ReleaseMigration[];
}

export interface ReleaseRenumber {
  readonly pullRequest: number;
  readonly file: string;
  readonly from: number;
  readonly to: number;
}

export interface ReleaseShipPlan {
  /** Ready pull requests, in the order to merge them. */
  readonly order: readonly number[];
  /** Migrations to renumber (before merging) so numbers stay sequential. */
  readonly renumbers: readonly ReleaseRenumber[];
  /**
   * Ready pairs that edit the same files. Git often merges these cleanly, so
   * they're risks to check (see the merge train), not holds.
   */
  readonly overlaps: readonly {
    readonly pullRequests: readonly [number, number];
    readonly files: readonly string[];
  }[];
}

/** Result of merging the plan, in order, onto the latest base in a scratch worktree. */
export interface ReleaseTrainResult {
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly checkedAt: string;
  readonly steps: readonly {
    readonly pullRequest: number;
    readonly status: "merged" | "conflict" | "unavailable";
    /** Files that conflicted against the train so far. */
    readonly conflictFiles: readonly string[];
  }[];
}

export interface ReleaseQueueAnalysis {
  readonly items: readonly ReleaseQueueItem[];
  readonly plan: ReleaseShipPlan;
}

/** `<…/drizzle|migrations>/<digits>_<name>.sql` (Drizzle, D1, plain SQL migrations). */
const MIGRATION_FILE = /^(?<dir>(?:[^/]+\/)*(?:drizzle|migrations))\/(?<num>\d{3,6})_[^/]+\.sql$/;
/** Files regenerated alongside migrations; overlaps on them are resolved by renumbering. */
const MIGRATION_JOURNAL = /(?:^|\/)meta\/_journal\.json$/;

export function parseReleaseMigration(file: string): ReleaseMigration | null {
  const match = MIGRATION_FILE.exec(file);
  if (!match?.groups) {
    return null;
  }
  return { file, directory: match.groups.dir!, number: Number(match.groups.num) };
}

function isMigrationBookkeeping(file: string): boolean {
  return MIGRATION_JOURNAL.test(file) || parseReleaseMigration(file) !== null;
}

function padLike(number: number, like: string): string {
  const digits = /^\d+/.exec(like.split("/").pop() ?? "")?.[0].length ?? 4;
  return String(number).padStart(digits, "0");
}

function describeFiles(files: readonly string[]): string {
  const names = files.slice(0, 2).map((file) => file.split("/").pop());
  return files.length > 2 ? `${names.join(", ")} +${files.length - 2}` : names.join(", ");
}

/** Per pull request: what blocks it, from its own state and against the others. */
function collectIssues(
  pullRequest: ReleaseQueuePullRequest,
  migrations: readonly ReleaseMigration[],
  others: readonly { pullRequest: ReleaseQueuePullRequest; migrations: readonly ReleaseMigration[] }[],
  baseMigrations: ReleaseQueueSnapshot["baseMigrations"],
): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];
  const issue = (
    kind: ReleaseIssueKind,
    blocking: boolean,
    detail: string,
    relatedPullRequests: readonly number[] = [],
  ) => issues.push({ kind, blocking, detail, relatedPullRequests });

  if (pullRequest.mergeable === "CONFLICTING" || pullRequest.mergeState === "DIRTY") {
    issue("conflicts", true, `Conflicts with ${pullRequest.baseBranch}`);
  } else if (pullRequest.mergeState === "BEHIND") {
    issue("behind", false, `Behind ${pullRequest.baseBranch}`);
  } else if (pullRequest.mergeable === "UNKNOWN") {
    issue("mergeability-unknown", false, "GitHub is still checking mergeability");
  }
  if (pullRequest.checks.state === "failure") {
    issue("checks-failing", true, pullRequest.checks.failing.join(", ") || "Checks failing");
  } else if (pullRequest.checks.state === "pending") {
    issue("checks-pending", false, "Checks running");
  }
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") {
    issue("changes-requested", true, "Changes requested");
  } else if (pullRequest.reviewDecision === "REVIEW_REQUIRED") {
    issue("review-required", false, "Review required");
  }

  for (const migration of migrations) {
    const taken = baseMigrations[migration.directory] ?? [];
    if (taken.includes(migration.number)) {
      issue(
        "migration-taken",
        true,
        `${padLike(migration.number, migration.file)} already exists on ${pullRequest.baseBranch}`,
      );
    }
    const clashing = others
      .filter((other) =>
        other.migrations.some(
          (theirs) =>
            theirs.directory === migration.directory && theirs.number === migration.number,
        ),
      )
      .map((other) => other.pullRequest.number);
    if (clashing.length > 0) {
      issue(
        "migration-duplicate",
        false,
        `${padLike(migration.number, migration.file)} also used by ${clashing.map((n) => `#${n}`).join(", ")}`,
        clashing,
      );
    }
  }

  const ownFiles = new Set(pullRequest.files.filter((file) => !isMigrationBookkeeping(file)));
  for (const other of others) {
    if (other.pullRequest.isDraft) {
      continue;
    }
    const shared = other.pullRequest.files.filter((file) => ownFiles.has(file));
    if (shared.length > 0) {
      issue("file-overlap", false, `Edits ${describeFiles(shared)} like #${other.pullRequest.number}`, [
        other.pullRequest.number,
      ]);
    }
  }
  return issues;
}

function laneFor(pullRequest: ReleaseQueuePullRequest, issues: readonly ReleaseIssue[]): ReleaseLane {
  if (pullRequest.isDraft) {
    return "draft";
  }
  if (issues.some((issue) => issue.blocking)) {
    return "fix";
  }
  if (
    issues.some(
      (issue) => issue.kind === "checks-pending" || issue.kind === "mergeability-unknown",
    ) ||
    pullRequest.mergeState === "BLOCKED"
  ) {
    return "waiting";
  }
  return "ready";
}

/**
 * Ready pull requests in merge order: those with migrations first, in their
 * current migration order (fewest renumbers), then the rest, oldest first.
 * Migrations are renumbered to follow the base branch sequentially; pairs
 * that edit the same files are listed as overlaps to check.
 */
function planShipment(
  items: readonly ReleaseQueueItem[],
  baseMigrations: ReleaseQueueSnapshot["baseMigrations"],
): ReleaseShipPlan {
  const lowestMigration = (item: ReleaseQueueItem) =>
    Math.min(Infinity, ...item.migrations.map((migration) => migration.number));
  const ready = items
    .filter((item) => item.lane === "ready")
    .sort(
      (a, b) =>
        lowestMigration(a) - lowestMigration(b) || a.pullRequest.number - b.pullRequest.number,
    );

  const renumbers: ReleaseRenumber[] = [];
  const nextNumber = new Map<string, number>();
  const nextFor = (directory: string) =>
    nextNumber.get(directory) ?? Math.max(0, ...(baseMigrations[directory] ?? [])) + 1;
  for (const item of ready) {
    for (const migration of [...item.migrations].sort((a, b) => a.number - b.number)) {
      const to = nextFor(migration.directory);
      nextNumber.set(migration.directory, to + 1);
      if (to !== migration.number) {
        renumbers.push({
          pullRequest: item.pullRequest.number,
          file: migration.file,
          from: migration.number,
          to,
        });
      }
    }
  }

  const overlaps: { pullRequests: readonly [number, number]; files: string[] }[] = [];
  ready.forEach((item, index) => {
    const files = new Set(item.pullRequest.files.filter((file) => !isMigrationBookkeeping(file)));
    for (const later of ready.slice(index + 1)) {
      const shared = later.pullRequest.files.filter((file) => files.has(file));
      if (shared.length > 0) {
        overlaps.push({ pullRequests: [item.pullRequest.number, later.pullRequest.number], files: shared });
      }
    }
  });
  return { order: ready.map((item) => item.pullRequest.number), renumbers, overlaps };
}

export function analyzeReleaseQueue(snapshot: ReleaseQueueSnapshot): ReleaseQueueAnalysis {
  const withMigrations = snapshot.pullRequests.map((pullRequest) => ({
    pullRequest,
    migrations: pullRequest.files
      .map(parseReleaseMigration)
      .filter((migration): migration is ReleaseMigration => migration !== null),
  }));
  const items = withMigrations.map(({ pullRequest, migrations }) => {
    const others = withMigrations.filter((other) => other.pullRequest !== pullRequest);
    const issues = collectIssues(pullRequest, migrations, others, snapshot.baseMigrations);
    return { pullRequest, lane: laneFor(pullRequest, issues), issues, migrations };
  });
  return { items, plan: planShipment(items, snapshot.baseMigrations) };
}

/** Migration number as the repository writes it (e.g. 254 in `0254_x.sql` → "0254"). */
export function formatReleaseMigrationNumber(migration: { number: number; file: string }): string {
  return padLike(migration.number, migration.file);
}
