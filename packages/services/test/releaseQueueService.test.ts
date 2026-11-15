import { describe, expect, it } from "vitest";
import {
  createReleaseQueueService,
  summarizeChecks,
} from "../src/release-queue/releaseQueueService.js";

const pullRequests = [
  {
    number: 1303,
    title: "fix(cron): separate heavy cron minutes",
    url: "https://github.com/o/r/pull/1303",
    headRefName: "fix/d1-cron-pressure",
    baseRefName: "main",
    author: { login: "me" },
    isDraft: false,
    updatedAt: "2026-10-16T00:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    files: [{ path: "drizzle/0254_cron_task_skip_state.sql" }, { path: "src/cron.ts" }],
    additions: 10,
    deletions: 1,
  },
  {
    number: 1274,
    title: "feat(email): bounce suppression",
    url: "https://github.com/o/r/pull/1274",
    headRefName: "feat/email",
    baseRefName: "main",
    author: { login: "me" },
    isDraft: false,
    updatedAt: "2026-10-15T00:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    statusCheckRollup: [],
    files: [{ path: "drizzle/0253_email_suppressions.sql" }],
    additions: 5,
    deletions: 0,
  },
];

describe("release queue service", () => {
  it("summarises check runs and statuses", () => {
    expect(summarizeChecks([])).toEqual({ state: "none", failing: [] });
    expect(
      summarizeChecks([
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "StatusContext", context: "deploy", state: "SUCCESS" },
      ]),
    ).toEqual({ state: "failure", failing: ["lint"] });
    expect(
      summarizeChecks([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS" }]).state,
    ).toBe("pending");
  });

  it("reads the queue and the base branch's migrations through gh", async () => {
    const calls: string[] = [];
    const service = createReleaseQueueService({
      now: () => new Date("2026-10-16T12:00:00Z"),
      runGh: async (args) => {
        calls.push(args.slice(0, 2).join(" "));
        if (args[0] === "repo") {
          return JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } });
        }
        if (args[0] === "pr") {
          return JSON.stringify(pullRequests);
        }
        if (args[0] === "api") {
          expect(args[1]).toBe("repos/o/r/contents/drizzle?ref=main");
          return "0252_a.sql\n0253_b.sql\nmeta\n";
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    });
    const result = await service.getQueue({ workspacePath: "/repo" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot.baseMigrations).toEqual({ drizzle: [252, 253] });
    const byNumber = Object.fromEntries(
      result.analysis.items.map((item) => [item.pullRequest.number, item]),
    );
    expect(byNumber[1303]?.lane).toBe("ready");
    expect(byNumber[1303]?.pullRequest.checks.state).toBe("success");
    // 0253 already exists on main.
    expect(byNumber[1274]?.lane).toBe("fix");
    expect(calls).toEqual(["repo view", "pr list", "api repos/o/r/contents/drizzle?ref=main"]);
  });

  it("explains why the queue is unavailable", async () => {
    const signedOut = createReleaseQueueService({
      runGh: async () => {
        throw Object.assign(new Error("exit 4"), { stderr: "To get started with GitHub CLI, please run:  gh auth login" });
      },
    });
    expect(await signedOut.getQueue({ workspacePath: "/repo" })).toMatchObject({
      status: "unavailable",
      reason: "gh-signed-out",
    });
    const missing = createReleaseQueueService({
      runGh: async () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await missing.getQueue({ workspacePath: "/repo" })).toMatchObject({
      status: "unavailable",
      reason: "gh-missing",
    });
  });
});
