import type { AgentAccount, AvailableAgent, UsageWindow } from "@zcode/swarm/types";
import { describe, expect, it } from "vitest";
import { agentRoom, pickParliament, pickRole, snapshotOf } from "../../src/routing/index.js";
import { DEFAULT_ROLES, type AgentSnapshot, type RoleSettings } from "../../src/types.js";

const now = new Date("2026-11-15T12:00:00.000Z");
const LATER = "2026-11-16T08:00:00.000Z";
const EARLIER = "2026-11-15T11:00:00.000Z";

const claudeAgent: AvailableAgent = {
  agent: "claude",
  installed: true,
  ready: true,
  detail: "Claude Code 3.1",
};
const codexAgent: AvailableAgent = {
  agent: "codex",
  installed: true,
  ready: true,
  detail: "codex 0.98",
};

/** What Claude Code reports on an Ultra plan: a five-hour and a weekly window. */
function claudeUltra(windows?: UsageWindow[]): AgentAccount {
  return {
    signedIn: true,
    plan: "Ultra",
    windows: windows ?? [
      { usedPercent: 22, minutes: 300, resetsAt: "2026-11-15T15:00:00.000Z" },
      { usedPercent: 41, minutes: 10_080, resetsAt: LATER },
    ],
    limits: "known",
    models: ["opus", "sonnet", "haiku", "fable", "claude-mythos-5-2"],
    checkedAt: "2026-11-15T11:59:00.000Z",
  };
}

/** What Codex reports on Pro Lite. */
function codexProLite(windows?: UsageWindow[]): AgentAccount {
  return {
    signedIn: true,
    plan: "Pro Lite",
    windows: windows ?? [
      { usedPercent: 12, minutes: 300, resetsAt: "2026-11-15T14:00:00.000Z" },
      { usedPercent: 40, minutes: 10_080, resetsAt: LATER },
    ],
    limits: "known",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
  };
}

const claude = (account: AgentAccount = claudeUltra()) => snapshotOf(claudeAgent, account);
const codex = (account: AgentAccount = codexProLite()) => snapshotOf(codexAgent, account);
const signedOut = (agent: AgentSnapshot): AgentSnapshot => ({ ...agent, ready: false });
const usedUp = (resetsAt?: string): UsageWindow[] => [
  { usedPercent: 30, minutes: 300 },
  { usedPercent: 100, minutes: 10_080, ...(resetsAt ? { resetsAt } : {}) },
];

function roles(overrides: Partial<RoleSettings>): RoleSettings {
  return { ...DEFAULT_ROLES, ...overrides };
}

describe("snapshotOf", () => {
  it("takes ready from the check and models and limits from the account", () => {
    expect(claude()).toEqual({
      agent: "claude",
      ready: true,
      models: ["opus", "sonnet", "haiku", "fable", "claude-mythos-5-2"],
      limits: "known",
      windows: claudeUltra().windows,
      checkedAt: "2026-11-15T11:59:00.000Z",
    });
    expect(snapshotOf({ ...claudeAgent, ready: false }, claudeUltra()).ready).toBe(false);
  });

  it("falls back to the agent's models and to unknown limits", () => {
    const agent: AvailableAgent = {
      agent: "opencode",
      installed: true,
      ready: true,
      detail: "",
      models: ["k2"],
    };
    expect(snapshotOf(agent)).toEqual({
      agent: "opencode",
      ready: true,
      models: ["k2"],
      limits: "unknown",
      windows: [],
    });
    expect(snapshotOf(agent, { signedIn: true, windows: [], models: [] }).models).toEqual(["k2"]);
    expect(snapshotOf(agent, { signedIn: true, windows: [] }).limits).toBe("unknown");
    expect(
      snapshotOf(codexAgent, { signedIn: true, plan: "API key", windows: [], limits: "none" }),
    ).toEqual({
      agent: "codex",
      ready: true,
      limits: "none",
      windows: [],
    });
  });
});

describe("agentRoom", () => {
  it("is decided by the tightest window", () => {
    expect(agentRoom(claude(), now)).toMatchObject({
      kind: "known",
      left: 59,
      exhausted: false,
      tightest: { minutes: 10_080 },
    });
  });

  it("counts a window whose reset has passed as started over", () => {
    const room = agentRoom(
      claude(claudeUltra([{ usedPercent: 90, minutes: 300, resetsAt: EARLIER }])),
      now,
    );
    expect(room).toMatchObject({ kind: "known", left: 100, exhausted: false });
  });
});

describe("pickRole", () => {
  const agents = [claude(), codex()];

  it("gives every default role to the first choice when everyone has room", () => {
    const triage = pickRole("triage", DEFAULT_ROLES, agents, { now });
    expect(triage).toEqual({
      ok: true,
      choice: { agent: "claude", model: "haiku" },
      reason: "Claude Code haiku takes the triage role (59% of its weekly limit left).",
    });
    expect(pickRole("executor", DEFAULT_ROLES, agents, { now })).toMatchObject({
      ok: true,
      choice: { agent: "claude", model: "opus", effort: "high" },
    });
    expect(pickRole("reviewer", DEFAULT_ROLES, agents, { now })).toEqual({
      ok: true,
      choice: { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
      reason: "Codex gpt-6.1-sol takes the reviewer role (60% of its weekly limit left).",
    });
    expect(pickRole("watcher", DEFAULT_ROLES, agents, { now })).toMatchObject({
      ok: true,
      choice: { agent: "claude", model: "haiku" },
    });
  });

  it("falls to the next choice when quota is used up", () => {
    const result = pickRole(
      "triage",
      DEFAULT_ROLES,
      [claude(claudeUltra(usedUp(LATER))), codex()],
      { now },
    );
    expect(result).toEqual({
      ok: true,
      choice: { agent: "codex", model: "gpt-6-luna" },
      reason: `Codex gpt-6-luna takes the triage role (60% of its weekly limit left); Claude Code haiku was passed over because Claude Code has used all of its weekly limit until ${LATER}.`,
    });
  });

  it("treats a window over 100% as used up", () => {
    const windows = [{ usedPercent: 104, minutes: 300, resetsAt: LATER }];
    expect(
      pickRole("triage", DEFAULT_ROLES, [claude(claudeUltra(windows)), codex()], { now }),
    ).toMatchObject({
      choice: { agent: "codex" },
    });
  });

  it("frees a used-up window once its reset time has passed", () => {
    const result = pickRole(
      "triage",
      DEFAULT_ROLES,
      [claude(claudeUltra(usedUp(EARLIER))), codex()],
      { now },
    );
    expect(result).toEqual({
      ok: true,
      choice: { agent: "claude", model: "haiku" },
      reason: "Claude Code haiku takes the triage role (70% of its five-hour limit left).",
    });
  });

  it("keeps a window used up at the exact reset time, with no reset time, or an unreadable one", () => {
    for (const windows of [usedUp(now.toISOString()), usedUp(), usedUp("next tuesday")]) {
      const result = pickRole("executor", DEFAULT_ROLES, [claude(claudeUltra(windows)), codex()], {
        now,
      });
      expect(result.ok).toBe(false);
    }
    const noReset = pickRole("executor", DEFAULT_ROLES, [claude(claudeUltra(usedUp())), codex()], {
      now,
    });
    expect(noReset).toEqual({
      ok: false,
      reason:
        "Nobody can take the executor role: Claude Code has used all of its weekly limit and gave no time it resets.",
    });
    const unreadable = pickRole(
      "executor",
      DEFAULT_ROLES,
      [claude(claudeUltra(usedUp("next tuesday")))],
      { now },
    );
    expect(unreadable.reason).toContain("weekly limit and gave no time it resets");
  });

  it("names the used-up window that frees up last", () => {
    const windows = [
      { usedPercent: 100, minutes: 300, resetsAt: "2026-11-15T14:00:00.000Z" },
      { usedPercent: 100, minutes: 10_080, resetsAt: LATER },
    ];
    const result = pickRole("executor", DEFAULT_ROLES, [claude(claudeUltra(windows))], { now });
    expect(result.reason).toBe(
      `Nobody can take the executor role: Claude Code has used all of its weekly limit until ${LATER}.`,
    );
  });

  it("never ranks unknown limits above known room, whatever the settings order", () => {
    const unknownClaude = claude({ ...claudeUltra(), windows: [], limits: "unknown" });
    const almostFullCodex = codex(
      codexProLite([{ usedPercent: 97, minutes: 10_080, resetsAt: LATER }]),
    );
    const result = pickRole("triage", DEFAULT_ROLES, [unknownClaude, almostFullCodex], { now });
    expect(result).toEqual({
      ok: true,
      choice: { agent: "codex", model: "gpt-6-luna" },
      reason:
        "Codex gpt-6-luna takes the triage role (3% of its weekly limit left); Claude Code haiku was passed over because Claude Code's limits are unknown.",
    });
  });

  it("still takes unknown limits when nobody has known room", () => {
    const unknownClaude = claude({ ...claudeUltra(), limits: undefined });
    const result = pickRole("triage", DEFAULT_ROLES, [unknownClaude, signedOut(codex())], { now });
    expect(result).toEqual({
      ok: true,
      choice: { agent: "claude", model: "haiku" },
      reason: "Claude Code haiku takes the triage role (its limits are unknown).",
    });
  });

  it("counts no limits (an API key) as room, and ignores its windows", () => {
    const apiKey = claude({ signedIn: true, plan: "API key", windows: usedUp(), limits: "none" });
    const unknownCodex = codex({ ...codexProLite(), limits: "unknown" });
    const settings = roles({
      triage: [
        { agent: "codex", model: "gpt-6-luna" },
        { agent: "claude", model: "haiku" },
      ],
    });
    expect(pickRole("triage", settings, [apiKey, unknownCodex], { now })).toEqual({
      ok: true,
      choice: { agent: "claude", model: "haiku" },
      reason:
        "Claude Code haiku takes the triage role (no usage limits); Codex gpt-6-luna was passed over because Codex's limits are unknown.",
    });
  });

  it("counts known limits with no windows reported as room", () => {
    const quiet = claude(claudeUltra([]));
    expect(pickRole("executor", DEFAULT_ROLES, [quiet], { now })).toMatchObject({
      ok: true,
      reason: "Claude Code opus takes the executor role (no limits reported as used).",
    });
  });

  it("skips a model the agent does not offer", () => {
    const oldCodex = codex({ ...codexProLite(), models: ["gpt-6-astra", "gpt-6-luna"] });
    expect(pickRole("reviewer", DEFAULT_ROLES, [claude(), oldCodex], { now })).toEqual({
      ok: true,
      choice: { agent: "claude", model: "opus", effort: "high" },
      reason:
        "Claude Code opus takes the reviewer role (59% of its weekly limit left); Codex gpt-6.1-sol was passed over because Codex does not offer gpt-6.1-sol.",
    });
  });

  it("accepts any model from an agent that lists none, and the default from any agent", () => {
    const settings = roles({ executor: [{ agent: "claude", model: "some-new-model" }] });
    const unlisted: AgentSnapshot = { agent: "claude", ready: true, limits: "known", windows: [] };
    expect(pickRole("executor", settings, [unlisted], { now }).ok).toBe(true);
    expect(pickRole("executor", settings, [{ ...unlisted, models: [] }], { now }).ok).toBe(true);
    expect(pickRole("executor", settings, [claude()], { now }).ok).toBe(false);
    const defaultModel = roles({ executor: [{ agent: "claude" }] });
    expect(pickRole("executor", defaultModel, [claude()], { now })).toMatchObject({
      ok: true,
      reason:
        "Claude Code with its default model takes the executor role (59% of its weekly limit left).",
    });
  });

  it("skips an agent it has no snapshot for", () => {
    expect(pickRole("reviewer", DEFAULT_ROLES, [claude()], { now })).toMatchObject({
      ok: true,
      choice: { agent: "claude" },
      reason:
        "Claude Code opus takes the reviewer role (59% of its weekly limit left); Codex gpt-6.1-sol was passed over because Codex is not connected.",
    });
  });

  describe("reviewer with avoid", () => {
    const claudeFirst = roles({
      reviewer: [
        { agent: "claude", model: "opus", effort: "high" },
        { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
      ],
    });

    it("prefers another agent than the one that wrote the change", () => {
      expect(pickRole("reviewer", claudeFirst, agents, { now, avoid: "claude" })).toEqual({
        ok: true,
        choice: { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
        reason:
          "Codex gpt-6.1-sol takes the reviewer role (60% of its weekly limit left); Claude Code opus was passed over because Claude Code wrote the change.",
      });
      expect(pickRole("reviewer", DEFAULT_ROLES, agents, { now, avoid: "codex" })).toMatchObject({
        ok: true,
        choice: { agent: "claude", model: "opus" },
        reason:
          "Claude Code opus takes the reviewer role (59% of its weekly limit left); Codex gpt-6.1-sol was passed over because Codex wrote the change.",
      });
    });

    it("prefers another agent even when only its limits are unknown", () => {
      const unknownCodex = codex({ ...codexProLite(), limits: "unknown" });
      expect(
        pickRole("reviewer", claudeFirst, [claude(), unknownCodex], { now, avoid: "claude" }),
      ).toEqual({
        ok: true,
        choice: { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
        reason:
          "Codex gpt-6.1-sol takes the reviewer role although its limits are unknown, because the change was written by Claude Code.",
      });
      // Without avoid, the same agents give the role to known room.
      expect(pickRole("reviewer", claudeFirst, [claude(), unknownCodex], { now })).toMatchObject({
        ok: true,
        choice: { agent: "claude" },
      });
      const codexFirst = pickRole("reviewer", DEFAULT_ROLES, [claude(), unknownCodex], { now });
      expect(codexFirst).toEqual({
        ok: true,
        choice: { agent: "claude", model: "opus", effort: "high" },
        reason:
          "Claude Code opus takes the reviewer role (59% of its weekly limit left); Codex gpt-6.1-sol was passed over because Codex's limits are unknown.",
      });
    });

    it("falls back to the same agent and says so", () => {
      expect(
        pickRole("reviewer", DEFAULT_ROLES, [claude(), signedOut(codex())], {
          now,
          avoid: "claude",
        }),
      ).toEqual({
        ok: true,
        choice: { agent: "claude", model: "opus", effort: "high" },
        reason:
          "Claude Code opus takes the reviewer role (59% of its weekly limit left), although Claude Code wrote the change, because no other agent can: Codex is not installed or not signed in.",
      });
    });
  });

  it("says why when nobody is available", () => {
    expect(
      pickRole("reviewer", DEFAULT_ROLES, [signedOut(claude()), signedOut(codex())], { now }),
    ).toEqual({
      ok: false,
      reason:
        "Nobody can take the reviewer role: Codex is not installed or not signed in; Claude Code is not installed or not signed in.",
    });
    expect(pickRole("reviewer", DEFAULT_ROLES, [], { now })).toEqual({
      ok: false,
      reason:
        "Nobody can take the reviewer role: Codex is not connected; Claude Code is not connected.",
    });
    expect(pickRole("watcher", roles({ watcher: [] }), agents, { now })).toEqual({
      ok: false,
      reason: "No model is set for the watcher role.",
    });
  });
});

describe("pickParliament", () => {
  it("seats everyone who can run", () => {
    expect(pickParliament(DEFAULT_ROLES, [claude(), codex()], { now })).toEqual({
      seats: DEFAULT_ROLES.parliament,
      skipped: [],
      enough: true,
    });
  });

  it("is still enough with Codex signed out", () => {
    const result = pickParliament(DEFAULT_ROLES, [claude(), signedOut(codex())], { now });
    expect(result.seats).toEqual(
      DEFAULT_ROLES.parliament.filter((seat) => seat.agent === "claude"),
    );
    expect(result.seats).toHaveLength(3);
    expect(result.skipped).toEqual([
      {
        seat: { agent: "codex", model: "gpt-6-astra" },
        reason: "Codex gpt-6-astra cannot sit because Codex is not installed or not signed in.",
      },
    ]);
    expect(result.enough).toBe(true);
  });

  it("is not enough with Claude Code's three seats signed out", () => {
    const result = pickParliament(DEFAULT_ROLES, [signedOut(claude()), codex()], { now });
    expect(result.seats).toEqual([{ agent: "codex", model: "gpt-6-astra" }]);
    expect(result.skipped.map((entry) => entry.seat.model)).toEqual([
      "claude-mythos-5-2",
      "fable",
      "opus",
    ]);
    expect(result.skipped[1]!.reason).toBe(
      "Claude Code fable cannot sit because Claude Code is not installed or not signed in.",
    );
    expect(result.enough).toBe(false);
  });

  it("is not enough with Claude Code's three seats out of quota", () => {
    const result = pickParliament(DEFAULT_ROLES, [claude(claudeUltra(usedUp(LATER))), codex()], {
      now,
    });
    expect(result.seats).toEqual([{ agent: "codex", model: "gpt-6-astra" }]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      `Claude Code claude-mythos-5-2 cannot sit because Claude Code has used all of its weekly limit until ${LATER}.`,
      `Claude Code fable cannot sit because Claude Code has used all of its weekly limit until ${LATER}.`,
      `Claude Code opus cannot sit because Claude Code has used all of its weekly limit until ${LATER}.`,
    ]);
    expect(result.enough).toBe(false);
  });

  it("does not count a fresh voter towards the two that propose, and seats unknown limits", () => {
    const settings = roles({
      parliament: [
        { agent: "claude", model: "fable" },
        { agent: "codex", model: "gpt-6-astra", votesOnly: true },
      ],
    });
    const unknownCodex = codex({ ...codexProLite(), limits: "unknown" });
    const result = pickParliament(settings, [claude(), unknownCodex], { now });
    expect(result.seats).toHaveLength(2);
    expect(result.enough).toBe(false);
  });
});
