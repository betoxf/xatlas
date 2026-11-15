import { describe, expect, it } from "vitest";
import {
  formatSwarmReport,
  MAX_VOTE_WEIGHT,
  memberCommand,
  parseBallot,
  parseMember,
  runSwarm,
  tallyBallots,
  unsupportedOptions,
  type AskMember,
  type Effort,
  type SwarmBallot,
  type SwarmEvent,
  type SwarmMember,
} from "../src/index.js";

/** Today's count, as it was before weights: first choice (plans − 1) points, last 1. */
function oldTally(
  plans: ReadonlyArray<{ letter: string; memberId: string }>,
  ballots: readonly SwarmBallot[],
) {
  const scores = new Map(
    plans.map(({ letter, memberId }) => [letter, { letter, memberId, points: 0, firstPlaces: 0 }]),
  );
  for (const ballot of ballots) {
    const slots = plans.length - 1;
    ballot.ranking.forEach((letter, index) => {
      const score = scores.get(letter);
      if (!score) return;
      score.points += slots - index;
      if (index === 0) score.firstPlaces += 1;
    });
  }
  return [...scores.values()].sort(
    (a, b) =>
      b.points - a.points || b.firstPlaces - a.firstPlaces || a.letter.localeCompare(b.letter),
  );
}

/** A small seeded generator, so the property check is the same on every run. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

const PROPOSERS: SwarmMember[] = [
  { id: "claude:claude-mythos-5-2", agent: "claude", model: "claude-mythos-5-2" },
  { id: "claude:fable", agent: "claude", model: "fable" },
  { id: "codex:gpt-6-astra", agent: "codex", model: "gpt-6-astra" },
];

/**
 * Fake members. Proposers rank by `preferences[memberId]` (default A > B > C…), fresh voters
 * by the same table. Every prompt is recorded with the member it went to.
 */
function fakeParliament(
  preferences: Record<string, string[]> = {},
  replies: Record<string, string> = {},
) {
  const calls: Array<{
    memberId: string;
    kind: "propose" | "debate" | "vote" | "fresh-vote";
    prompt: string;
  }> = [];
  const ask: AskMember = async (member, prompt) => {
    const kind = prompt.includes("independent planners")
      ? "propose"
      : prompt.includes("## Revised plan")
        ? "debate"
        : prompt.includes("You wrote none of them")
          ? "fresh-vote"
          : "vote";
    calls.push({ memberId: member.id, kind, prompt });
    if (replies[member.id] !== undefined) return replies[member.id]!;
    if (kind === "propose") return `Plan by someone`;
    if (kind === "debate") return "## Critique\nFine.\n## Revised plan\nRevised";
    const own = /Yours is Plan ([A-Z])/.exec(prompt)?.[1];
    const shown = [...prompt.matchAll(/^### Plan ([A-Z])$/gm)].map((match) => match[1]!);
    const preference = preferences[member.id] ?? shown;
    const ranking = preference.filter((letter) => letter !== own && shown.includes(letter));
    return JSON.stringify({ ranking, reasons: { [ranking[0]!]: "best" } });
  };
  return { ask, calls };
}

describe("weighted votes", () => {
  it("gives exactly the old scores with every weight 1 and no fresh voters", () => {
    const next = random(42);
    for (let trial = 0; trial < 200; trial += 1) {
      const count = 2 + Math.floor(next() * 5);
      const plans = Array.from({ length: count }, (_, index) => ({
        letter: String.fromCharCode(65 + index),
        memberId: `m${index}`,
      }));
      const ballots: SwarmBallot[] = plans
        .filter(() => next() > 0.2)
        .map(({ letter, memberId }) => {
          const others = shuffled(
            plans.map((plan) => plan.letter).filter((other) => other !== letter),
            next,
          );
          // Some ballots are partial, as a model's reply can be.
          return {
            voterId: memberId,
            ranking: others.slice(0, 1 + Math.floor(next() * others.length)),
            reasons: {},
          };
        });
      const scores = tallyBallots(plans, ballots).map(
        ({ letter, memberId, points, firstPlaces }) => ({
          letter,
          memberId,
          points,
          firstPlaces,
        }),
      );
      expect(scores).toEqual(oldTally(plans, ballots));
      // An explicit weight of 1 is the same as none.
      expect(
        tallyBallots(
          plans,
          ballots.map((ballot) => ({ ...ballot, weight: 1 })),
        ),
      ).toEqual(tallyBallots(plans, ballots));
    }
  });

  it("lets a heavier member's vote change the winner", () => {
    const plans = [
      { letter: "A", memberId: "a" },
      { letter: "B", memberId: "b" },
      { letter: "C", memberId: "c" },
    ];
    const ballots: SwarmBallot[] = [
      { voterId: "a", ranking: ["B", "C"], reasons: {} },
      { voterId: "b", ranking: ["C", "A"], reasons: {} },
      { voterId: "c", ranking: ["B", "A"], reasons: {} },
    ];
    // Unweighted: B 4, C 3, A 2.
    expect(tallyBallots(plans, ballots)[0]).toMatchObject({ letter: "B", points: 4 });
    // b's vote counts three times: C gets 2×3 + 1 = 7, B 2 + 2 = 4, A 1×3 + 1 = 4 → C wins.
    // A and B tie on points; B has two first places and A none, so B comes second.
    const weighted = tallyBallots(
      plans,
      ballots.map((ballot) => (ballot.voterId === "b" ? { ...ballot, weight: 3 } : ballot)),
    );
    expect(weighted.map((score) => `${score.letter}${score.points}`)).toEqual(["C7", "B4", "A4"]);
  });

  it("scales a fresh voter's points by (plans − 1) / plans and its weight", () => {
    const plans = [
      { letter: "A", memberId: "a" },
      { letter: "B", memberId: "b" },
      { letter: "C", memberId: "c" },
    ];
    const scores = tallyBallots(plans, [
      { voterId: "fresh", ranking: ["C", "A", "B"], reasons: {}, weight: 3 },
    ]);
    // k = 3 plans: 3 × 2 × (3 − index) / 3 → 6, 4, 2.
    expect(
      scores.map((score) => [
        score.letter,
        score.points,
        score.firstPlaces,
        score.weightedFirstPlaces,
      ]),
    ).toEqual([
      ["C", 6, 1, 3],
      ["A", 4, 0, 0],
      ["B", 2, 0, 0],
    ]);
    const unweighted = tallyBallots(plans, [
      { voterId: "fresh", ranking: ["A", "B", "C"], reasons: {} },
    ]);
    expect(unweighted.map((score) => score.points)).toEqual(
      [2, 4 / 3, 2 / 3].map((value) => Math.round(value * 1e6) / 1e6),
    );
  });

  it("breaks ties on points by first places counted with weight, then by letter", () => {
    const plans = [
      { letter: "A", memberId: "a" },
      { letter: "B", memberId: "b" },
      { letter: "C", memberId: "c" },
    ];
    const scores = tallyBallots(plans, [
      { voterId: "a", ranking: ["C", "B"], reasons: {}, weight: 1.5 }, // C 3, B 1.5
      { voterId: "b", ranking: ["A", "C"], reasons: {} }, // A 2, C 1
      { voterId: "c", ranking: ["B", "A"], reasons: {}, weight: 0.5 }, // B 1, A 0.5
    ]);
    // C 4, B 2.5, A 2.5: B and A tie on points; B's first place weighs 0.5, A's 1 → A first.
    expect(scores.map((score) => [score.letter, score.points, score.weightedFirstPlaces])).toEqual([
      ["C", 4, 1.5],
      ["A", 2.5, 1],
      ["B", 2.5, 0.5],
    ]);
    // Same points and the same weighted first places: the earlier letter wins.
    const even = tallyBallots(plans, [
      { voterId: "a", ranking: ["B", "C"], reasons: {} },
      { voterId: "b", ranking: ["C", "A"], reasons: {} },
      { voterId: "c", ranking: ["A", "B"], reasons: {} },
    ]);
    expect(even.map((score) => score.letter)).toEqual(["A", "B", "C"]);
  });

  it("sees a tie through fractions that don't add up exactly", () => {
    const plans = [
      { letter: "A", memberId: "a" },
      { letter: "B", memberId: "b" },
      { letter: "C", memberId: "c" },
    ];
    // 0.1 + 0.2 and 0.3 differ in floating point; the tie must still go to the letter.
    const scores = tallyBallots(plans, [
      { voterId: "x", ranking: ["B"], reasons: {}, weight: 0.1 },
      { voterId: "y", ranking: ["B"], reasons: {}, weight: 0.2 },
      { voterId: "z", ranking: ["A"], reasons: {}, weight: 0.3 },
    ]);
    expect(scores.map((score) => score.letter)).toEqual(["A", "B", "C"]);
    expect(scores[0]!.points).toBe(scores[1]!.points);
  });

  it("elects the right plan with weights at the ceiling", () => {
    const plans = [
      { letter: "A", memberId: "a" },
      { letter: "B", memberId: "b" },
      { letter: "C", memberId: "c" },
    ];
    // Weights 1 : 2.5 : 2, scaled so the heaviest sits at the ceiling. Scaled up to 10^303
    // these overflowed to Infinity and the first-places tie-break elected B.
    const scale = MAX_VOTE_WEIGHT / 2.5;
    const scores = tallyBallots(plans, [
      { voterId: "a", ranking: ["B", "C"], reasons: {}, weight: scale },
      { voterId: "b", ranking: ["A", "C"], reasons: {}, weight: 2.5 * scale },
      { voterId: "c", ranking: ["B", "A"], reasons: {}, weight: 2 * scale },
    ]);
    // A = 2 × 2.5s + 2s = 7s, B = 2s + 2 × 2s = 6s, C = s + 2.5s = 3.5s.
    expect(scores.map((score) => [score.letter, score.points])).toEqual([
      ["A", 7 * scale],
      ["B", 6 * scale],
      ["C", 3.5 * scale],
    ]);
  });

  it("refuses a weight over the ceiling before any model is asked", async () => {
    const { ask, calls } = fakeParliament();
    await expect(
      runSwarm(
        {
          task: "t",
          cwd: "/",
          members: [{ ...PROPOSERS[0]!, weight: MAX_VOTE_WEIGHT + 1 }, PROPOSERS[1]!],
        },
        ask,
      ),
    ).rejects.toThrow(/at most 1000/);
    expect(calls).toEqual([]);
    expect(() =>
      tallyBallots(
        [
          { letter: "A", memberId: "a" },
          { letter: "B", memberId: "b" },
        ],
        [{ voterId: "a", ranking: ["B"], reasons: {}, weight: 2.5e303 }],
      ),
    ).toThrow(/at most 1000/);
    expect(() => parseMember("claude:opus+w1001")).toThrow(/at most 1000/);
    expect(parseMember("claude:opus+w1000")).toMatchObject({ weight: 1000 });
  });

  it("refuses weights that aren't finite and above 0", async () => {
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { ask, calls } = fakeParliament();
      await expect(
        runSwarm(
          { task: "t", cwd: "/", members: [{ ...PROPOSERS[0]!, weight }, PROPOSERS[1]!] },
          ask,
        ),
      ).rejects.toThrow(/weight/);
      expect(calls).toEqual([]);
      expect(() =>
        tallyBallots(
          [
            { letter: "A", memberId: "a" },
            { letter: "B", memberId: "b" },
          ],
          [{ voterId: "a", ranking: ["B"], reasons: {}, weight }],
        ),
      ).toThrow(/weight/);
    }
  });
});

describe("fresh voters", () => {
  const fresh: SwarmMember = {
    id: "claude:opus+vote",
    agent: "claude",
    model: "opus",
    votesOnly: true,
    weight: 2,
  };

  it("never propose or debate, rank every plan, and count with their weight", async () => {
    const { ask, calls } = fakeParliament({ [fresh.id]: ["C", "B", "A"] });
    const events: SwarmEvent[] = [];
    const result = await runSwarm(
      { task: "Add dark mode", cwd: "/", members: [fresh, ...PROPOSERS], rounds: 2 },
      ask,
      (event) => events.push(event),
    );
    expect(calls.filter((call) => call.memberId === fresh.id).map((call) => call.kind)).toEqual([
      "fresh-vote",
    ]);
    const prompt = calls.find((call) => call.kind === "fresh-vote")!.prompt;
    expect(prompt).toContain("### Plan A");
    expect(prompt).toContain("### Plan C");
    expect(prompt).not.toContain("Yours is Plan");
    // Letters go to proposers only, in order.
    expect(result.plans.map((plan) => `${plan.letter}:${plan.memberId}`)).toEqual([
      "A:claude:claude-mythos-5-2",
      "B:claude:fable",
      "C:codex:gpt-6-astra",
    ]);
    expect(calls.find((call) => call.kind === "propose")!.prompt).toContain(
      "one of 3 independent planners",
    );
    // Proposers: A ranks B > C (B 2, C 1); B ranks A > C (A 2, C 1); C ranks A > B (A 2, B 1),
    // so A 4, B 3, C 2.
    // Fresh, weight 2, k = 3: C 2×2×3/3 = 4, B 2×2×2/3 = 8/3, A 2×2×1/3 = 4/3.
    expect(result.ballots.find((ballot) => ballot.voterId === fresh.id)).toEqual({
      voterId: fresh.id,
      ranking: ["C", "B", "A"],
      reasons: { C: "best" },
      weight: 2,
    });
    // Totals: C 1 + 4 = 6, B 3 + 8/3, A 4 + 4/3.
    expect(result.scores.map((score) => [score.letter, score.points])).toEqual([
      ["C", 6],
      ["B", 5.666667],
      ["A", 5.333333],
    ]);
    expect(result.winner).toMatchObject({ letter: "C", memberId: "codex:gpt-6-astra" });
    const vote = events.find((event) => event.type === "message" && event.memberId === fresh.id);
    expect(vote).toMatchObject({ type: "message", phase: "vote" });
    expect(vote && "letter" in vote).toBe(false);
    expect(result.members).toEqual([fresh, ...PROPOSERS]);
    const report = formatSwarmReport(result);
    expect(report).toContain("| claude:opus+vote | fresh voter | 2 | default | default |");
    expect(report).toContain("- claude:opus+vote (fresh voter, weight 2): C > B > A");
    expect(report).toContain("| C | codex:gpt-6-astra | 6 | 1 |");
    expect(report).toContain("| B | claude:fable | 5.67 | 1 |");
  });

  it("refuses one proposer plus fresh voters", async () => {
    const { ask, calls } = fakeParliament();
    await expect(
      runSwarm(
        { task: "t", cwd: "/", members: [PROPOSERS[0]!, fresh, { ...fresh, id: "fresh-2" }] },
        ask,
      ),
    ).rejects.toThrow(/at least two members that propose/);
    expect(calls).toEqual([]);
  });

  it("stops when fewer than two proposers are left, whatever the fresh voters", async () => {
    const { ask } = fakeParliament();
    const failing: AskMember = async (member, prompt, context) => {
      if (member.id === PROPOSERS[0]!.id) throw new Error("not signed in");
      return ask(member, prompt, context);
    };
    await expect(
      runSwarm(
        { task: "t", cwd: "/", members: [PROPOSERS[0]!, PROPOSERS[1]!, fresh], rounds: 0 },
        failing,
      ),
    ).rejects.toThrow(/needs two/);
  });

  it("reports an unreadable fresh ballot as an abstention and still finishes", async () => {
    const { ask } = fakeParliament({}, { [fresh.id]: "I'd rather not say." });
    const events: SwarmEvent[] = [];
    const result = await runSwarm(
      { task: "t", cwd: "/", members: [...PROPOSERS, fresh], rounds: 0 },
      ask,
      (event) => events.push(event),
    );
    expect(result.dropped).toEqual([
      { memberId: fresh.id, phase: "vote", error: "gave no readable ranking (abstained)" },
    ]);
    expect(events).toContainEqual({
      type: "dropped",
      phase: "vote",
      memberId: fresh.id,
      error: "gave no readable ranking (abstained)",
    });
    expect(result.ballots.map((ballot) => ballot.voterId)).toEqual(
      PROPOSERS.map((member) => member.id),
    );
    expect(result.winner).toBeDefined();
  });

  it("drops a fresh voter that fails without ending the run", async () => {
    const { ask } = fakeParliament();
    const failing: AskMember = async (member, prompt, context) => {
      if (member.id === fresh.id) throw new Error("quota used up");
      return ask(member, prompt, context);
    };
    const result = await runSwarm(
      { task: "t", cwd: "/", members: [...PROPOSERS, fresh], rounds: 1 },
      failing,
    );
    expect(result.dropped).toEqual([{ memberId: fresh.id, phase: "vote", error: "quota used up" }]);
    expect(result.plans).toHaveLength(3);
    expect(result.winner).toBeDefined();
  });

  it("reads a fresh ballot over every plan", () => {
    expect(
      parseBallot('{"ranking": ["C", "A", "B", "A"]}', { voterId: "f", letters: ["A", "B", "C"] }),
    ).toEqual({
      voterId: "f",
      ranking: ["C", "A", "B"],
      reasons: {},
    });
  });
});

describe("parseBallot", () => {
  it("ends on a reply that starts with { and holds no ballot", () => {
    const input = { voterId: "v", ownLetter: "A", letters: ["A", "B"] };
    // Before the fix, lastIndexOf("{", -1) returned 0 again and these never returned.
    expect(parseBallot("{ not json }", input)).toBeUndefined();
    expect(parseBallot("{", input)).toBeUndefined();
    expect(parseBallot("{a}{b}", input)).toBeUndefined();
    expect(parseBallot('{"ranking": ["B"]}', input)).toEqual({
      voterId: "v",
      ranking: ["B"],
      reasons: {},
    });
  });
});

describe("effort and fast mode", () => {
  const efforts: Array<Effort | undefined> = [undefined, "low", "medium", "high", "xhigh", "max"];
  const base = (agent: SwarmMember["agent"]): SwarmMember => ({ id: agent, agent, model: "m" });

  it("builds today's arguments when neither is set", () => {
    expect(memberCommand(base("claude"), "P", "/r")).toEqual({
      command: "claude",
      args: ["-p", "--permission-mode", "plan", "--model", "m"],
      stdin: "P",
    });
    expect(memberCommand(base("codex"), "P", "/r")).toEqual({
      command: "codex",
      args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "m", "-o", "/r", "-"],
      stdin: "P",
    });
    expect(memberCommand(base("opencode"), "P", "/r")).toEqual({
      command: "opencode",
      args: ["run", "-m", "m", "--format", "json", "P"],
    });
    expect(memberCommand(base("gemini"), "P", "/r")).toEqual({
      command: "gemini",
      args: ["-p", "P", "-m", "m"],
    });
    expect(memberCommand({ id: "c", agent: "claude" }, "P", "/r").args).toEqual([
      "-p",
      "--permission-mode",
      "plan",
    ]);
    expect(memberCommand({ ...base("codex"), fast: false }, "P", "/r").args).not.toContain(
      'service_tier="priority"',
    );
    for (const agent of ["claude", "codex", "opencode", "gemini"] as const)
      expect(unsupportedOptions(base(agent))).toEqual([]);
  });

  it("passes each effort and fast combination with the CLI's own flags", () => {
    for (const effort of efforts) {
      for (const fast of [undefined, false, true]) {
        const member = (agent: SwarmMember["agent"]): SwarmMember => ({
          ...base(agent),
          ...(effort ? { effort } : {}),
          ...(fast === undefined ? {} : { fast }),
        });
        expect(memberCommand(member("claude"), "P", "/r").args).toEqual([
          "-p",
          "--permission-mode",
          "plan",
          "--model",
          "m",
          ...(effort ? ["--effort", effort] : []),
        ]);
        expect(memberCommand(member("codex"), "P", "/r").args).toEqual([
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "-m",
          "m",
          ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
          ...(fast ? ["-c", 'service_tier="priority"'] : []),
          "-o",
          "/r",
          "-",
        ]);
        expect(memberCommand(member("opencode"), "P", "/r").args).toEqual([
          "run",
          "-m",
          "m",
          ...(effort ? ["--variant", effort] : []),
          "--format",
          "json",
          "P",
        ]);
        expect(memberCommand(member("gemini"), "P", "/r").args).toEqual(["-p", "P", "-m", "m"]);

        expect(unsupportedOptions(member("claude")).map((entry) => entry.option)).toEqual(
          fast ? ["fast"] : [],
        );
        expect(unsupportedOptions(member("codex"))).toEqual([]);
        expect(unsupportedOptions(member("opencode")).map((entry) => entry.option)).toEqual(
          fast ? ["fast"] : [],
        );
        expect(unsupportedOptions(member("gemini")).map((entry) => entry.option)).toEqual([
          ...(effort ? ["effort"] : []),
          ...(fast ? ["fast"] : []),
        ]);
      }
    }
  });

  it("reports what a CLI can't take once per member, before the run, and in the result", async () => {
    const { ask } = fakeParliament();
    const events: SwarmEvent[] = [];
    const members: SwarmMember[] = [
      { id: "gemini:pro", agent: "gemini", model: "pro", effort: "high", fast: true },
      { id: "codex:astra", agent: "codex", model: "gpt-6-astra", effort: "xhigh", fast: true },
      { id: "claude:fable", agent: "claude", model: "fable", fast: true, votesOnly: true },
      { id: "claude:mythos", agent: "claude", effort: "max" },
    ];
    const result = await runSwarm({ task: "t", cwd: "/", members, rounds: 2 }, ask, (event) =>
      events.push(event),
    );
    const unsupported = events.filter((event) => event.type === "unsupported");
    expect(unsupported.map((event) => `${event.memberId} ${event.option}`)).toEqual([
      "gemini:pro effort",
      "gemini:pro fast",
      "claude:fable fast",
    ]);
    expect(events.findIndex((event) => event.type === "phase")).toBe(3);
    expect(result.unsupported).toEqual(unsupported.map(({ type: _type, ...entry }) => entry));
    const report = formatSwarmReport(result);
    expect(report).toContain("Options not applied:");
    expect(report).toContain("- gemini:pro, effort: Gemini CLI has no effort flag");
    expect(report).toContain("| codex:astra | proposes | 1 | xhigh | asked |");
  });
});

describe("member specs", () => {
  it("keeps agent:model as it was", () => {
    expect(parseMember("claude:opus")).toEqual({
      id: "claude:opus",
      agent: "claude",
      model: "opus",
    });
    expect(parseMember("opencode:openrouter/x:free")).toEqual({
      id: "opencode:openrouter/x:free",
      agent: "opencode",
      model: "openrouter/x:free",
    });
    expect(parseMember("codex")).toEqual({ id: "codex", agent: "codex" });
  });

  it("reads effort, fast, vote and weight", () => {
    expect(parseMember("claude:claude-mythos-5-2+max+fast+w2")).toEqual({
      id: "claude:claude-mythos-5-2+max+fast+w2",
      agent: "claude",
      model: "claude-mythos-5-2",
      effort: "max",
      fast: true,
      weight: 2,
    });
    expect(parseMember("gemini:gemini-2.5-pro+vote+w0.5")).toMatchObject({
      votesOnly: true,
      weight: 0.5,
    });
    expect(() => parseMember("claude:opus+w0")).toThrow(/above 0/);
    expect(() => parseMember("claude:opus+turbo")).toThrow(/Unknown option "turbo"/);
    expect(() => parseMember("grok:x")).toThrow(/Unknown agent/);
  });
});
