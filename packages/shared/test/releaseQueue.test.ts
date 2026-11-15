import { describe, expect, it } from "vitest";
import {
  analyzeReleaseQueue,
  parseReleaseMigration,
  type ReleaseQueuePullRequest,
  type ReleaseQueueSnapshot,
} from "../src/release-queue.js";

function pr(number: number, overrides: Partial<ReleaseQueuePullRequest> = {}): ReleaseQueuePullRequest {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    branch: `branch-${number}`,
    baseBranch: "main",
    author: "me",
    isDraft: false,
    updatedAt: "2026-10-16T00:00:00Z",
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    reviewDecision: null,
    checks: { state: "success", failing: [] },
    files: [`src/feature-${number}.ts`],
    additions: 10,
    deletions: 2,
    ...overrides,
  };
}

function snapshot(
  pullRequests: ReleaseQueuePullRequest[],
  baseMigrations: Record<string, number[]> = { drizzle: [251, 252, 253] },
): ReleaseQueueSnapshot {
  return {
    repository: "o/r",
    baseBranch: "main",
    fetchedAt: "2026-10-16T00:00:00Z",
    baseMigrations,
    pullRequests,
  };
}

const journal = "drizzle/meta/_journal.json";

describe("release queue", () => {
  it("recognises Drizzle / D1 style migrations", () => {
    expect(parseReleaseMigration("drizzle/0254_cron_task_skip_state.sql")).toEqual({
      file: "drizzle/0254_cron_task_skip_state.sql",
      directory: "drizzle",
      number: 254,
    });
    expect(parseReleaseMigration("apps/api/migrations/0012_users.sql")?.directory).toBe(
      "apps/api/migrations",
    );
    expect(parseReleaseMigration("drizzle/meta/_journal.json")).toBeNull();
    expect(parseReleaseMigration("src/migrations.ts")).toBeNull();
  });

  it("sorts pull requests into lanes from their own state", () => {
    const { items } = analyzeReleaseQueue(
      snapshot([
        pr(1),
        pr(2, { isDraft: true }),
        pr(3, { mergeable: "CONFLICTING", mergeState: "DIRTY" }),
        pr(4, { checks: { state: "failure", failing: ["typecheck"] } }),
        pr(5, { checks: { state: "pending", failing: [] } }),
        pr(6, { mergeable: "UNKNOWN", mergeState: "UNKNOWN" }),
        pr(7, { mergeState: "BEHIND" }),
      ]),
    );
    const lanes = Object.fromEntries(items.map((item) => [item.pullRequest.number, item.lane]));
    expect(lanes).toEqual({ 1: "ready", 2: "draft", 3: "fix", 4: "fix", 5: "waiting", 6: "waiting", 7: "ready" });
    expect(items.find((item) => item.pullRequest.number === 4)?.issues[0]?.detail).toBe("typecheck");
  });

  it("catches a migration whose number main already took", () => {
    const { items } = analyzeReleaseQueue(
      snapshot([pr(1303, { files: ["drizzle/0253_cron_task_skip_state.sql", journal, "src/cron.ts"] })]),
    );
    const item = items[0]!;
    expect(item.lane).toBe("fix");
    expect(item.issues.map((issue) => issue.kind)).toContain("migration-taken");
    expect(item.issues.find((issue) => issue.kind === "migration-taken")?.detail).toBe(
      "0253 already exists on main",
    );
  });

  it("ships migration pull requests in migration order, renumbering clashes", () => {
    // #1274 and #1303 both picked 0254 off a main that ends at 0253.
    const { items, plan } = analyzeReleaseQueue(
      snapshot([
        pr(1274, { files: ["drizzle/0254_email_suppressions.sql", journal, "src/email.ts"] }),
        pr(1303, { files: ["drizzle/0254_cron_task_skip_state.sql", journal, "src/cron.ts"] }),
        pr(1389, { files: ["bun.lock", "package.json"] }),
      ]),
    );
    const duplicate = items
      .find((item) => item.pullRequest.number === 1274)
      ?.issues.find((issue) => issue.kind === "migration-duplicate");
    expect(duplicate?.relatedPullRequests).toEqual([1303]);
    // The journal both edit is bookkeeping, not an overlap.
    expect(plan.order).toEqual([1274, 1303, 1389]);
    expect(plan.renumbers).toEqual([
      { pullRequest: 1303, file: "drizzle/0254_cron_task_skip_state.sql", from: 254, to: 255 },
    ]);
    expect(plan.overlaps).toEqual([]);
  });

  it("flags ready pull requests that edit the same files, without holding them", () => {
    const { items, plan } = analyzeReleaseQueue(
      snapshot([
        pr(10, { files: ["src/shared.ts", "src/a.ts"] }),
        pr(11, { files: ["src/shared.ts", "src/b.ts"] }),
        pr(12, { files: ["src/c.ts"] }),
      ]),
    );
    expect(plan.order).toEqual([10, 11, 12]);
    expect(plan.overlaps).toEqual([{ pullRequests: [10, 11], files: ["src/shared.ts"] }]);
    expect(
      items.find((item) => item.pullRequest.number === 11)?.issues.map((issue) => issue.kind),
    ).toContain("file-overlap");
  });

  it("keeps drafts and blocked pull requests out of the batch", () => {
    const { plan } = analyzeReleaseQueue(
      snapshot([
        pr(1, { isDraft: true }),
        pr(2, { checks: { state: "failure", failing: ["build"] } }),
        pr(3),
      ]),
    );
    expect(plan.order).toEqual([3]);
  });
});
