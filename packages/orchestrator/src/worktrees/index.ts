/**
 * Worktrees: one git worktree and branch per run (made here, or a host's worktree adopted),
 * removed only when nothing would be lost,
 * and the run's identity stamped on its branch, commits and pull request.
 * The rules are in docs/xatlas/orchestrator-engines.md ("Worktrees").
 */
export {
  branchName,
  identityProblem,
  prBlock,
  readBranchName,
  readPrBlock,
  readTrailers,
  withTrailers,
} from "./identity.js";
export { createGitRunner, GitError, type GitResult, type GitRunner } from "./git.js";
export {
  createWorktreeManager,
  MARKER_FILE,
  type AdoptInput,
  type CleanUpOptions,
  type CleanUpResult,
  type EnsureInput,
  type RemovalCheck,
  type WorktreeManager,
  type WorktreeRef,
} from "./worktrees.js";
