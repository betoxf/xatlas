import { ServiceChannels } from "@zcode/shared";
import type { AvailableAgent, SwarmEvent, SwarmMember, SwarmMode, SwarmResult } from "@zcode/swarm/types";
import { createServiceDescriptor } from "../descriptors.js";

export type { AvailableAgent, SwarmEvent, SwarmMember, SwarmMode, SwarmResult } from "@zcode/swarm/types";

export interface SwarmStartRequest {
  readonly workspacePath: string;
  readonly task: string;
  readonly members: readonly SwarmMember[];
  /** Debate rounds, 0 to 3 (discussion rounds in a deliberation). */
  readonly rounds: number;
  /** "contest" (the default): each member writes a plan and they rank them. "deliberate": they discuss the request and agree on one plan; nobody votes, and a split goes to the advisors or the person. */
  readonly mode?: SwarmMode;
}

export interface SwarmRunSnapshot {
  readonly runId: string;
  readonly status: "running" | "done" | "failed" | "cancelled";
  /** Events after `sinceEvent`; `eventCount` is the total so far. */
  readonly events: readonly SwarmEvent[];
  readonly eventCount: number;
  readonly result?: SwarmResult;
  readonly error?: string;
}

/** Several models plan the same task, debate each other's plans and vote for the best. */
export interface ISwarmService {
  /** Which agent CLIs are installed and signed in, with models to offer. */
  listAgents(): Promise<readonly AvailableAgent[]>;
  start(params: SwarmStartRequest): Promise<{ readonly runId: string }>;
  getRun(params: { readonly runId: string; readonly sinceEvent?: number }): Promise<SwarmRunSnapshot>;
  cancel(params: { readonly runId: string }): Promise<void>;
}

export const ISwarmService = createServiceDescriptor<ISwarmService>(ServiceChannels.Swarm);
