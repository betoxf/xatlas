import { ServiceChannels } from "@zcode/shared";
import type { CliAgentId } from "@zcode/shared/cli-agents";
import type { AgentAccount } from "@zcode/swarm/types";
import { createServiceDescriptor } from "../descriptors.js";

export type ConnectionId = CliAgentId | "github" | "ucu";

export type { AgentAccount, UsageWindow } from "@zcode/swarm/types";

/** A signed-in agent's plan and limits, and when the agent was asked. */
export interface ConnectionAccount extends AgentAccount {
  readonly checkedAt: string;
}

export interface ConnectionStatus {
  readonly id: ConnectionId;
  /** The tool is on this Mac. */
  readonly installed: boolean;
  /** Signed in, or for UCU set up: ready to use. */
  readonly connected: boolean;
  /** What the tool itself reported. */
  readonly detail: string;
  /** The command the sign-in button runs, to copy where Terminal can't be opened. */
  readonly command: string;
  readonly downloadUrl: string;
  /** UCU only: it's on for every agent. */
  readonly everywhere?: boolean;
}

/**
 * The tools people bring: their CLIs for conversations, GitHub for releases and UCU for
 * computer use. Sign-ins stay with each tool; nothing here reads or holds a credential.
 */
export interface IConnectionsService {
  /** Every connection, keeping the model picker's CLI providers in step. */
  list(): Promise<readonly ConnectionStatus[]>;
  /** One connection, for rows waiting on a sign-in. */
  check(params: { readonly id: ConnectionId }): Promise<ConnectionStatus>;
  /**
   * The plan, limits and models a signed-in agent reports itself; null for tools that can't.
   * Answers are reused for a few minutes unless `refresh` is set.
   */
  account(params: {
    readonly id: ConnectionId;
    readonly refresh?: boolean;
  }): Promise<ConnectionAccount | null>;
  /**
   * Starts the tool's own sign-in. Codex signs in through the browser at `url`, which the caller
   * opens; the others open Terminal on their login, and `opened` is false where it can't be.
   */
  signIn(params: {
    readonly id: ConnectionId;
  }): Promise<{ readonly opened: boolean; readonly url?: string }>;
  /** Turns UCU on or off for every agent that can use it. */
  setUcuEverywhere(params: { readonly enabled: boolean }): Promise<ConnectionStatus>;
}

export const IConnectionsService = createServiceDescriptor<IConnectionsService>(
  ServiceChannels.Connections,
);
