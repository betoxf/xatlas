import { describe, expect, it } from "vitest";
import {
  claudePlanName,
  codexPlanName,
  readClaudeAccount,
  readCodexAccount,
} from "../src/index.js";

describe("Codex account", () => {
  it("reads the plan, limits and visible models from the app server", () => {
    const account = readCodexAccount({
      account: {
        account: { type: "chatgpt", email: "a@b.c", planType: "prolite" },
        requiresOpenaiAuth: true,
      },
      rateLimits: {
        rateLimits: {
          planType: "prolite",
          primary: {
            usedPercent: 27,
            windowDurationMins: 10080,
            resetsAt: 1794722469,
          },
          secondary: null,
        },
      },
      models: {
        data: [
          { id: "gpt-6-astra", hidden: false, isDefault: false },
          { id: "gpt-6.1-sol", hidden: false, isDefault: true },
          { id: "internal", hidden: true, isDefault: false },
        ],
      },
    });
    expect(account).toEqual({
      signedIn: true,
      plan: "Pro Lite",
      windows: [
        {
          usedPercent: 27,
          minutes: 10080,
          resetsAt: "2026-11-15T06:01:09.000Z",
        },
      ],
      limits: "known",
      models: ["gpt-6.1-sol", "gpt-6-astra"],
    });
  });

  it("says when nobody is signed in, and keeps what it could read", () => {
    expect(
      readCodexAccount({
        account: { account: null, requiresOpenaiAuth: true },
      }),
    ).toEqual({
      signedIn: false,
      windows: [],
      limits: "unknown",
    });
  });

  it("names an API key and unusual plans", () => {
    expect(readCodexAccount({ account: { account: { type: "apiKey" } } }).plan).toBe("API key");
    expect(codexPlanName("self_serve_business_usage_based")).toBe("Business");
    expect(codexPlanName("enterprise_cbp_automation")).toBe("Enterprise");
    expect(codexPlanName("sci_plus")).toBe("Sci Plus");
    expect(codexPlanName("unknown")).toBeUndefined();
  });
});

describe("Claude Code account", () => {
  it("reads the plan, limits and models from its control requests", () => {
    const account = readClaudeAccount({
      initialize: {
        account: {
          email: "a@b.c",
          subscriptionType: "Claude Ultra",
          apiProvider: "firstParty",
        },
        models: [{ value: "default" }, { value: "opus" }, { value: "fable" }, { value: "haiku" }],
      },
      usage: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: null,
          seven_day: {
            utilization: 49,
            resets_at: "2026-11-17T17:59:59.442937+00:00",
          },
        },
      },
    });
    expect(account).toEqual({
      signedIn: true,
      plan: "Ultra",
      windows: [
        {
          usedPercent: 49,
          minutes: 10080,
          resetsAt: "2026-11-17T17:59:59.442937+00:00",
        },
      ],
      limits: "known",
      models: ["opus", "fable", "haiku"],
    });
  });

  it("shows both windows when the plan has a five-hour one", () => {
    const account = readClaudeAccount({
      initialize: { account: { subscriptionType: "Claude Pro" } },
      usage: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 80, resets_at: "2026-11-14T18:00:00Z" },
          seven_day: { utilization: 10, resets_at: "2026-11-20T18:00:00Z" },
        },
      },
    });
    expect(account.windows.map((window) => window.minutes)).toEqual([300, 10080]);
    expect(account.plan).toBe("Pro");
  });

  it("has no limits on an API key, and no plan when signed out", () => {
    expect(
      readClaudeAccount({
        initialize: { account: { apiKeySource: "ANTHROPIC_API_KEY" } },
        usage: { rate_limits_available: false },
      }),
    ).toEqual({ signedIn: true, plan: "API key", windows: [], limits: "none" });
    expect(readClaudeAccount({})).toEqual({ signedIn: false, windows: [], limits: "unknown" });
    expect(claudePlanName("max")).toBe("Max");
  });
});
