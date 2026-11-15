import type {
  OrchestratorDecision,
  OrchestratorJobPhase,
  OrchestratorJobView,
  OrchestratorRouteRequest,
  OrchestratorStepView,
} from "@zcode/services";

export type RoutePreference = OrchestratorRouteRequest["preference"];
export type StepState = OrchestratorStepView["state"];
export type StepRun = NonNullable<OrchestratorStepView["run"]>;
export type StepReview = NonNullable<OrchestratorStepView["review"]>;
export type StepFlag = OrchestratorStepView["flags"][number];
export type ReviewFindingView = StepReview["findings"][number];
export type ChairRuling = OrchestratorJobView["rulings"][number];
export type AdvisorAnswer = NonNullable<
  NonNullable<OrchestratorJobView["plan"]>["advisors"]
>[number];
type AdvisorChoice = AdvisorAnswer["choice"];

// Records, not template ids, so the type check names any state that has no words yet.

export const ROUTE_PREFERENCES: readonly RoutePreference[] = ["auto", "direct", "orchestrated"];

export const ROUTE_LABEL: Record<RoutePreference, string> = {
  auto: "orchestrator.route.auto",
  direct: "orchestrator.route.direct",
  orchestrated: "orchestrator.route.orchestrated",
};

export const ROUTE_HINT: Record<RoutePreference, string> = {
  auto: "orchestrator.route.autoHint",
  direct: "orchestrator.route.directHint",
  orchestrated: "orchestrator.route.orchestratedHint",
};

export const PHASE_LABEL: Record<OrchestratorJobPhase, string> = {
  deliberating: "orchestrator.phase.deliberating",
  dividing: "orchestrator.phase.dividing",
  working: "orchestrator.phase.working",
  "final-read": "orchestrator.phase.finalRead",
  waiting: "orchestrator.phase.waiting",
  done: "orchestrator.phase.done",
  failed: "orchestrator.phase.failed",
  stopped: "orchestrator.phase.stopped",
};

export const STEP_STATE_LABEL: Record<StepState, string> = {
  idea: "orchestrator.step.state.idea",
  planned: "orchestrator.step.state.planned",
  working: "orchestrator.step.state.working",
  in_review: "orchestrator.step.state.inReview",
  // In this build "queued" means reviewed and waiting for the release queue.
  queued: "orchestrator.step.state.queued",
  merged: "orchestrator.step.state.merged",
  deployed: "orchestrator.step.state.deployed",
  checked: "orchestrator.step.state.checked",
  cancelled: "orchestrator.step.state.cancelled",
};

export const RUN_STATE_LABEL: Record<StepRun["state"], string> = {
  starting: "orchestrator.run.state.starting",
  working: "orchestrator.run.state.working",
  waiting: "orchestrator.run.state.waiting",
  done: "orchestrator.run.state.done",
  failed: "orchestrator.run.state.failed",
  stopped: "orchestrator.run.state.stopped",
};

export const DECISION_KIND_LABEL: Record<OrchestratorDecision["kind"], string> = {
  clarify: "orchestrator.decision.kind.clarify",
  "level-vote": "orchestrator.decision.kind.levelVote",
  "paused-run": "orchestrator.decision.kind.pausedRun",
  chair: "orchestrator.decision.kind.chair",
  blocked: "orchestrator.decision.kind.blocked",
};

export const VERDICT_LABEL: Record<StepReview["verdict"], string> = {
  pass: "orchestrator.review.verdict.pass",
  findings: "orchestrator.review.verdict.findings",
};

export const SEVERITY_LABEL: Record<ReviewFindingView["severity"], string> = {
  blocker: "orchestrator.finding.severity.blocker",
  "should-fix": "orchestrator.finding.severity.shouldFix",
  note: "orchestrator.finding.severity.note",
};

export const FLAG_CHECK_LABEL: Record<StepFlag["check"], string> = {
  "outside-owns": "orchestrator.flag.check.outsideOwns",
  "no-commit": "orchestrator.flag.check.noCommit",
  "empty-review": "orchestrator.flag.check.emptyReview",
};

export const FLAG_ACTION_LABEL: Record<StepFlag["action"], string> = {
  paused: "orchestrator.flag.action.paused",
  flagged: "orchestrator.flag.action.flagged",
};

export const RULING_TRIGGER_LABEL: Record<ChairRuling["trigger"], string> = {
  "round-three-failed": "orchestrator.ruling.trigger.roundThreeFailed",
  "finding-disputed": "orchestrator.ruling.trigger.findingDisputed",
  "final-read": "orchestrator.ruling.trigger.finalRead",
};

export const RULING_LABEL: Record<ChairRuling["ruling"], string> = {
  fix: "orchestrator.ruling.ruling.fix",
  drop: "orchestrator.ruling.ruling.drop",
  reassign: "orchestrator.ruling.ruling.reassign",
  redivide: "orchestrator.ruling.ruling.redivide",
  pass: "orchestrator.ruling.ruling.pass",
  owner: "orchestrator.ruling.ruling.owner",
};

/** Who wrote a board note, when it is not a run. */
export const NOTE_AUTHOR_LABEL: Record<string, string> = {
  person: "orchestrator.note.from.person",
  orchestrator: "orchestrator.note.from.orchestrator",
  watcher: "orchestrator.note.from.watcher",
};

/** The job's state as the Stack shows it: a decision waiting on the person outranks the phase. */
export function jobStatusLabelId(job: OrchestratorJobView): string {
  return job.decisions.length > 0 ? PHASE_LABEL.waiting : PHASE_LABEL[job.phase];
}

/** "claude:opus · high · fast": the seat format the parliament uses, plus how hard it thinks. */
export function formatModelChoice(choice: StepRun["choice"]): string {
  return [
    choice.model ? `${choice.agent}:${choice.model}` : choice.agent,
    choice.effort,
    choice.fast ? "fast" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "claude:opus · high", "openrouter:google/gemini-4-argon": an outside advisor, as the seats are shown. */
export function formatAdvisorChoice(choice: AdvisorChoice): string {
  return [`${choice.via}:${choice.model}`, choice.effort].filter(Boolean).join(" · ");
}

/** Every id above, so a test can check both locales carry them. */
export const ORCHESTRATOR_LABEL_IDS: readonly string[] = [
  ROUTE_LABEL,
  ROUTE_HINT,
  PHASE_LABEL,
  STEP_STATE_LABEL,
  RUN_STATE_LABEL,
  DECISION_KIND_LABEL,
  VERDICT_LABEL,
  SEVERITY_LABEL,
  FLAG_CHECK_LABEL,
  FLAG_ACTION_LABEL,
  RULING_TRIGGER_LABEL,
  RULING_LABEL,
  NOTE_AUTHOR_LABEL,
].flatMap((labels) => Object.values(labels));
