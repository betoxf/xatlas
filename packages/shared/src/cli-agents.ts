/** The coding CLIs xatlas can run conversations through, on the user's own sign-in. */
export const CLI_AGENT_IDS = ["claude", "codex", "gemini", "opencode"] as const;
export type CliAgentId = (typeof CLI_AGENT_IDS)[number];

/** The model that means "whatever this CLI is set to use". */
export const CLI_AGENT_DEFAULT_MODEL = "default";

/**
 * A CLI model id that also says how hard to think and whether to run in fast mode:
 * `opus+high`, `gpt-6.1-sol+max+fast`. A model selection has nowhere else to carry these, so
 * the CLI adapter reads them back off the id (`parseCliAgentModelId`) and passes the CLI the
 * bare name with its own flags. Without an option the id is the model's name unchanged.
 */
export function cliAgentModelId(
  model: string | undefined,
  options: { readonly effort?: string; readonly fast?: boolean } = {},
): string {
  return [
    model?.trim() || CLI_AGENT_DEFAULT_MODEL,
    ...(options.effort ? [options.effort] : []),
    ...(options.fast ? ["fast"] : []),
  ].join("+");
}

/** The model's own name in an id made by `cliAgentModelId`. */
export function cliAgentBaseModel(modelId: string): string {
  return modelId.split("+")[0]!.trim();
}

const ENDPOINT_PROTOCOL = "cli://";

/**
 * A provider whose endpoint is `cli://<agent>` runs turns in that CLI instead of calling an
 * API. The endpoint is the marker so the provider file keeps its schema: a ZCode sharing
 * `~/.zcode` reads the entry as a provider it can't reach, not as an invalid file.
 */
export function cliAgentEndpoint(agent: CliAgentId): string {
  return `${ENDPOINT_PROTOCOL}${agent}`;
}

export function parseCliAgentEndpoint(baseUrl: string | null | undefined): CliAgentId | undefined {
  if (!baseUrl?.startsWith(ENDPOINT_PROTOCOL)) return undefined;
  const agent = baseUrl.slice(ENDPOINT_PROTOCOL.length);
  return CLI_AGENT_IDS.find((id) => id === agent);
}
