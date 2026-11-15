import type { OrchestratorJobView, OrchestratorStepView } from "@zcode/services";

/** Fake jobs for the orchestrator's Stack card, covering every state its view types allow. */

const at = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`;

const settingsStep: OrchestratorStepView = {
  taskId: "job-big.settings-ui",
  title: "Settings search box",
  state: "in_review",
  owns: ["packages/ui/src/settings"],
  dependsOn: ["job-big.api"],
  run: {
    runId: "run-ui",
    choice: { agent: "claude", model: "opus", effort: "high" },
    state: "waiting",
    conversationId: "conv-ui",
    branch: "xatlas/job-big.settings-ui/claude-run-ui",
  },
  review: {
    round: 2,
    verdict: "findings",
    conversationId: "conv-ui-review",
    findings: [
      {
        id: "f1",
        severity: "blocker",
        lens: "reuse",
        file: "src/settings/Search.tsx",
        line: 42,
        text: "Repeats the filter the sidebar already has.",
      },
      { id: "f2", severity: "should-fix", text: "The empty state has no words.", repeats: "f0" },
      {
        id: "f3",
        severity: "note",
        lens: "design",
        file: "src/settings/Search.tsx",
        text: "Spacing.",
      },
    ],
  },
  flags: [
    {
      at: at(20),
      check: "outside-owns",
      action: "paused",
      detail: "Changed a file another step owns.",
      paths: ["packages/ui/src/sidebar/filter.ts"],
    },
    {
      at: at(21),
      check: "no-commit",
      action: "flagged",
      detail: "The turn ended with nothing committed.",
    },
  ],
};

const apiStep: OrchestratorStepView = {
  taskId: "job-big.api",
  title: "Search index API",
  state: "queued",
  owns: ["packages/services/src/search"],
  dependsOn: [],
  run: {
    runId: "run-api",
    choice: { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
    state: "done",
    conversationId: "conv-api",
    branch: "xatlas/job-big.api/codex-run-api",
  },
  review: { round: 1, verdict: "pass", findings: [], conversationId: "conv-api-review" },
  flags: [
    {
      at: at(15),
      check: "empty-review",
      action: "flagged",
      detail: "612 lines passed with no finding.",
    },
  ],
};

const otherStates: OrchestratorStepView[] = (
  ["idea", "planned", "working", "merged", "deployed", "checked", "cancelled"] as const
).map((state, index) => ({
  taskId: `job-big.s${index}`,
  title: `Step ${state}`,
  state,
  owns: [],
  dependsOn: [],
  flags: [],
  ...(state === "idea"
    ? {}
    : {
        run: {
          runId: `run-${state}`,
          choice: { agent: "claude" as const },
          state: (["starting", "working", "failed", "stopped", "done", "done"] as const)[
            index - 1
          ]!,
        },
      }),
}));

/** Working, waiting on the person, with a full plan, rulings and a busy board. */
export const bigJob: OrchestratorJobView = {
  jobId: "job-big",
  title: "Make settings searchable",
  phase: "working",
  status: "Two steps are running; one waits on your answer.",
  plan: {
    winner: "claude:fable",
    text: "1. Index the settings.\n2. Add the search box.",
    tied: ["claude:fable", "codex:gpt-6-astra"],
    advisors: [
      {
        choice: { via: "claude", model: "opus", effort: "high" },
        ranking: ["claude:fable", "codex:gpt-6-astra"],
        reason: "Plan A reuses the index.",
      },
      { choice: { via: "claude", model: "claude-mythos-5-2" }, ranking: ["claude:fable"] },
    ],
    advisorOrder: ["claude:fable", "codex:gpt-6-astra"],
  },
  steps: [apiStep, settingsStep, ...otherStates],
  decisions: [
    {
      id: "d-pause",
      kind: "paused-run",
      question: "The search box step changed a file outside what it owns. Let it keep the change?",
      options: [
        { id: "keep", label: "Keep the change" },
        { id: "revert", label: "Undo it" },
      ],
      taskId: "job-big.settings-ui",
    },
    {
      id: "d-clarify",
      kind: "clarify",
      question: "Search titles only, or descriptions too?",
      options: [],
    },
  ],
  notes: [
    { at: at(10), from: "person", text: "Keep it fast." },
    { at: at(11), from: "orchestrator", text: "Divided into two steps.", to: "job-big.api" },
    { at: at(12), from: "watcher", text: "The search box run is waiting on a question." },
    { at: at(13), from: "run-ui", text: "Using the sidebar's filter.", to: "job-big.settings-ui" },
    { at: at(14), from: "run-unknown", text: "Who wrote this?" },
  ],
  rulings: [
    {
      at: at(18),
      trigger: "finding-disputed",
      ruling: "drop",
      text: "The finding asks for something the plan ruled out.",
      chair: "claude:claude-mythos-5-2",
      findingId: "f0",
    },
    {
      at: at(19),
      trigger: "round-three-failed",
      ruling: "owner",
      text: "Your call.",
      chair: "codex:gpt-6-astra",
    },
  ],
  createdAt: at(0),
  updatedAt: at(22),
};

/** Still choosing a plan: nothing divided yet. */
export const deliberatingJob: OrchestratorJobView = {
  jobId: "job-new",
  title: "Rework onboarding",
  phase: "deliberating",
  status: "The models are discussing approaches.",
  steps: [],
  decisions: [],
  notes: [],
  rulings: [],
  createdAt: at(1),
  updatedAt: at(5),
};

/** A level vote the advisors could not settle: Opus and Mythos split, and Gemini failed. */
export const levelVoteJob: OrchestratorJobView = {
  ...deliberatingJob,
  jobId: "job-level",
  title: "Pick a state library",
  phase: "waiting",
  status: "The vote is level; pick a plan.",
  plan: {
    text: "",
    tied: ["claude:fable", "codex:gpt-6-astra"],
    advisors: [
      {
        choice: { via: "claude", model: "opus", effort: "high" },
        ranking: ["claude:fable", "codex:gpt-6-astra"],
      },
      {
        choice: { via: "claude", model: "claude-mythos-5-2" },
        ranking: ["codex:gpt-6-astra", "claude:fable"],
      },
      { choice: { via: "openrouter", model: "google/gemini-4-argon" }, error: "rate limited" },
    ],
  },
  decisions: [
    {
      id: "d-level",
      kind: "level-vote",
      question: "Which plan should the team build?",
      options: [
        { id: "a", label: "Plan A (claude:fable)" },
        { id: "b", label: "Plan B (codex:gpt-6-astra)" },
      ],
    },
  ],
};

export const finishedJobs: OrchestratorJobView[] = (["done", "failed", "stopped"] as const).map(
  (phase, index) => ({
    ...deliberatingJob,
    jobId: `job-${phase}`,
    title: `Job ${phase}`,
    phase,
    status: `It is ${phase}.`,
    plan: { text: "A plan.", advisors: [{ choice: { via: "openrouter", model: "m" } }] },
    updatedAt: at(30 + index),
  }),
);

export const otherPhaseJobs: OrchestratorJobView[] = (
  ["dividing", "final-read", "waiting"] as const
).map((phase) => ({ ...deliberatingJob, jobId: `job-${phase}`, title: `Job ${phase}`, phase }));
