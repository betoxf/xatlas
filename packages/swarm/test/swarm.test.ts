import { describe, expect, it } from "vitest";
import {
  extractRevisedPlan,
  formatSwarmReport,
  parseBallot,
  readOpenCodeEvents,
  runSwarm,
  tallyBallots,
  type AskMember,
  type SwarmEvent,
  type SwarmMember,
} from "../src/index.js";

const members: SwarmMember[] = [
  { id: "claude:opus", agent: "claude", model: "opus" },
  { id: "codex:gpt-6-astra", agent: "codex", model: "gpt-6-astra" },
  { id: "claude:sonnet", agent: "claude", model: "sonnet" },
];

/** Fake members: each proposes, revises once, then ranks the others with a fixed preference. */
function fakeAsk(preference: string[], failing?: string): AskMember {
  return async (member, prompt) => {
    if (member.id === failing) throw new Error("not signed in");
    // Replies never name the model, so prompts can be checked for leaks.
    const token = `m${members.findIndex((candidate) => candidate.id === member.id)}`;
    if (prompt.includes("independent planners")) return `First plan ${token}`;
    if (prompt.includes("## Revised plan")) return `## Critique\n${token} likes the others.\n## Revised plan\nRevised ${token}`;
    const own = /Yours is Plan ([A-Z])/.exec(prompt)![1]!;
    const ranking = preference.filter((letter) => letter !== own && prompt.includes(`### Plan ${letter}`));
    return `Thinking it over.\n{"ranking": ${JSON.stringify(ranking)}, "reasons": {"${ranking[0]}": "clearest steps"}}`;
  };
}

describe("swarm", () => {
  it("proposes, debates with the others' plans and critiques, and votes", async () => {
    const prompts: string[] = [];
    const events: SwarmEvent[] = [];
    const base = fakeAsk(["B", "C", "A"]);
    const result = await runSwarm(
      { task: "Add dark mode", cwd: "/repo", members, rounds: 2 },
      async (member, prompt, context) => {
        prompts.push(prompt);
        return base(member, prompt, context);
      },
      (event) => events.push(event),
    );

    expect(result.plans.map((plan) => plan.plan)).toEqual(["Revised m0", "Revised m1", "Revised m2"]);
    // Round 2 shows round 1's critiques, attributed by plan letter only.
    const round2 = prompts.find((prompt) => prompt.includes("last round") && prompt.includes("Yours is Plan A"))!;
    expect(round2).toContain("From the author of Plan B");
    expect(round2).toContain("m1 likes the others.");
    for (const member of members) expect(round2).not.toContain(member.id);
    // A ranks B > C; B ranks C > A; C ranks B > A → B wins with 4 points.
    expect(result.winner).toMatchObject({ letter: "B", memberId: "codex:gpt-6-astra", points: 4, firstPlaces: 2 });
    expect(events.filter((event) => event.type === "phase").map((event) => (event.type === "phase" ? `${event.phase}${event.round}` : ""))).toEqual([
      "propose0",
      "debate1",
      "debate2",
      "vote0",
    ]);
    expect(formatSwarmReport(result)).toContain("**Winner: Plan B (codex:gpt-6-astra)**");
  });

  it("drops a member that fails and carries on with the rest", async () => {
    const result = await runSwarm({ task: "t", cwd: "/", members, rounds: 1 }, fakeAsk(["A", "B", "C"], "claude:sonnet"));
    expect(result.plans.map((plan) => plan.memberId)).toEqual(["claude:opus", "codex:gpt-6-astra"]);
    expect(result.dropped).toEqual([{ memberId: "claude:sonnet", phase: "propose", error: "not signed in" }]);
  });

  it("stops when fewer than two members are left", async () => {
    await expect(
      runSwarm({ task: "t", cwd: "/", members: members.slice(0, 2), rounds: 0 }, fakeAsk(["A"], "claude:opus")),
    ).rejects.toThrow(/needs two/);
  });

  it("reads ballots defensively", () => {
    const input = { voterId: "v", ownLetter: "A", letters: ["A", "B", "C"] };
    expect(parseBallot('Sure! {"ranking": ["plan c", "A", "B", "B", "Z"], "reasons": {"Plan C": "best"}}', input)).toEqual({
      voterId: "v",
      ranking: ["C", "B"],
      reasons: { C: "best" },
    });
    expect(parseBallot("I can't decide.", input)).toBeUndefined();
  });

  it("breaks ties by first places, then by letter", () => {
    const plans = [
      { letter: "A", memberId: "a" },
      { letter: "B", memberId: "b" },
      { letter: "C", memberId: "c" },
    ];
    const scores = tallyBallots(plans, [
      { voterId: "a", ranking: ["B", "C"], reasons: {} },
      { voterId: "b", ranking: ["C", "A"], reasons: {} },
      { voterId: "c", ranking: ["A", "B"], reasons: {} },
    ]);
    expect(scores.map((score) => `${score.letter}${score.points}`)).toEqual(["A3", "B3", "C3"]);
  });

  it("extracts revised plans and OpenCode text", () => {
    expect(extractRevisedPlan("## Critique\nx\n## Revised plan\n1. Do it")).toBe("1. Do it");
    expect(extractRevisedPlan("no sections")).toBeUndefined();
    expect(readOpenCodeEvents('{"type":"text","part":{"text":"Hel"}}\n{"type":"text","part":{"text":"lo"}}\n')).toBe("Hello");
    expect(() => readOpenCodeEvents('{"type":"error","error":{"data":{"message":"key expired"}}}')).toThrow("key expired");
  });
});
