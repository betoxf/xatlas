import type {
  ReleaseQueueAnalysis,
  ReleaseQueueSnapshot,
  ReleaseTrainResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ReleaseQueueRequest {
  readonly workspacePath: string;
}

export type ReleaseQueueUnavailableReason =
  | "gh-missing"
  | "gh-signed-out"
  | "no-github-repository"
  | "failed";

export type ReleaseQueueResult =
  | {
      readonly status: "ok";
      readonly snapshot: ReleaseQueueSnapshot;
      readonly analysis: ReleaseQueueAnalysis;
    }
  | {
      readonly status: "unavailable";
      readonly reason: ReleaseQueueUnavailableReason;
      readonly message: string;
    };

export interface ReleaseTrainRequest {
  readonly workspacePath: string;
  readonly baseBranch: string;
  /** Pull requests to merge, in order. */
  readonly order: readonly number[];
}

export type ReleaseTrainOutcome =
  | { readonly status: "ok"; readonly train: ReleaseTrainResult }
  | { readonly status: "unavailable"; readonly message: string };

/** Open pull requests of a workspace's GitHub repository, analysed for shipping. */
export interface IReleaseQueueService {
  getQueue(params: ReleaseQueueRequest): Promise<ReleaseQueueResult>;
  /**
   * Merges the pull requests, in order, onto the latest base in a throwaway
   * worktree to find exactly which ones merge cleanly together. Never touches
   * the user's checkout or the remote.
   */
  checkMergeTrain(params: ReleaseTrainRequest): Promise<ReleaseTrainOutcome>;
}

export const IReleaseQueueService = createServiceDescriptor<IReleaseQueueService>(
  ServiceChannels.ReleaseQueue,
);
