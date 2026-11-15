import { normalizeOwnedPath } from "../division/index.js";
import type { LedgerData } from "../types.js";

/**
 * The checks the host makes in code when a run's turn ends. No model is asked: the loop
 * gathers the facts (git status, the new commits, the reviewer's verdict) and records what
 * comes back here as `oversight.flagged` entries.
 */

export type OversightFlag = LedgerData["oversight.flagged"];

/** A reviewer that passes more changed lines than this with no finding at all is flagged. */
export const EMPTY_REVIEW_LINES = 400;

/** The most paths named in a flag's `detail`; `paths` always has them all. */
const PATHS_IN_DETAIL = 5;

export type TurnEnd =
  | {
      readonly role: "executor";
      /** What the step owns; empty means the whole repository. */
      readonly owns: readonly string[];
      /** Every path the turn changed, committed or not. */
      readonly changedPaths: readonly string[];
      readonly newCommits: number;
      /** Paths changed in the worktree and not committed when the turn ended. */
      readonly uncommittedPaths: readonly string[];
      readonly commitsMissingTrailers: number;
    }
  | {
      readonly role: "reviewer";
      readonly verdict: "pass" | "findings";
      readonly findings: number;
      readonly changedLines: number;
    };

/**
 * Whether a changed path sits inside one of the owned paths: the same path, or under it on a
 * folder boundary. Case is ignored, as in `pathsCollide`. Unlike that test this is one way: a
 * changed path that names a folder above what is owned, or climbs out of the repository, is
 * outside.
 */
function inside(path: string, owns: readonly string[]): boolean {
  if (owns.length === 0) return true;
  const changed = normalizeOwnedPath(path).toLowerCase();
  return owns.some((own) => {
    const owned = normalizeOwnedPath(own).toLowerCase();
    if (owned === "") return true;
    return changed !== "" && (changed === owned || changed.startsWith(`${owned}/`));
  });
}

/** The changed paths outside what a step owns, once each, in the order given. */
export function outsideOwns(owns: readonly string[], paths: readonly string[]): string[] {
  const outside = new Set<string>();
  for (const path of paths) {
    if (path.trim() !== "" && !inside(path, owns)) outside.add(path.trim());
  }
  return [...outside];
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, PATHS_IN_DETAIL).join(", ");
  const more = paths.length - PATHS_IN_DETAIL;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * The flags to record for a turn that just ended; empty when nothing is wrong. An executor that
 * changed a path outside what its step owns (committed or not) is paused; a turn with no new
 * commit is flagged; a reviewer that passed more than `EMPTY_REVIEW_LINES` changed lines with
 * no finding is flagged. Missing trailers are not a flag: `reminderFor` words the reminder.
 */
export function turnEndFlags(input: TurnEnd): OversightFlag[] {
  const flags: OversightFlag[] = [];
  if (input.role === "reviewer") {
    if (
      input.verdict === "pass" &&
      input.findings === 0 &&
      input.changedLines > EMPTY_REVIEW_LINES
    ) {
      flags.push({
        check: "empty-review",
        action: "flagged",
        detail: `The reviewer passed ${count(input.changedLines, "changed line")} with no finding at all.`,
      });
    }
    return flags;
  }

  const outside = outsideOwns(input.owns, [...input.changedPaths, ...input.uncommittedPaths]);
  if (outside.length > 0) {
    flags.push({
      check: "outside-owns",
      action: "paused",
      detail: `The run changed ${count(outside.length, "path")} outside what its step owns (${input.owns.join(", ")}): ${listed(outside)}.`,
      paths: outside,
    });
  }
  if (!(input.newCommits > 0)) {
    const left = input.uncommittedPaths.length;
    flags.push({
      check: "no-commit",
      action: "flagged",
      detail:
        left > 0
          ? `The turn ended with nothing committed; ${count(left, "path is", "paths are")} changed but not committed.`
          : "The turn ended with nothing committed.",
    });
  }
  return flags;
}

/**
 * The one reminder an executor gets when its turn ended with nothing committed or with commits
 * that lack the run's trailers; `undefined` when neither. `trailers` are the lines every commit
 * must end with. Sending it only once is the loop's job.
 */
export function reminderFor(input: {
  readonly newCommits: number;
  readonly commitsMissingTrailers: number;
  readonly uncommittedPaths?: readonly string[];
  readonly trailers?: readonly string[];
}): string | undefined {
  const noCommit = !(input.newCommits > 0);
  const missing = input.commitsMissingTrailers > 0 ? input.commitsMissingTrailers : 0;
  if (!noCommit && missing === 0) return undefined;

  const trailers = (input.trailers ?? []).map((line) => line.trim()).filter(Boolean);
  const lines: string[] = [];
  if (noCommit) {
    const left = input.uncommittedPaths?.length ?? 0;
    lines.push(
      left > 0
        ? `Your turn ended with nothing committed, and ${count(left, "path is", "paths are")} changed but not committed. Commit your work on this branch before you finish.`
        : "Your turn ended with nothing committed. Commit your work on this branch before you finish.",
    );
  }
  if (missing > 0) {
    lines.push(
      `${missing === 1 ? "One of your commits does" : `${missing} of your commits do`} not end with the run's trailers. Add them to ${missing === 1 ? "that commit" : "those commits"} without changing anything else.`,
    );
  }
  if (trailers.length > 0) {
    lines.push("", "Every commit on this branch must end with these lines:", ...trailers);
  } else {
    lines.push("Every commit on this branch must end with the run's trailers.");
  }
  return lines.join("\n");
}
