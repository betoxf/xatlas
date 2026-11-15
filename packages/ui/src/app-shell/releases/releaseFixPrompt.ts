import {
  formatReleaseMigrationNumber,
  type ReleaseQueueItem,
  type ReleaseQueueSnapshot,
  type ReleaseRenumber,
} from "@zcode/shared";

/** What the merge train found for one pull request, if it was checked. */
export interface ReleaseTrainFinding {
  readonly conflictFiles: readonly string[];
  /** Pull requests merged ahead of it in the train. */
  readonly mergedBefore: readonly number[];
}

/**
 * A ready-to-send brief for an agent to get one pull request shippable:
 * what's wrong, then the steps, without merging or deploying anything.
 */
export function buildReleaseFixPrompt(input: {
  readonly snapshot: Pick<ReleaseQueueSnapshot, "repository" | "baseBranch">;
  readonly item: ReleaseQueueItem;
  readonly renumbers: readonly ReleaseRenumber[];
  readonly train?: ReleaseTrainFinding;
}): string {
  const { snapshot, item, renumbers, train } = input;
  const pr = item.pullRequest;
  const problems: string[] = [];

  for (const issue of item.issues) {
    switch (issue.kind) {
      case "conflicts":
        problems.push(`It conflicts with \`${snapshot.baseBranch}\`.`);
        break;
      case "checks-failing":
        problems.push(`Checks are failing: ${issue.detail}.`);
        break;
      case "changes-requested":
        problems.push("A reviewer requested changes; address them.");
        break;
      case "migration-taken":
        problems.push(`Its migration number is already used on \`${snapshot.baseBranch}\` (${issue.detail}).`);
        break;
      default:
        break;
    }
  }
  if (train && train.conflictFiles.length > 0) {
    const ahead = train.mergedBefore.length > 0
      ? ` once ${train.mergedBefore.map((n) => `#${n}`).join(", ")} merge${train.mergedBefore.length === 1 ? "s" : ""} first`
      : "";
    problems.push(`In the release train it conflicts${ahead} in: ${train.conflictFiles.join(", ")}.`);
  }
  for (const renumber of renumbers) {
    problems.push(
      `Migration \`${renumber.file}\` must become ${formatReleaseMigrationNumber({ number: renumber.to, file: renumber.file })} (it is ${formatReleaseMigrationNumber({ number: renumber.from, file: renumber.file })}).`,
    );
  }
  if (problems.length === 0) {
    problems.push("Make sure it is up to date and mergeable.");
  }

  const steps = [
    `Bring the branch up to date with \`origin/${snapshot.baseBranch}\`${
      train && train.mergedBefore.length > 0
        ? ` and the pull requests that merge before it (${train.mergedBefore.map((n) => `#${n}`).join(", ")}): rebase after they land, or merge their branches in if they are still open`
        : ""
    }, resolving conflicts.`,
    ...(renumbers.length > 0
      ? ["Renumber the migrations as listed above and update the migration journal to match."]
      : item.migrations.length > 0
        ? [
            "Keep its migrations numbered after the ones merging before it, and update the migration journal to match.",
          ]
        : []),
    "Run the project's checks (typecheck, lint, and the tests that cover the change).",
    "Push the branch. Don't merge the pull request and don't deploy.",
  ];

  return [
    `Get pull request #${pr.number} "${pr.title}" (branch \`${pr.branch}\`) in ${snapshot.repository} ready to merge into \`${snapshot.baseBranch}\`.`,
    "",
    "What's wrong:",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "Work in a separate git worktree for the branch, not in the main checkout:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Then tell me what changed and anything you couldn't resolve.",
  ].join("\n");
}
