import { describe, expect, it } from "vitest";
import { buildSwarmContinuePrompt } from "@/app-shell/swarm/swarmContinuePrompt.js";

describe("swarm continue prompt", () => {
  it("carries the task, the winning plan and the voters' reasons", () => {
    const prompt = buildSwarmContinuePrompt({
      task: "Add dark mode",
      plans: [
        { letter: "A", memberId: "claude:opus", plan: "Use CSS variables." },
        { letter: "B", memberId: "codex", plan: "Hardcode colors." },
      ],
      debate: [],
      ballots: [{ voterId: "codex", ranking: ["A"], reasons: { A: "themeable" } }],
      scores: [],
      winner: { letter: "A", memberId: "claude:opus", points: 1, firstPlaces: 1 },
      dropped: [],
    });
    expect(prompt).toContain("Add dark mode");
    expect(prompt).toContain("Use CSS variables.");
    expect(prompt).not.toContain("Hardcode colors.");
    expect(prompt).toContain("- themeable");
  });
});
