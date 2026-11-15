import { describe, expect, it } from "vitest";
import {
  ADVISOR_PACKET_CHARS,
  advisorPrompt,
  advisorsSettled,
  claudeAdvisorCommand,
  combineAdvice,
  formatSwarmReport,
  parseAdvice,
  parseAdvisor,
  runSwarm,
  splitAdvisorPrompt,
  tallyBallots,
  tiedAtTop,
  type AskMember,
  type SwarmAdvisor,
  type SwarmEvent,
  type SwarmMember,
} from "../src/index.js";

const members: SwarmMember[] = [
  { id: "one", agent: "claude" },
  { id: "two", agent: "claude" },
  { id: "three", agent: "codex" },
];

/** Members that plan with their own id and vote as `rankings` says (by member id). */
function asking(rankings: Record<string, string[]>): AskMember {
  return async (member, prompt) => {
    if (prompt.includes("Rank the other plans")) {
      return JSON.stringify({
        ranking: rankings[member.id],
        reasons: { [rankings[member.id]![0]!]: `${member.id} likes it` },
      });
    }
    if (prompt.includes("## Revised plan") || prompt.includes("critique"))
      return `Critique\n\n## Revised plan\nplan of ${member.id}`;
    return `plan of ${member.id}`;
  };
}

/** A over B, B over C, C over A: every plan gets 3 points. */
const cycle = { one: ["B", "C"], two: ["C", "A"], three: ["A", "B"] };
/** A wins 4 to 3 to 2. */
const decided = { one: ["B", "C"], two: ["A", "C"], three: ["A", "B"] };

describe("tiedAtTop", () => {
  const plans = [
    { letter: "A", memberId: "one" },
    { letter: "B", memberId: "two" },
    { letter: "C", memberId: "three" },
  ];
  const ballots = (rankings: Record<string, string[]>) =>
    Object.entries(rankings).map(([voterId, ranking]) => ({ voterId, ranking, reasons: {} }));

  it("is one letter when the vote decided", () => {
    expect(tiedAtTop(tallyBallots(plans, ballots(decided)))).toEqual(["A"]);
  });

  it("names every plan level at the top", () => {
    expect(tiedAtTop(tallyBallots(plans, ballots(cycle)))).toEqual(["A", "B", "C"]);
    // Two level at the top, one behind: only the two.
    const two = tallyBallots(plans.slice(0, 2), [
      { voterId: "one", ranking: ["B"], reasons: {} },
      { voterId: "two", ranking: ["A"], reasons: {} },
    ]);
    expect(tiedAtTop(two)).toEqual(["A", "B"]);
    expect(tiedAtTop([])).toEqual([]);
  });

  it("reads level sums of fractions as level", () => {
    // A fresh voter's thirds add up to the same total by two routes.
    const scores = tallyBallots(plans, [
      { voterId: "fresh-1", ranking: ["A", "B", "C"], reasons: {} },
      { voterId: "fresh-2", ranking: ["B", "A", "C"], reasons: {} },
    ]);
    expect(tiedAtTop(scores)).toEqual(["A", "B"]);
  });
});

describe("parseAdvice", () => {
  it("keeps only the level plans, once each, and the reason", () => {
    expect(
      parseAdvice('Sure.\n{"ranking": ["plan c", "A", "C", "Z"], "reason": " C is simpler. "}', [
        "A",
        "C",
      ]),
    ).toEqual({
      ranking: ["C", "A"],
      reason: "C is simpler.",
    });
  });

  it("is undefined when no level plan is named", () => {
    expect(parseAdvice('{"ranking": ["Z"]}', ["A", "B"])).toBeUndefined();
    expect(parseAdvice("I can't choose.", ["A", "B"])).toBeUndefined();
  });
});

/** An advisor that answers `reply` (or throws it) and counts the prompts it was sent. */
function advisor(id: string, reply: string | Error, prompts: string[] = []): SwarmAdvisor {
  return {
    id,
    ask: async (prompt) => {
      prompts.push(prompt);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const ranks = (...letters: string[]) =>
  JSON.stringify({ ranking: letters, reason: `${letters[0]} first` });

describe("the advisors in a swarm", () => {
  it("are not asked when the vote decided", async () => {
    const asked: string[] = [];
    const result = await runSwarm(
      {
        task: "t",
        cwd: ".",
        members,
        rounds: 0,
        advisors: [advisor("outside", "{}", asked)],
      },
      asking(decided),
    );
    expect(asked).toHaveLength(0);
    expect(result.winner?.letter).toBe("A");
    expect(result.tied).toBeUndefined();
    expect(result.advisors).toBeUndefined();
    expect(result.advisorOrder).toBeUndefined();
  });

  it("with one advisor, its answer settles a level vote, and it sees the plans and ballots but nothing else", async () => {
    const prompts: string[] = [];
    const events: SwarmEvent[] = [];
    const result = await runSwarm(
      {
        task: "Build the thing",
        cwd: "/secret/project/path",
        members,
        rounds: 0,
        advisors: [
          advisor(
            "openrouter:google/gemini-4-argon",
            '{"ranking": ["C", "A"], "reason": "C is the simplest."}',
            prompts,
          ),
        ],
      },
      asking(cycle),
      (event) => events.push(event),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Build the thing");
    expect(prompts[0]).toContain("plan of three");
    expect(prompts[0]).toContain("ranked B > C");
    expect(prompts[0]).not.toContain("/secret/project/path");
    // Each voter's reason for its first choice is passed on.
    for (const id of ["one likes", "two likes", "three likes"]) expect(prompts[0]).toContain(id);
    expect(result.tied).toEqual(["A", "B", "C"]);
    expect(result.advisors).toEqual([
      { id: "openrouter:google/gemini-4-argon", ranking: ["C", "A"], reason: "C is the simplest." },
    ]);
    // C first, then A, then B, which the advisor left out. Points are untouched.
    expect(result.advisorOrder).toEqual(["C", "A", "B"]);
    expect(result.scores.map((score) => score.letter)).toEqual(["C", "A", "B"]);
    expect(result.scores.map((score) => score.points)).toEqual([3, 3, 3]);
    expect(result.winner?.letter).toBe("C");
    expect(result.advisorsNotNeeded).toBeUndefined();
    expect(events.filter((event) => event.type === "advisor")).toEqual([
      {
        type: "advisor",
        memberId: "openrouter:google/gemini-4-argon",
        tied: ["A", "B", "C"],
        ranking: ["C", "A"],
        reason: "C is the simplest.",
      },
    ]);
    const report = formatSwarmReport(result);
    expect(report).toContain(
      "- openrouter:google/gemini-4-argon ranked them C > A: C is the simplest.",
    );
    expect(report).toContain("The advisors chose Plan C (their order: C > A > B).");
  });

  it("asks the first two together and never the third when they agree", async () => {
    const third: string[] = [];
    let running = 0;
    let together = 0;
    const slow = (id: string, reply: string): SwarmAdvisor => ({
      id,
      ask: async () => {
        running += 1;
        together = Math.max(together, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return reply;
      },
    });
    const events: SwarmEvent[] = [];
    const result = await runSwarm(
      {
        task: "t",
        cwd: ".",
        members,
        rounds: 0,
        advisors: [
          slow("claude:opus+high", ranks("B", "C", "A")),
          slow("claude:claude-mythos-5-2", ranks("B", "A", "C")),
          advisor("openrouter:google/gemini-4-argon", ranks("A"), third),
        ],
      },
      asking(cycle),
      (event) => events.push(event),
    );
    expect(together).toBe(2);
    expect(third).toHaveLength(0);
    expect(result.advisors?.map((answer) => answer.id)).toEqual([
      "claude:opus+high",
      "claude:claude-mythos-5-2",
    ]);
    expect(result.advisorsNotNeeded).toEqual(["openrouter:google/gemini-4-argon"]);
    // B first for both; then Borda: C 2 + 1 = 3 against A 1 + 2 = 3, level, so the members' order (A before C).
    expect(result.advisorOrder).toEqual(["B", "A", "C"]);
    expect(result.winner?.letter).toBe("B");
    expect(
      events.filter((event) => event.type === "advisor").map((event) => event.memberId),
    ).toEqual(["claude:opus+high", "claude:claude-mythos-5-2"]);
    const report = formatSwarmReport(result);
    expect(report).toContain("- claude:opus+high ranked them B > C > A: B first");
    expect(report).toContain(
      "Not needed, because the advisors before them had chosen: openrouter:google/gemini-4-argon.",
    );
  });

  it("asks the third when the first two disagree, and the third decides", async () => {
    const third: string[] = [];
    const result = await runSwarm(
      {
        task: "t",
        cwd: ".",
        members,
        rounds: 0,
        advisors: [
          advisor("claude:opus+high", ranks("A", "B", "C")),
          advisor("claude:claude-mythos-5-2", ranks("C", "B", "A")),
          advisor("openrouter:google/gemini-4-argon", ranks("C", "A"), third),
        ],
      },
      asking(cycle),
    );
    expect(third).toHaveLength(1);
    expect(result.advisors?.map((answer) => answer.ranking?.[0])).toEqual(["A", "C", "C"]);
    expect(result.advisorOrder?.[0]).toBe("C");
    expect(result.winner?.letter).toBe("C");
    expect(result.advisorsNotNeeded).toBeUndefined();
  });

  it("asks the next advisor in place of one that fails or can't be read", async () => {
    for (const failing of [
      new Error("Claude Code exited with 1: not signed in"),
      "They are all fine.",
    ]) {
      const third: string[] = [];
      const result = await runSwarm(
        {
          task: "t",
          cwd: ".",
          members,
          rounds: 0,
          advisors: [
            advisor("claude:opus+high", failing),
            advisor("claude:claude-mythos-5-2", ranks("B", "A")),
            advisor("openrouter:google/gemini-4-argon", ranks("B", "C"), third),
          ],
        },
        asking(cycle),
      );
      expect(third).toHaveLength(1);
      expect(result.advisors?.[0]?.ranking).toBeUndefined();
      expect(result.advisors?.[0]?.error).toBeTruthy();
      expect(result.advisorOrder?.[0]).toBe("B");
      expect(result.winner?.letter).toBe("B");
      expect(formatSwarmReport(result)).toContain("- claude:opus+high could not answer (");
    }
  });

  it("leave the vote level when they end level, and the choice is the person's", async () => {
    // Two plans level; Opus and Mythos split, and Gemini fails: one first choice each, Borda level.
    const two = members.slice(0, 2);
    const result = await runSwarm(
      {
        task: "t",
        cwd: ".",
        members: two,
        rounds: 0,
        advisors: [
          advisor("claude:opus+high", ranks("A", "B")),
          advisor("claude:claude-mythos-5-2", ranks("B", "A")),
          advisor(
            "openrouter:google/gemini-4-argon",
            new Error("OpenRouter answered 402 for m: no credit"),
          ),
        ],
      },
      asking({ one: ["B"], two: ["A"] }),
    );
    expect(result.tied).toEqual(["A", "B"]);
    expect(result.advisors).toHaveLength(3);
    expect(result.advisorOrder).toBeUndefined();
    // The members' order stands, by first places and letter, and says nothing.
    expect(result.scores.map((score) => score.letter)).toEqual(["A", "B"]);
    expect(formatSwarmReport(result)).toContain("The advisors did not settle it");
    // Every advisor failing leaves it level too.
    const failed = await runSwarm(
      {
        task: "t",
        cwd: ".",
        members,
        rounds: 0,
        advisors: [advisor("outside", new Error("down")), advisor("other", "no idea")],
      },
      asking(cycle),
    );
    expect(failed.advisors?.map((answer) => Boolean(answer.error))).toEqual([true, true]);
    expect(failed.advisorOrder).toBeUndefined();
    expect(failed.winner?.letter).toBe("A");
  });

  it("stay level on a split where one answer names only its first choice", async () => {
    const result = await runSwarm(
      {
        task: "t",
        cwd: ".",
        members: members.slice(0, 2),
        rounds: 0,
        advisors: [
          advisor("claude:opus+high", ranks("A")),
          advisor("claude:claude-mythos-5-2", ranks("B", "A")),
          advisor("openrouter:google/gemini-4-argon", new Error("No OpenRouter key")),
        ],
      },
      asking({ one: ["B"], two: ["A"] }),
    );
    expect(result.tied).toEqual(["A", "B"]);
    expect(result.advisors).toHaveLength(3);
    expect(result.advisorOrder).toBeUndefined();
  });

  it("choose by second places when all three put a different plan first", async () => {
    const result = await runSwarm(
      {
        task: "t",
        cwd: ".",
        members,
        rounds: 0,
        advisors: [
          advisor("claude:opus+high", ranks("A", "B", "C")),
          advisor("claude:claude-mythos-5-2", ranks("C", "B", "A")),
          advisor("openrouter:google/gemini-4-argon", ranks("B", "A", "C")),
        ],
      },
      asking(cycle),
    );
    // One first choice each; Borda: B 2 + 2 + 3 = 7, A 3 + 1 + 2 = 6, C 1 + 3 + 1 = 5.
    expect(result.advisors).toHaveLength(3);
    expect(result.advisorOrder).toEqual(["B", "A", "C"]);
    expect(result.winner?.letter).toBe("B");
  });

  it("are not asked when fewer than two members gave a readable ballot", async () => {
    const asked: string[] = [];
    // Two planners, and only one of them votes: 1 point to B, none to A, so nothing is level,
    const oneVote: AskMember = async (member, prompt) =>
      prompt.includes("Rank the other plans")
        ? member.id === "one"
          ? '{"ranking": ["B"]}'
          : "no idea"
        : `plan of ${member.id}`;
    const panel = [advisor("outside", "{}", asked), advisor("other", "{}", asked)];
    const one = await runSwarm(
      { task: "t", cwd: ".", members: members.slice(0, 2), rounds: 0, advisors: panel },
      oneVote,
    );
    expect(one.ballots).toHaveLength(1);
    // and when nobody votes there is no winner and nobody to ask.
    const none = await runSwarm(
      { task: "t", cwd: ".", members: members.slice(0, 2), rounds: 0, advisors: panel },
      async (member, prompt) =>
        prompt.includes("Rank the other plans") ? "no idea" : `plan of ${member.id}`,
    );
    expect(none.winner).toBeUndefined();
    expect(asked).toHaveLength(0);
    expect(none.advisors).toBeUndefined();
  });

  it("says the vote was level when no advisor is set", async () => {
    const result = await runSwarm({ task: "t", cwd: ".", members, rounds: 0 }, asking(cycle));
    expect(result.tied).toEqual(["A", "B", "C"]);
    expect(result.advisors).toBeUndefined();
    expect(formatSwarmReport(result)).toContain("No outside advisor was set");
  });
});

describe("advisorsSettled and combineAdvice", () => {
  it("need a majority of first choices among two readable answers, or one when no more can answer", () => {
    expect(advisorsSettled([["A"]], 2)).toBe(false);
    expect(advisorsSettled([["A"]], 0)).toBe(true);
    expect(advisorsSettled([["A"], ["A", "B"]], 1)).toBe(true);
    expect(advisorsSettled([["A"], ["B"]], 1)).toBe(false);
    expect(advisorsSettled([["A"], ["B"], ["B"]], 0)).toBe(true);
    expect(advisorsSettled([], 0)).toBe(false);
  });

  it("orders by first choices, then Borda, and is undefined when the top stays level", () => {
    expect(
      combineAdvice(
        [
          ["A", "B"],
          ["B", "A"],
        ],
        ["A", "B"],
      ),
    ).toBeUndefined();
    expect(combineAdvice([["B"], ["B", "C"]], ["A", "B", "C"])).toEqual(["B", "C", "A"]);
    // One first choice each, but B is second for both others.
    expect(
      combineAdvice(
        [
          ["A", "B", "C"],
          ["C", "B", "A"],
          ["B", "A", "C"],
        ],
        ["A", "B", "C"],
      ),
    ).toEqual(["B", "A", "C"]);
    expect(combineAdvice([], ["A", "B"])).toBeUndefined();
    // A short ranking counts as the full one: a split with one short answer is still level.
    expect(combineAdvice([["A"], ["B", "A"]], ["A", "B"])).toBeUndefined();
    expect(combineAdvice([["A"], ["B"], ["B", "C"]], ["A", "B", "C"])?.[0]).toBe("B");
  });
});

describe("advisorPrompt", () => {
  it("lists only the level plans and asks for a JSON ranking", () => {
    const prompt = advisorPrompt({
      task: "t",
      plans: [
        { letter: "A", plan: "do a" },
        { letter: "C", plan: "do c" },
      ],
      ballots: [{ ranking: ["C", "B"], reasons: { C: "small", B: "big" } }],
    });
    expect(prompt).toContain("### Plan A\ndo a");
    expect(prompt).toContain("Voter 1 ranked C > B. Plan C: small");
    expect(prompt).not.toContain("Plan B: big");
    expect(prompt).toContain('{"ranking": ["B", "A"]');
  });
});

describe("the advisor's packet", () => {
  it("stays under the limit however long the plans, the task and the reasons are", () => {
    const prompt = advisorPrompt({
      task: "t".repeat(50_000),
      plans: [
        { letter: "A", plan: "a".repeat(60_000) },
        { letter: "B", plan: "short plan" },
      ],
      ballots: [{ ranking: ["A", "B"], reasons: { A: "r".repeat(5_000) } }],
    });
    expect(prompt.length).toBeLessThanOrEqual(ADVISOR_PACKET_CHARS);
    expect(prompt).toContain("[cut to fit]");
    expect(prompt).toContain("short plan");
    expect(prompt).toContain('{"ranking": ["B", "A"]');
  });
});

describe("the advisor's packet with many ballots", () => {
  it("lists a bounded number of ballots and never passes the limit", () => {
    const letters = Array.from({ length: 12 }, (_, index) => String.fromCharCode(65 + index));
    const ballots = Array.from({ length: 40 }, () => ({
      ranking: letters,
      reasons: Object.fromEntries(letters.map((letter) => [letter, "r".repeat(2_000)])),
    }));
    const prompt = advisorPrompt({
      task: "t".repeat(20_000),
      plans: letters.map((letter) => ({ letter, plan: letter.repeat(5_000) })),
      ballots,
    });
    expect(prompt.length).toBeLessThanOrEqual(ADVISOR_PACKET_CHARS);
    expect(prompt).toContain("more voters not listed");
    expect(prompt).toContain('{"ranking": ["B", "A"]');
    // Every level plan keeps some of its text.
    for (const letter of letters) expect(prompt).toContain(`### Plan ${letter}\n${letter}`);
    // 40 short ballots, as the review found: 33,520 characters before.
    const short = advisorPrompt({
      task: "t",
      plans: [
        { letter: "A", plan: "a".repeat(40_000) },
        { letter: "B", plan: "b" },
      ],
      ballots: Array.from({ length: 40 }, () => ({
        ranking: ["A", "B"],
        reasons: { A: "x".repeat(400), B: "y".repeat(400) },
      })),
    });
    expect(short.length).toBeLessThanOrEqual(ADVISOR_PACKET_CHARS);
  });
});

describe("the advisor's packet for a split", () => {
  it("says nobody voted, lists what was said by letter, and keeps the same limits", () => {
    const task = `${"t".repeat(10_000)} Keep the old API.`;
    const prompt = splitAdvisorPrompt({
      task,
      plans: [
        { letter: "A", plan: "a".repeat(40_000) },
        { letter: "C", plan: "short plan" },
      ],
      said: Array.from({ length: 40 }, (_, index) => `B said ${index}: ${"r".repeat(800)}`),
    })!;
    expect(prompt.length).toBeLessThanOrEqual(ADVISOR_PACKET_CHARS);
    // The request is never cut: it is all there, word for word.
    expect(prompt).toContain(`## The request, word for word\n${task}\n`);
    expect(prompt).toContain("They don't vote, so you choose.");
    expect(prompt).not.toMatch(/voted|ballot/i);
    expect(prompt).toContain("### Plan C\n<plan>\nshort plan\n</plan>");
    expect(prompt).toContain("- B said 0: ");
    expect(prompt).toContain("more remarks not listed");
    expect(prompt).toContain("Choose between Plans A and C");
    expect(prompt).toContain('{"ranking": ["C", "A"]');
  });
});

describe("parseAdvisor", () => {
  it("reads an OpenRouter model or a Claude Code model, each with an effort", () => {
    expect(parseAdvisor("openrouter:google/gemini-4-argon+high").id).toBe(
      "openrouter:google/gemini-4-argon+high",
    );
    expect(parseAdvisor("claude:opus+high").id).toBe("claude:opus+high");
    expect(parseAdvisor("claude:claude-mythos-5-2").id).toBe("claude:claude-mythos-5-2");
  });

  it("refuses what an advisor can't be", () => {
    expect(() => parseAdvisor("openrouter:")).toThrow(/No model/);
    expect(() => parseAdvisor("claude:")).toThrow(/No model/);
    expect(() => parseAdvisor("openrouter:google/gemini-4-argon+fast")).toThrow(/only an effort/);
    expect(() => parseAdvisor("claude:opus+vote")).toThrow(/only an effort/);
  });

  it("refuses Codex, OpenCode and Gemini CLI, which keep their file tools, and anything else", () => {
    for (const spec of [
      "codex",
      "codex:gpt-6-astra+high",
      "opencode:x",
      "gemini:gemini-2.5-pro",
      "claude",
      "grok:best",
    ]) {
      expect(() => parseAdvisor(spec)).toThrow(
        `"${spec}" can't be the advisor: only openrouter:<model>[+effort] or claude:<model>[+effort] can`,
      );
    }
    expect(() => parseAdvisor("codex")).toThrow(
      /Codex, OpenCode and Gemini CLI keep their file tools/,
    );
  });
});

describe("claudeAdvisorCommand", () => {
  it("runs Claude Code with no tools, no MCP servers, no skills and no saved session, the prompt on stdin", () => {
    expect(claudeAdvisorCommand("rank these", { model: "opus", effort: "high" })).toEqual({
      command: "claude",
      args: [
        "-p",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--model",
        "opus",
        "--effort",
        "high",
      ],
      stdin: "rank these",
    });
    expect(claudeAdvisorCommand("p", { model: "claude-mythos-5-2" }).args).not.toContain(
      "--effort",
    );
  });
});
