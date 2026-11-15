// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import type { IOrchestratorService, OrchestratorJobsSnapshot } from "@zcode/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bigJob,
  deliberatingJob,
  finishedJobs,
  levelVoteJob,
  otherPhaseJobs,
} from "./fixtures/orchestratorJobs.js";

let service: IOrchestratorService | undefined;

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => (service ? { orchestratorService: service } : {}),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values ? `${id}:${Object.values(values).join()}` : id,
    },
  }),
}));

const { orchestratorStackProjects, useOrchestratorJobs } =
  await import("@/app-shell/orchestrator/useOrchestratorJobs.js");
const { buildJobStackEntries, jobStackStatus } =
  await import("@/app-shell/orchestrator/orchestratorStackEntries.js");
const { OrchestratorJobDialog } = await import("@/app-shell/orchestrator/OrchestratorJobDialog.js");
const { TaskGlassCard } = await import("@/app-shell/taskStack/TaskGlassCard.js");
const { buildTaskStackGroups } = await import("@/app-shell/taskStack/taskStackEntries.js");

const project = { key: "/work/app", name: "App", projectId: "p1", workspacePath: "/work/app" };
const params = { projectId: "p1", workspacePath: "/work/app" };

function fakeService(listJobs: IOrchestratorService["listJobs"]): IOrchestratorService {
  return {
    route: vi.fn(),
    listJobs: vi.fn(listJobs),
    decide: vi.fn(async () => {}),
    postNote: vi.fn(async () => {}),
    stopJob: vi.fn(async () => {}),
    getRoles: vi.fn(),
    setRoles: vi.fn(async () => {}),
  } as unknown as IOrchestratorService;
}

const actions = () => ({
  decide: vi.fn(async () => {}),
  postNote: vi.fn(async () => {}),
  stopJob: vi.fn(async () => {}),
});

beforeEach(() => {
  service = undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("orchestratorStackProjects", () => {
  it("takes each local project's primary root and skips deleted and remote ones", () => {
    expect(
      orchestratorStackProjects([
        {
          id: "p1",
          hostId: "local",
          name: "App",
          deleted: false,
          roots: [
            { rootPath: "/work/other", isPrimary: false },
            { rootPath: "/work/app", isPrimary: true },
          ],
        },
        {
          id: "p2",
          hostId: "local",
          name: "Old",
          deleted: true,
          roots: [{ rootPath: "/old", isPrimary: true }],
        },
        {
          id: "p3",
          hostId: "host-9",
          name: "Far",
          deleted: false,
          roots: [{ rootPath: "/far", isPrimary: true }],
        },
        { id: "p4", hostId: "local", name: "Empty", deleted: false, roots: [] },
      ]),
    ).toEqual([project]);
  });
});

describe("useOrchestratorJobs", () => {
  it("polls with the last position and keeps the jobs when nothing happened", async () => {
    vi.useFakeTimers();
    const answers: OrchestratorJobsSnapshot[] = [
      { seq: 4, jobs: [deliberatingJob] },
      { seq: 4, jobs: [] },
      {
        seq: 6,
        jobs: [
          { ...deliberatingJob, phase: "dividing", updatedAt: "2026-11-15T11:00:00.000Z" },
          bigJob,
        ],
      },
    ];
    service = fakeService(async () => answers.shift() ?? { seq: 6, jobs: [] });
    const { result } = renderHook(() => useOrchestratorJobs([project]));
    await act(async () => {});
    expect(service.listJobs).toHaveBeenLastCalledWith(params);
    expect(result.current.jobs.map((job) => job.view.jobId)).toEqual(["job-new"]);

    await act(async () => vi.advanceTimersByTime(2000));
    expect(service.listJobs).toHaveBeenLastCalledWith({ ...params, sinceSeq: 4 });
    expect(result.current.jobs.map((job) => job.view.jobId)).toEqual(["job-new"]);

    await act(async () => vi.advanceTimersByTime(2000));
    expect(result.current.jobs.map((job) => [job.view.jobId, job.view.phase])).toEqual([
      ["job-new", "dividing"],
      ["job-big", "working"],
    ]);
    expect(result.current.jobs[0]!.project).toEqual(project);

    await act(async () => vi.advanceTimersByTime(2000));
    expect(service.listJobs).toHaveBeenLastCalledWith({ ...params, sinceSeq: 6 });
  });

  it("acts on a job and reads the project again at once", async () => {
    service = fakeService(async () => ({ seq: 1, jobs: [bigJob] }));
    const { result } = renderHook(() => useOrchestratorJobs([project]));
    await act(async () => {});
    const job = result.current.jobs[0]!;
    const before = vi.mocked(service.listJobs).mock.calls.length;

    await act(() => result.current.decide(job, "d-pause", "keep"));
    expect(service.decide).toHaveBeenCalledWith({
      ...params,
      jobId: "job-big",
      decisionId: "d-pause",
      optionId: "keep",
    });
    await act(() => result.current.postNote(job, "Hello", "job-big.api"));
    expect(service.postNote).toHaveBeenCalledWith({
      ...params,
      jobId: "job-big",
      text: "Hello",
      to: "job-big.api",
    });
    await act(() => result.current.postNote(job, "Everyone"));
    expect(service.postNote).toHaveBeenLastCalledWith({
      ...params,
      jobId: "job-big",
      text: "Everyone",
    });
    await act(() => result.current.stopJob(job));
    expect(service.stopJob).toHaveBeenCalledWith({ ...params, jobId: "job-big" });
    expect(vi.mocked(service.listJobs).mock.calls.length).toBeGreaterThan(before);
  });

  it("keeps the last jobs when listing fails, and lists nothing without a host", async () => {
    let fail = false;
    service = fakeService(async () => {
      if (fail) throw new Error("gone");
      return { seq: 1, jobs: [bigJob] };
    });
    const { result } = renderHook(() => useOrchestratorJobs([project]));
    await act(async () => {});
    fail = true;
    await act(() => result.current.stopJob(result.current.jobs[0]!));
    expect(result.current.jobs).toHaveLength(1);

    service = undefined;
    const { result: none } = renderHook(() => useOrchestratorJobs([project]));
    expect(none.current).toMatchObject({ supported: false, jobs: [] });
  });
});

describe("job cards in the Stack", () => {
  it("maps each phase onto the Stack's order: waiting and failed lead", () => {
    expect(jobStackStatus(bigJob)).toBe("waiting");
    expect(jobStackStatus(deliberatingJob)).toBe("running");
    expect(otherPhaseJobs.map(jobStackStatus)).toEqual(["running", "running", "waiting"]);
    expect(finishedJobs.map(jobStackStatus)).toEqual(["idle", "error", "idle"]);
  });

  it("gives jobs keys no conversation can have, grouped with their project", () => {
    const [entry] = buildJobStackEntries([{ view: bigJob, project }]);
    expect(entry).toMatchObject({
      key: "/work/app::orchestrator-job:job-big",
      groupKey: "/work/app",
      taskId: "orchestrator-job:job-big",
      workspaceName: "App",
      title: "Make settings searchable",
      status: "waiting",
      updatedAt: Date.parse(bigJob.updatedAt),
    });
    const [group] = buildTaskStackGroups([
      entry!,
      { ...entry!, key: "c", taskId: "c", status: "idle", job: undefined },
    ]);
    expect(group).toMatchObject({ conversationCount: 1, actionableCount: 1 });
    expect(group!.entries[0]!.job?.view.jobId).toBe("job-big");
  });

  it("draws a job's front card: title, status, phase, steps and what waits on the person", () => {
    const [entry] = buildJobStackEntries([{ view: bigJob, project }]);
    const onOpen = vi.fn();
    render(
      <TaskGlassCard
        entry={entry!}
        variant="front"
        projectName="App"
        footnote="2 conversations"
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("Make settings searchable")).toBeTruthy();
    expect(screen.getByText(bigJob.status)).toBeTruthy();
    expect(screen.getByText("orchestrator.job.label")).toBeTruthy();
    expect(screen.getByText("orchestrator.phase.waiting")).toBeTruthy();
    expect(screen.getByText("orchestrator.job.stepsReviewed:4,9")).toBeTruthy();
    expect(screen.getByText("orchestrator.job.needsYou:2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(entry);
  });

  it("names the phase when nothing waits, and keeps back cards to one row", () => {
    const [working] = buildJobStackEntries([{ view: { ...bigJob, decisions: [] }, project }]);
    render(<TaskGlassCard entry={working!} variant="front" />);
    expect(screen.getByText("orchestrator.phase.working")).toBeTruthy();
    cleanup();
    render(<TaskGlassCard entry={working!} variant="back" />);
    expect(screen.queryByText(bigJob.status)).toBeNull();
    expect(screen.getByText("orchestrator.job.label")).toBeTruthy();
  });
});

describe("OrchestratorJobDialog", () => {
  function open(view = bigJob, jobActions = actions(), onOpenConversation = vi.fn()) {
    render(
      <OrchestratorJobDialog
        job={{ view, project }}
        onClose={vi.fn()}
        actions={jobActions}
        onOpenConversation={onOpenConversation}
      />,
    );
    return { jobActions, onOpenConversation, dialog: screen.getByRole("dialog") };
  }

  it("puts what waits on the person first, and answers with the options", async () => {
    const { jobActions, dialog } = open();
    const sections = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(sections).toEqual([
      "orchestrator.section.decisions",
      "orchestrator.section.plan",
      "orchestrator.section.steps",
      "orchestrator.section.rulings",
      "orchestrator.section.board",
    ]);
    expect(screen.getByText("orchestrator.decision.kind.pausedRun")).toBeTruthy();
    expect(screen.getByText("orchestrator.decision.step:Settings search box")).toBeTruthy();
    fireEvent.click(screen.getByText("Keep the change"));
    expect(jobActions.decide).toHaveBeenCalledWith({ view: bigJob, project }, "d-pause", "keep");
    await act(async () => {});
  });

  it("answers a clarify question on the board", () => {
    const { jobActions } = open();
    expect(screen.getByText("orchestrator.decision.kind.clarify")).toBeTruthy();
    fireEvent.click(screen.getByText("orchestrator.decision.answer"));
    const box = screen.getByLabelText("orchestrator.board.placeholder");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Titles and descriptions." } });
    fireEvent.click(screen.getByText("orchestrator.board.post"));
    expect(jobActions.postNote).toHaveBeenCalledWith(
      { view: bigJob, project },
      "Titles and descriptions.",
      undefined,
    );
  });

  it("says when an answer could not be sent", async () => {
    const jobActions = actions();
    jobActions.decide.mockRejectedValueOnce(new Error("no"));
    open(levelVoteJob, jobActions);
    fireEvent.click(screen.getByText("Plan A (claude:fable)"));
    expect(await screen.findByText("orchestrator.decision.failed")).toBeTruthy();
  });

  it("shows the chosen plan: who won, the level vote and each advisor asked", () => {
    open();
    expect(screen.getByText("orchestrator.plan.winner:claude:fable")).toBeTruthy();
    expect(screen.getByText("orchestrator.plan.tied:claude:fable, codex:gpt-6-astra")).toBeTruthy();
    expect(screen.getByText("orchestrator.plan.advisors")).toBeTruthy();
    expect(
      screen.getByText(
        "orchestrator.plan.advisorRanking:claude:opus · high,claude:fable > codex:gpt-6-astra",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(screen.getByText("Plan A reuses the index.", { exact: false })).toBeTruthy();
    expect(
      screen.getByText("orchestrator.plan.advisorRanking:claude:claude-mythos-5-2,claude:fable"),
    ).toBeTruthy();
    expect(screen.getByText("orchestrator.plan.advisorsChose:claude:fable")).toBeTruthy();
    expect(screen.getByText(/1\. Index the settings\./)).toBeTruthy();
    cleanup();
    open(levelVoteJob);
    expect(screen.getAllByText(/^orchestrator\.plan\.advisorRanking:/)).toHaveLength(2);
    expect(
      screen.getByText(
        "orchestrator.plan.advisorFailed:openrouter:google/gemini-4-argon,rate limited",
      ),
    ).toBeTruthy();
    expect(screen.getByText("orchestrator.plan.advisorsUnsettled")).toBeTruthy();
    expect(screen.queryByText(/^orchestrator\.plan\.advisorsChose/)).toBeNull();
    cleanup();
    open(finishedJobs[0]);
    expect(screen.getByText("orchestrator.plan.advisorNoRanking:openrouter:m")).toBeTruthy();
    cleanup();
    open(deliberatingJob);
    expect(screen.getByText("orchestrator.plan.none")).toBeTruthy();
    expect(screen.getByText("orchestrator.steps.empty")).toBeTruthy();
    expect(screen.getByText("orchestrator.board.empty")).toBeTruthy();
    expect(screen.queryByText("orchestrator.section.rulings")).toBeNull();
    expect(screen.queryByText("orchestrator.section.decisions")).toBeNull();
  });

  it("shows each step with who has it, its state, its review and its flags", () => {
    const { onOpenConversation } = open();
    for (const id of [
      "inReview",
      "queued",
      "idea",
      "planned",
      "working",
      "merged",
      "deployed",
      "checked",
      "cancelled",
    ]) {
      expect(screen.getByText(`orchestrator.step.state.${id}`)).toBeTruthy();
    }
    for (const id of ["starting", "working", "waiting", "done", "failed", "stopped"]) {
      expect(
        screen.getAllByText(`orchestrator.run.state.${id}`, { exact: false }).length,
      ).toBeGreaterThan(0);
    }
    expect(screen.getByText("claude:opus · high")).toBeTruthy();
    expect(screen.getByText("codex:gpt-6.1-sol · max · fast")).toBeTruthy();
    expect(screen.getByText("orchestrator.step.unassigned")).toBeTruthy();
    expect(screen.getByText("xatlas/job-big.settings-ui/claude-run-ui")).toBeTruthy();
    expect(screen.getByText("orchestrator.step.after:Search index API")).toBeTruthy();
    expect(
      screen.getByText("orchestrator.review.summary:2,orchestrator.review.verdict.findings"),
    ).toBeTruthy();
    expect(
      screen.getByText("orchestrator.review.summary:1,orchestrator.review.verdict.pass"),
    ).toBeTruthy();
    expect(screen.getByText("orchestrator.finding.severity.blocker")).toBeTruthy();
    expect(screen.getByText("orchestrator.finding.severity.shouldFix")).toBeTruthy();
    expect(screen.getByText("orchestrator.finding.severity.note")).toBeTruthy();
    expect(screen.getByText("src/settings/Search.tsx:42")).toBeTruthy();
    expect(screen.getByText("orchestrator.finding.repeats:f0")).toBeTruthy();
    expect(screen.getByText("orchestrator.flag.check.outsideOwns")).toBeTruthy();
    expect(screen.getByText("orchestrator.flag.check.noCommit")).toBeTruthy();
    expect(screen.getByText("orchestrator.flag.check.emptyReview")).toBeTruthy();
    expect(screen.getByText("orchestrator.flag.action.paused", { exact: false })).toBeTruthy();
    expect(screen.getByText("packages/ui/src/sidebar/filter.ts")).toBeTruthy();

    const conversations = screen.getAllByText("orchestrator.step.openConversation");
    expect(conversations).toHaveLength(2);
    fireEvent.click(conversations[0]!);
    expect(onOpenConversation).toHaveBeenLastCalledWith({ view: bigJob, project }, "conv-api");
    fireEvent.click(screen.getAllByText("orchestrator.step.openReview")[1]!);
    expect(onOpenConversation).toHaveBeenLastCalledWith(
      { view: bigJob, project },
      "conv-ui-review",
    );
  });

  it("shows the chair's rulings and the board, and posts a note to one step", async () => {
    const { jobActions } = open();
    expect(screen.getByText("orchestrator.ruling.ruling.drop")).toBeTruthy();
    expect(
      screen.getByText("orchestrator.ruling.trigger.findingDisputed", { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText("orchestrator.ruling.ruling.owner")).toBeTruthy();
    expect(screen.getByText("orchestrator.ruling.by:claude:claude-mythos-5-2")).toBeTruthy();
    expect(screen.getByText("orchestrator.ruling.finding:f0")).toBeTruthy();

    expect(screen.getByText("orchestrator.note.from.person")).toBeTruthy();
    expect(screen.getByText("orchestrator.note.from.orchestrator")).toBeTruthy();
    expect(screen.getByText("orchestrator.note.from.watcher")).toBeTruthy();
    expect(
      screen.getByText("orchestrator.note.fromStep:Settings search box,claude:opus · high"),
    ).toBeTruthy();
    expect(screen.getByText("run-unknown")).toBeTruthy();
    expect(screen.getByText("orchestrator.note.toStep:Search index API")).toBeTruthy();

    fireEvent.click(screen.getAllByText("orchestrator.step.note")[1]!);
    expect(screen.getAllByText("orchestrator.note.toStep:Settings search box").length).toBe(2);
    const box = screen.getByLabelText("orchestrator.board.placeholder");
    expect(document.activeElement).toBe(box);
    expect((screen.getByText("orchestrator.board.post") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "  Reuse the filter.  " } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(jobActions.postNote).toHaveBeenCalledWith(
      { view: bigJob, project },
      "Reuse the filter.",
      "job-big.settings-ui",
    );
    await act(async () => {});
    expect((box as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByLabelText("orchestrator.board.clearTarget"));
    expect(screen.queryByLabelText("orchestrator.board.clearTarget")).toBeNull();
  });

  it("says when a note could not be posted", async () => {
    const jobActions = actions();
    jobActions.postNote.mockRejectedValueOnce(new Error("no"));
    open(bigJob, jobActions);
    fireEvent.change(screen.getByLabelText("orchestrator.board.placeholder"), {
      target: { value: "Hi" },
    });
    fireEvent.click(screen.getByText("orchestrator.board.post"));
    expect(await screen.findByText("orchestrator.board.failed")).toBeTruthy();
  });

  it("stops a job only after the person confirms", async () => {
    const { jobActions } = open();
    fireEvent.click(screen.getByText("orchestrator.job.stop"));
    expect(jobActions.stopJob).not.toHaveBeenCalled();
    expect(screen.getByText("orchestrator.job.stopConfirm")).toBeTruthy();
    fireEvent.click(screen.getByText("orchestrator.job.stopKeep"));
    expect(screen.queryByText("orchestrator.job.stopConfirm")).toBeNull();

    fireEvent.click(screen.getByText("orchestrator.job.stop"));
    fireEvent.click(screen.getByText("orchestrator.job.stop"));
    expect(jobActions.stopJob).toHaveBeenCalledWith({ view: bigJob, project });
    await act(async () => {});
    expect(screen.queryByText("orchestrator.job.stopConfirm")).toBeNull();
  });

  it("says when stopping failed", async () => {
    const jobActions = actions();
    jobActions.stopJob.mockRejectedValueOnce(new Error("no"));
    open(bigJob, jobActions);
    fireEvent.click(screen.getByText("orchestrator.job.stop"));
    fireEvent.click(screen.getByText("orchestrator.job.stop"));
    expect(await screen.findByText("orchestrator.job.stopFailed")).toBeTruthy();
  });

  it("offers no stop for a finished job", () => {
    for (const job of finishedJobs) {
      open(job);
      expect(screen.getByText(`orchestrator.phase.${job.phase}`)).toBeTruthy();
      expect(screen.queryByText("orchestrator.job.stop")).toBeNull();
      cleanup();
    }
  });

  it("starts afresh for another job, so a note can't reach the wrong one", () => {
    const jobActions = actions();
    const props = { onClose: vi.fn(), actions: jobActions, onOpenConversation: vi.fn() };
    const { rerender } = render(
      <OrchestratorJobDialog job={{ view: bigJob, project }} {...props} />,
    );
    fireEvent.change(screen.getByLabelText("orchestrator.board.placeholder"), {
      target: { value: "For the big job" },
    });
    rerender(<OrchestratorJobDialog job={{ view: levelVoteJob, project }} {...props} />);
    expect(
      (screen.getByLabelText("orchestrator.board.placeholder") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("is closed when there is no job", () => {
    render(
      <OrchestratorJobDialog
        job={null}
        onClose={vi.fn()}
        actions={actions()}
        onOpenConversation={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
