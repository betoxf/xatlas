/**
 * Oversight: the turn-end checks, review with lenses, the chair and the watcher. Pure: the loop
 * gathers the facts, asks the models and keeps the ledger. Spec: docs/xatlas/orchestrator-wiring.md,
 * "The team, as the parliament decided it".
 */
export {
  EMPTY_REVIEW_LINES,
  outsideOwns,
  reminderFor,
  turnEndFlags,
  type OversightFlag,
  type TurnEnd,
} from "./flags.js";
export {
  DESIGN_LENS,
  REUSE_LENS,
  findingLine,
  findingsMessage,
  isUiPath,
  lensesFor,
  passes,
  readDisputes,
  readReview,
  reviewPrompt,
  type Dispute,
  type ReviewLens,
  type ReviewReading,
} from "./review.js";
export {
  chairPrompt,
  finalReadPrompt,
  pickChair,
  readRuling,
  rulingsLeft,
  seatId,
  type ChairPick,
  type ChairRuling,
  type ChairStep,
  type ChairTrigger,
  type FinishedStep,
  type RulingReading,
} from "./chair.js";
export {
  MAX_WATCHER_CALLS,
  readAdvice,
  watcherCallsLeft,
  watcherPrompt,
  type WatcherAdvice,
  type WatcherTrigger,
} from "./watcher.js";
