import { cliAgentEndpoint, type CliAgentId } from "@zcode/shared/cli-agents";
import { describe, expect, it } from "vitest";
import {
  ensureCliAgentModel,
  syncCliAgentProviders,
  type CliAgentProviderSettings,
} from "../src/connections/cliAgentProviders.js";

interface FakeProvider {
  providerId: string;
  enabled: boolean;
  agent: CliAgentId;
  models: string[];
}

/** The slice of the provider settings the CLI providers use, kept in memory. */
function fakeSettings(providers: FakeProvider[]) {
  const settings = {
    getView: async () => ({
      providers: providers.map((provider) => ({
        providerId: provider.providerId,
        enabled: provider.enabled,
        effectiveConfig: { api: { baseUrl: cliAgentEndpoint(provider.agent) } },
        models: provider.models.map((modelId) => ({ modelId })),
      })),
    }),
    createPersonalProvider: async () => ({ providerId: "new" }),
    savePersonalProviderOverlay: async () => undefined,
    addPersonalModel: async (providerId: string, modelId: string) => {
      providers.find((provider) => provider.providerId === providerId)!.models.push(modelId);
    },
    deletePersonalModel: async (providerId: string, modelId: string) => {
      const provider = providers.find((candidate) => candidate.providerId === providerId)!;
      provider.models = provider.models.filter((model) => model !== modelId);
    },
  };
  return settings as unknown as CliAgentProviderSettings;
}

describe("ensureCliAgentModel", () => {
  it("adds a model id with options once, and returns the selection", async () => {
    const providers = [
      { providerId: "p1", enabled: true, agent: "claude" as const, models: ["default", "opus"] },
    ];
    const settings = fakeSettings(providers);
    expect(await ensureCliAgentModel(settings, "claude", "opus+high")).toEqual({
      providerId: "p1",
      modelId: "opus+high",
    });
    await ensureCliAgentModel(settings, "claude", "opus+high");
    expect(providers[0]!.models).toEqual(["default", "opus", "opus+high"]);
  });

  it("registers a model once when several executors start on it together", async () => {
    const providers = [
      { providerId: "p1", enabled: true, agent: "claude" as const, models: ["default"] },
    ];
    const settings = fakeSettings(providers);
    let adds = 0;
    const add = settings.addPersonalModel;
    // Like the real provider: adding takes a moment, and a model that is already there is refused.
    (settings as { addPersonalModel: unknown }).addPersonalModel = async (
      providerId: string,
      modelId: string,
      config: never,
    ) => {
      if (providers[0]!.models.includes(modelId)) throw new Error("model already exists");
      adds += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await add(providerId, modelId, config);
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => ensureCliAgentModel(settings, "claude", "opus+high")),
    );
    expect(results).toEqual(Array(3).fill({ providerId: "p1", modelId: "opus+high" }));
    expect(adds).toBe(1);
    // A later call finds it there and adds nothing.
    await ensureCliAgentModel(settings, "claude", "opus+high");
    expect(adds).toBe(1);
  });

  it("is undefined for an agent that isn't connected", async () => {
    const providers = [
      { providerId: "p1", enabled: false, agent: "codex" as const, models: ["default"] },
    ];
    expect(
      await ensureCliAgentModel(fakeSettings(providers), "codex", "gpt-6.1-sol+max"),
    ).toBeUndefined();
    expect(await ensureCliAgentModel(fakeSettings(providers), "claude", "opus")).toBeUndefined();
    expect(providers[0]!.models).toEqual(["default"]);
  });
});

describe("syncCliAgentProviders", () => {
  it("keeps a model id with options while the agent offers its model, and drops it after", async () => {
    const providers = [
      {
        providerId: "p1",
        enabled: true,
        agent: "claude" as const,
        models: ["default", "opus", "opus+high", "old", "old+max"],
      },
    ];
    const settings = fakeSettings(providers);
    const claude = { agent: "claude" as const, installed: true, ready: true, detail: "signed in" };
    await syncCliAgentProviders(settings, [{ ...claude, models: ["opus", "fable"] }]);
    expect(providers[0]!.models.sort()).toEqual(["default", "fable", "opus", "opus+high"]);
  });
});
