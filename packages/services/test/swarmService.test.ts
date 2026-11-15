import { describe, expect, it } from "vitest";
import { createSwarmService } from "../src/swarm/swarmService.js";

const members = [
  { id: "a", agent: "claude" as const },
  { id: "b", agent: "codex" as const },
];

async function settle(service: ReturnType<typeof createSwarmService>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.getRun({ runId });
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("run didn't finish");
}

describe("swarm service", () => {
  it("runs a swarm in the background and hands out events incrementally", async () => {
    const service = createSwarmService({
      ask: async (member, prompt) =>
        prompt.includes("independent planners") ? `plan ${member.id}` : `{"ranking": ["${member.id === "a" ? "B" : "A"}"]}`,
    });
    const { runId } = await service.start({ workspacePath: "/repo", task: "t", members, rounds: 0 });
    const run = await settle(service, runId);

    expect(run.status).toBe("done");
    expect(run.result?.scores.map((score) => score.points)).toEqual([1, 1]);
    const later = await service.getRun({ runId, sinceEvent: run.eventCount - 1 });
    expect(later.events).toHaveLength(1);
  });

  it("runs a deliberation when asked, and a contest by default", async () => {
    const service = createSwarmService({
      ask: async (_member, prompt) =>
        prompt.includes("gives an opening alone")
          ? '{"approaches": [{"name": "n", "idea": "do it"}], "pick": 1}'
          : prompt.includes("This is discussion round")
            ? '{"stand": "1"}'
            : prompt.includes("Answer three things")
              ? '{"onRequest": true}'
              : "## How it does what was asked\nx\n## Approach\nx\n## Taken from\nx\n## Steps\nx\n## Risks\nx\n## How to verify\nx",
    });
    const { runId } = await service.start({ workspacePath: "/repo", task: "t", members, rounds: 1, mode: "deliberate" });
    const run = await settle(service, runId);
    expect(run.status).toBe("done");
    expect(run.result?.deliberation).toMatchObject({ agreed: true, majority: "1" });
    expect(run.result?.winner?.letter).toBe("A");
  });

  it("reports a failed run", async () => {
    const service = createSwarmService({ ask: async () => Promise.reject(new Error("signed out")) });
    const { runId } = await service.start({ workspacePath: "/repo", task: "t", members, rounds: 1 });
    const run = await settle(service, runId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("signed out");
  });
});
