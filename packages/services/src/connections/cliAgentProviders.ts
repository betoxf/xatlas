import type { ProviderConfigObject } from "@zcode/provider";
import {
  CLI_AGENT_DEFAULT_MODEL,
  cliAgentBaseModel,
  cliAgentEndpoint,
  parseCliAgentEndpoint,
  type CliAgentId,
} from "@zcode/shared/cli-agents";
import type { AvailableAgent } from "@zcode/swarm/types";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";

type ModelConfig = Parameters<IProviderSettingsService["addPersonalModel"]>[2];

export type CliAgentProviderSettings = Pick<
  IProviderSettingsService,
  | "getView"
  | "createPersonalProvider"
  | "savePersonalProviderOverlay"
  | "addPersonalModel"
  | "deletePersonalModel"
>;

/** The provider needs a key to count as complete; the CLI's own sign-in is what's used. */
const CLI_LOGIN_ACCESS = { type: "api-key", apiKey: "cli-login" } as const;

const AGENT_PROVIDERS: Record<CliAgentId, { readonly name: string; readonly logo: string }> = {
  claude: { name: "Claude Code", logo: "anthropic" },
  codex: { name: "Codex", logo: "openai" },
  gemini: { name: "Gemini CLI", logo: "gemini" },
  opencode: { name: "OpenCode", logo: "opencode" },
};

/**
 * The CLI compacts its own context, so the runtime must never try to: its window is out of
 * reach, and side calls don't need anything but text.
 */
const CLI_MODEL_CONFIG: ModelConfig = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 10_000_000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    // Reminders then stay out of the turn's user message, which is what the CLI receives.
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["disabled"], map: "{}" },
    maxOutputTokens: { max: 128_000, map: "{'max_tokens': maxOutputTokens}" },
  },
};

function providerConfig(agent: CliAgentId): ProviderConfigObject {
  return {
    access: CLI_LOGIN_ACCESS,
    api: { type: "openai-chat-completions", baseUrl: cliAgentEndpoint(agent) },
    logo: { type: "builtin", key: AGENT_PROVIDERS[agent].logo },
  };
}

/**
 * Keeps the model picker in step with the CLIs: a signed-in CLI is a provider with its default
 * model and the models it offers, and a signed-out one is disabled rather than deleted, so
 * conversations keep their selection for the next sign-in.
 */
export async function syncCliAgentProviders(
  settings: CliAgentProviderSettings,
  agents: readonly AvailableAgent[],
): Promise<void> {
  const view = await settings.getView();
  for (const agent of agents) {
    const existing = view.providers.find(
      (provider) => parseCliAgentEndpoint(provider.effectiveConfig.api?.baseUrl) === agent.agent,
    );
    if (!agent.ready) {
      if (existing?.enabled) {
        await settings.savePersonalProviderOverlay(
          existing.providerId,
          providerConfig(agent.agent),
          {
            enabled: false,
          },
        );
      }
      continue;
    }
    const providerId =
      existing?.providerId ??
      (
        await settings.createPersonalProvider({
          providerName: AGENT_PROVIDERS[agent.agent].name,
        })
      ).providerId;
    if (!existing || !existing.enabled) {
      await settings.savePersonalProviderOverlay(providerId, providerConfig(agent.agent), {
        enabled: true,
      });
    }
    // Without a list from the agent, the default is added and the rest is left as it was.
    const wanted = [CLI_AGENT_DEFAULT_MODEL, ...(agent.models ?? [])];
    const current = new Set(existing?.models.map((model) => model.modelId) ?? []);
    for (const modelId of wanted) {
      if (!current.has(modelId)) {
        await settings.addPersonalModel(providerId, modelId, CLI_MODEL_CONFIG);
      }
    }
    if (!agent.models) continue;
    for (const modelId of current) {
      // An id with options (`opus+high`) stays for as long as the agent offers its model.
      if (!wanted.includes(cliAgentBaseModel(modelId))) {
        await settings.deletePersonalModel(providerId, modelId);
      }
    }
  }
}

/**
 * Makes sure a CLI agent's provider offers `modelId`, which may carry options
 * (`cliAgentModelId`), and returns the selection that runs a conversation on it. `undefined`
 * when the agent has no enabled provider: it isn't connected.
 */
export function ensureCliAgentModel(
  settings: CliAgentProviderSettings,
  agent: CliAgentId,
  modelId: string,
): Promise<{ readonly providerId: string; readonly modelId: string } | undefined> {
  // Several executors start at once on the same model: they share one registration, since
  // the provider refuses a model that is added twice.
  const key = `${agent}\n${modelId}`;
  let perSettings = ensuring.get(settings);
  if (!perSettings) ensuring.set(settings, (perSettings = new Map()));
  const running = perSettings.get(key);
  if (running) return running;
  const mine = ensureNow(settings, agent, modelId).finally(() => perSettings.delete(key));
  perSettings.set(key, mine);
  return mine;
}

type EnsuredModel = { readonly providerId: string; readonly modelId: string } | undefined;
const ensuring = new WeakMap<CliAgentProviderSettings, Map<string, Promise<EnsuredModel>>>();

async function ensureNow(
  settings: CliAgentProviderSettings,
  agent: CliAgentId,
  modelId: string,
): Promise<EnsuredModel> {
  const view = await settings.getView();
  const provider = view.providers.find(
    (candidate) =>
      candidate.enabled && parseCliAgentEndpoint(candidate.effectiveConfig.api?.baseUrl) === agent,
  );
  if (!provider) return undefined;
  if (!provider.models.some((model) => model.modelId === modelId)) {
    await settings.addPersonalModel(provider.providerId, modelId, CLI_MODEL_CONFIG);
  }
  return { providerId: provider.providerId, modelId };
}
