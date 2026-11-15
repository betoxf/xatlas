import type {
  AdvisorChoice,
  AgentSnapshot,
  ModelChoice,
  ParliamentSeat,
} from "@zcode/orchestrator/types";
import type { GitRunner } from "@zcode/orchestrator/worktrees";
import type { SwarmResult } from "@zcode/swarm/types";
import type { OrchestratorProject } from "./orchestrator.js";

/**
 * What the orchestrator's loop needs from the app. The node host (`nodeHost.ts`) answers with
 * the app's own services; tests answer with fakes. The loop holds every rule, so nothing here
 * decides anything.
 */
export interface OrchestratorHost {
  /** Why the full route can't run for this project (not a Git repository, a remote workspace), or `undefined` when it can. */
  cannotOrchestrate(project: OrchestratorProject): Promise<string | undefined>;

  /** The connected agents with their models and what is left of their limits. */
  agents(): Promise<readonly AgentSnapshot[]>;

  /**
   * One read-only question to a model through its CLI, for triage, division, the watcher and
   * the chair. `cwd` is the folder it may read.
   */
  ask(
    choice: ModelChoice,
    prompt: string,
    options: { readonly cwd: string; readonly signal?: AbortSignal },
  ): Promise<string>;

  /**
   * The parliament: the seats discuss the request and agree on one plan; nobody votes. With
   * `advisors`, a split between two positions goes to those outside models in their order, the
   * first two together and the next only while they have not settled it (see `askAdvisors` in
   * the swarm).
   */
  deliberate(input: {
    readonly task: string;
    readonly cwd: string;
    readonly seats: readonly ParliamentSeat[];
    readonly advisors?: readonly AdvisorChoice[];
    readonly signal?: AbortSignal;
  }): Promise<SwarmResult>;

  /**
   * Starts an executor: a new conversation, in a new worktree the host makes from `ref` (the
   * project's current commit when null), with `text` as its first message. The conversation
   * may change files in its worktree without asking. The worktree comes back detached; the
   * loop gives it the run's branch.
   */
  startExecutor(input: {
    readonly project: OrchestratorProject;
    readonly ref: string | null;
    readonly title: string;
    readonly text: string;
    readonly choice: ModelChoice;
  }): Promise<{ readonly conversationId: string; readonly worktreePath: string }>;

  /** Starts a reviewer: a new conversation in an executor's worktree that can read and run but not change files. */
  startReviewer(input: {
    readonly project: OrchestratorProject;
    readonly worktreePath: string;
    readonly title: string;
    readonly text: string;
    readonly choice: ModelChoice;
  }): Promise<{ readonly conversationId: string }>;

  /** Sends a conversation its next message. */
  send(input: {
    readonly project: OrchestratorProject;
    readonly conversationId: string;
    readonly text: string;
  }): Promise<void>;

  /**
   * Resolves when the conversation's current turn ends, with the assistant's last message.
   * "needs_attention" means it stopped to ask the person something.
   */
  waitForTurn(input: {
    readonly project: OrchestratorProject;
    readonly conversationId: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly status: "completed" | "failed" | "needs_attention";
    readonly text: string;
  }>;

  /** Stops a conversation's turn, if one is running. */
  interrupt(input: {
    readonly project: OrchestratorProject;
    readonly conversationId: string;
  }): Promise<void>;

  /** Git, run in the project or in one of its worktrees. */
  readonly git: GitRunner;
}
