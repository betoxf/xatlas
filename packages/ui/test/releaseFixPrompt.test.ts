import { describe, expect, it } from "vitest";
import { analyzeReleaseQueue, type ReleaseQueuePullRequest } from "@zcode/shared";
import { buildReleaseFixPrompt } from "@/app-shell/releases/releaseFixPrompt.js";

const base: ReleaseQueuePullRequest = {
  number: 1274,
  title: "feat(email): bounce suppression",
  url: "https://github.com/o/r/pull/1274",
  branch: "feat/email",
  baseBranch: "main",
  author: "me",
  isDraft: false,
  updatedAt: "2026-10-16T00:00:00Z",
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  reviewDecision: null,
  checks: { state: "failure", failing: ["typecheck"] },
  files: ["drizzle/0255_email_suppressions.sql", "drizzle/meta/_journal.json"],
  additions: 5,
  deletions: 0,
};

describe("release fix prompt", () => {
  it("briefs an agent on what's wrong and how to fix it, without merging", () => {
    const snapshot = {
      repository: "o/r",
      baseBranch: "main",
      fetchedAt: "",
      baseMigrations: { drizzle: [253] },
      pullRequests: [base],
    };
    const item = analyzeReleaseQueue(snapshot).items[0]!;
    const prompt = buildReleaseFixPrompt({
      snapshot,
      item,
      renumbers: [{ pullRequest: 1274, file: "drizzle/0255_email_suppressions.sql", from: 255, to: 256 }],
      train: { conflictFiles: ["drizzle/meta/_journal.json"], mergedBefore: [1303] },
    });
    expect(prompt).toContain('pull request #1274 "feat(email): bounce suppression" (branch `feat/email`) in o/r');
    expect(prompt).toContain("Checks are failing: typecheck.");
    expect(prompt).toContain("once #1303 merges first in: drizzle/meta/_journal.json");
    expect(prompt).toContain("must become 0256 (it is 0255)");
    expect(prompt).toContain("Don't merge the pull request and don't deploy.");
    expect(prompt).toContain("separate git worktree");
  });
});
