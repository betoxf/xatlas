import { useRef, useState, type ReactNode } from "react";
import { Flag, GitBranch, MessageSquare, Square, X } from "lucide-react";
import type { OrchestratorDecision, OrchestratorJobView, OrchestratorNote } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  DECISION_KIND_LABEL,
  FLAG_ACTION_LABEL,
  FLAG_CHECK_LABEL,
  NOTE_AUTHOR_LABEL,
  RULING_LABEL,
  RULING_TRIGGER_LABEL,
  RUN_STATE_LABEL,
  SEVERITY_LABEL,
  STEP_STATE_LABEL,
  VERDICT_LABEL,
  formatAdvisorChoice,
  formatModelChoice,
  jobStatusLabelId,
  type AdvisorAnswer,
  type ChairRuling,
  type ReviewFindingView,
  type StepFlag,
} from "./orchestratorLabels.js";
import type { OrchestratorJobActions, OrchestratorStackJob } from "./useOrchestratorJobs.js";

type Step = OrchestratorJobView["steps"][number];
type Format = (id: string, values?: Record<string, string>) => string;

const FINISHED_PHASES = new Set<OrchestratorJobView["phase"]>(["done", "failed", "stopped"]);

const SEVERITY_CLASS: Record<ReviewFindingView["severity"], string> = {
  blocker: "text-destructive",
  "should-fix": "text-warning",
  note: "text-foreground-subtle",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <h3 className="text-ui-sm font-medium text-foreground-subtle">{title}</h3>
      {children}
    </section>
  );
}

function stepTitle(steps: readonly Step[], taskId: string): string {
  return steps.find((step) => step.taskId === taskId)?.title ?? taskId;
}

function noteAuthor(note: OrchestratorNote, steps: readonly Step[], format: Format): string {
  if (Object.hasOwn(NOTE_AUTHOR_LABEL, note.from)) return format(NOTE_AUTHOR_LABEL[note.from]!);
  const step = steps.find((candidate) => candidate.run?.runId === note.from);
  return step?.run
    ? format("orchestrator.note.fromStep", {
        step: step.title,
        model: formatModelChoice(step.run.choice),
      })
    : note.from;
}

function Decisions({
  job,
  format,
  onDecide,
  onAnswer,
}: {
  job: OrchestratorJobView;
  format: Format;
  onDecide: (decision: OrchestratorDecision, optionId: string) => Promise<void>;
  /** A "clarify" question is answered with a note on the board. */
  onAnswer: (decision: OrchestratorDecision) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (job.decisions.length === 0) return null;
  return (
    <Section title={format("orchestrator.section.decisions")}>
      <ul className="flex flex-col gap-2">
        {job.decisions.map((decision) => (
          <li
            key={decision.id}
            className="flex flex-col gap-2 rounded-xl border border-card-border bg-card px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2 text-ui-sm text-warning">
              <span className="font-medium">{format(DECISION_KIND_LABEL[decision.kind])}</span>
              {decision.taskId ? (
                <span className="min-w-0 truncate text-foreground-subtle">
                  {format("orchestrator.decision.step", {
                    step: stepTitle(job.steps, decision.taskId),
                  })}
                </span>
              ) : null}
            </span>
            <p className="text-ui-base text-foreground">{decision.question}</p>
            <span className="flex flex-wrap gap-2">
              {decision.options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(decision.id);
                    setFailed(null);
                    onDecide(decision, option.id)
                      .catch(() => setFailed(decision.id))
                      .finally(() => setBusy(null));
                  }}
                >
                  {option.label}
                </Button>
              ))}
              {decision.kind === "clarify" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onAnswer(decision)}
                >
                  {format("orchestrator.decision.answer")}
                </Button>
              ) : null}
            </span>
            {failed === decision.id ? (
              <p className="text-ui-sm text-destructive">
                {format("orchestrator.decision.failed")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Plan({ plan, format }: { plan: OrchestratorJobView["plan"]; format: Format }) {
  if (!plan) {
    return (
      <Section title={format("orchestrator.section.plan")}>
        <p className="text-ui-sm text-foreground-subtle">{format("orchestrator.plan.none")}</p>
      </Section>
    );
  }
  return (
    <Section title={format("orchestrator.section.plan")}>
      {plan.winner ? (
        <p className="text-ui-sm text-foreground-subtle">
          {format("orchestrator.plan.winner", { seat: plan.winner })}
        </p>
      ) : null}
      {plan.tied && plan.tied.length > 0 ? (
        <p className="text-ui-sm text-foreground-subtle">
          {format("orchestrator.plan.tied", { seats: plan.tied.join(", ") })}
        </p>
      ) : null}
      {plan.advisors && plan.advisors.length > 0 ? (
        <Advisors answers={plan.advisors} order={plan.advisorOrder} format={format} />
      ) : null}
      {plan.text ? (
        <p className="max-h-48 overflow-y-auto rounded-xl border border-card-border bg-surface px-3 py-2 text-ui-sm whitespace-pre-wrap text-foreground">
          {plan.text}
        </p>
      ) : null}
    </Section>
  );
}

/** Each outside advisor asked about the level vote, what it ranked and why, and what they chose. */
function Advisors({
  answers,
  order,
  format,
}: {
  answers: readonly AdvisorAnswer[];
  order: readonly string[] | undefined;
  format: Format;
}) {
  return (
    <div className="flex flex-col gap-1 text-ui-sm text-foreground-subtle">
      <p>{format("orchestrator.plan.advisors")}</p>
      <ul className="flex flex-col gap-1">
        {answers.map((answer, index) => {
          const model = formatAdvisorChoice(answer.choice);
          return (
            <li key={`${index}:${model}`} className="min-w-0 break-words">
              {answer.error
                ? format("orchestrator.plan.advisorFailed", { model, error: answer.error })
                : answer.ranking && answer.ranking.length > 0
                  ? format("orchestrator.plan.advisorRanking", {
                      model,
                      ranking: answer.ranking.join(" > "),
                    })
                  : format("orchestrator.plan.advisorNoRanking", { model })}
              {answer.reason ? (
                <span className="text-foreground-subtlest"> {answer.reason}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p>
        {order?.[0]
          ? format("orchestrator.plan.advisorsChose", { seat: order[0] })
          : format("orchestrator.plan.advisorsUnsettled")}
      </p>
    </div>
  );
}

function Findings({
  findings,
  format,
}: {
  findings: readonly ReviewFindingView[];
  format: Format;
}) {
  if (findings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {findings.map((finding) => (
        <li key={finding.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-ui-sm">
          <span className={cn("shrink-0 font-medium", SEVERITY_CLASS[finding.severity])}>
            {format(SEVERITY_LABEL[finding.severity])}
          </span>
          {finding.lens ? (
            <span className="shrink-0 text-foreground-subtlest">{finding.lens}</span>
          ) : null}
          {finding.file ? (
            <span className="min-w-0 truncate font-mono text-foreground-subtle">
              {finding.line ? `${finding.file}:${finding.line}` : finding.file}
            </span>
          ) : null}
          <span className="min-w-0 basis-full text-foreground">{finding.text}</span>
          {finding.repeats ? (
            <span className="text-foreground-subtlest">
              {format("orchestrator.finding.repeats", { id: finding.repeats })}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Flags({ flags, format }: { flags: readonly StepFlag[]; format: Format }) {
  if (flags.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {flags.map((flag) => (
        <li key={`${flag.at}:${flag.check}`} className="flex min-w-0 items-start gap-2 text-ui-sm">
          <Flag
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              flag.action === "paused" ? "text-warning" : "text-foreground-subtle",
            )}
          />
          <span className="flex min-w-0 flex-col">
            <span className="text-foreground">
              {format(FLAG_CHECK_LABEL[flag.check])}
              <span
                className={flag.action === "paused" ? "text-warning" : "text-foreground-subtle"}
              >
                {" · "}
                {format(FLAG_ACTION_LABEL[flag.action])}
              </span>
            </span>
            <span className="text-foreground-subtle">{flag.detail}</span>
            {flag.paths && flag.paths.length > 0 ? (
              <span className="truncate font-mono text-foreground-subtlest">
                {flag.paths.join(", ")}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StepItem({
  step,
  steps,
  format,
  onOpenConversation,
  onNote,
}: {
  step: Step;
  steps: readonly Step[];
  format: Format;
  onOpenConversation: (conversationId: string) => void;
  onNote: (taskId: string) => void;
}) {
  const run = step.run;
  const review = step.review;
  return (
    <li className="flex flex-col gap-1.5 rounded-xl border border-card-border bg-card px-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {step.title}
        </span>
        <span className="shrink-0 text-ui-sm text-foreground-subtle">
          {format(STEP_STATE_LABEL[step.state])}
        </span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
        {run ? (
          <span className="min-w-0 truncate">
            <span className="font-mono">{formatModelChoice(run.choice)}</span>
            {" · "}
            {format(RUN_STATE_LABEL[run.state])}
          </span>
        ) : (
          <span>{format("orchestrator.step.unassigned")}</span>
        )}
        {run?.branch ? (
          <span className="flex min-w-0 items-center gap-1">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{run.branch}</span>
          </span>
        ) : null}
      </span>
      {step.dependsOn.length > 0 ? (
        <span className="truncate text-ui-sm text-foreground-subtlest">
          {format("orchestrator.step.after", {
            steps: step.dependsOn.map((taskId) => stepTitle(steps, taskId)).join(", "),
          })}
        </span>
      ) : null}
      {step.owns.length > 0 ? (
        <span className="truncate text-ui-sm text-foreground-subtlest">
          {format("orchestrator.step.owns")}{" "}
          <span className="font-mono">{step.owns.join(", ")}</span>
        </span>
      ) : null}
      {review ? (
        <span className="flex flex-col gap-1">
          <span
            className={cn(
              "text-ui-sm font-medium",
              review.verdict === "pass" ? "text-success" : "text-foreground",
            )}
          >
            {format("orchestrator.review.summary", {
              round: String(review.round),
              verdict: format(VERDICT_LABEL[review.verdict]),
            })}
          </span>
          <Findings findings={review.findings} format={format} />
        </span>
      ) : null}
      <Flags flags={step.flags} format={format} />
      <span className="flex flex-wrap gap-1">
        {run?.conversationId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenConversation(run.conversationId!)}
          >
            {format("orchestrator.step.openConversation")}
          </Button>
        ) : null}
        {review?.conversationId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenConversation(review.conversationId!)}
          >
            {format("orchestrator.step.openReview")}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={() => onNote(step.taskId)}>
          {format("orchestrator.step.note")}
        </Button>
      </span>
    </li>
  );
}

function Rulings({ job, format }: { job: OrchestratorJobView; format: Format }) {
  if (job.rulings.length === 0) return null;
  return (
    <Section title={format("orchestrator.section.rulings")}>
      <ul className="flex flex-col gap-2">
        {job.rulings.map((ruling: ChairRuling) => (
          <li key={`${ruling.at}:${ruling.trigger}`} className="flex flex-col gap-0.5 text-ui-sm">
            <span className="text-foreground">
              <span className="font-medium">{format(RULING_LABEL[ruling.ruling])}</span>
              <span className="text-foreground-subtle">
                {" · "}
                {format(RULING_TRIGGER_LABEL[ruling.trigger])}
              </span>
            </span>
            <span className="text-foreground-subtle">{ruling.text}</span>
            <span className="flex flex-wrap gap-x-3 text-foreground-subtlest">
              <span>{format("orchestrator.ruling.by", { seat: ruling.chair })}</span>
              {ruling.findingId ? (
                <span>{format("orchestrator.ruling.finding", { id: ruling.findingId })}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * An opened job: what waits on the person first, then the plan, each step with who has it and
 * how its review went, the chair's rulings, and the board, where the person can post.
 */
export function OrchestratorJobDialog({
  job,
  onClose,
  actions,
  onOpenConversation,
}: {
  job: OrchestratorStackJob | null;
  onClose: () => void;
  actions: OrchestratorJobActions;
  onOpenConversation: (job: OrchestratorStackJob, conversationId: string) => void;
}) {
  return (
    <Dialog open={Boolean(job)} onOpenChange={(open) => !open && onClose()}>
      {job ? (
        // Keyed by job: a note typed for one job must never be posted to another.
        <JobDialogContent
          key={`${job.project.key}\0${job.view.jobId}`}
          job={job}
          actions={actions}
          onOpenConversation={onOpenConversation}
        />
      ) : null}
    </Dialog>
  );
}

function JobDialogContent({
  job,
  actions,
  onOpenConversation,
}: {
  job: OrchestratorStackJob;
  actions: OrchestratorJobActions;
  onOpenConversation: (job: OrchestratorStackJob, conversationId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const format: Format = (id, values) => intl.formatMessage({ id }, values);
  const [noteTo, setNoteTo] = useState<string | undefined>(undefined);
  const [noteText, setNoteText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postFailed, setPostFailed] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const view = job.view;

  const postNote = () => {
    const text = noteText.trim();
    if (!text || posting) return;
    setPosting(true);
    setPostFailed(false);
    actions
      .postNote(job, text, noteTo)
      .then(() => setNoteText(""))
      .catch(() => setPostFailed(true))
      .finally(() => setPosting(false));
  };

  const stop = () => {
    setStopping(true);
    setStopFailed(false);
    actions
      .stopJob(job)
      .then(() => setConfirmStop(false))
      .catch(() => setStopFailed(true))
      .finally(() => setStopping(false));
  };

  return (
    <DialogContent className="flex max-h-168 max-w-3xl flex-col gap-0 overflow-hidden p-0">
      <header className="flex shrink-0 flex-col gap-1 px-4 pt-4 pr-12 pb-3">
        <span className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground-subtle">
          <span className="truncate">{job.project.name}</span>
          <span className="shrink-0">·</span>
          <span className={cn("shrink-0", view.decisions.length > 0 && "text-warning")}>
            {format(jobStatusLabelId(view))}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 text-foreground-subtlest">
            {formatTaskRelativeTime(Date.parse(view.updatedAt), intl)}
          </span>
        </span>
        <DialogTitle className="text-ui-lg">
          {view.title || format("orchestrator.job.untitled")}
        </DialogTitle>
        <DialogDescription className="text-ui-sm">{view.status}</DialogDescription>
        {FINISHED_PHASES.has(view.phase) ? null : confirmStop ? (
          <span className="mt-1 flex flex-wrap items-center gap-2 text-ui-sm text-foreground">
            <span className="min-w-0 flex-1">{format("orchestrator.job.stopConfirm")}</span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={stopping}
              onClick={stop}
            >
              {format("orchestrator.job.stop")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={stopping}
              onClick={() => setConfirmStop(false)}
            >
              {format("orchestrator.job.stopKeep")}
            </Button>
          </span>
        ) : (
          <span className="mt-1 flex">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1"
              onClick={() => setConfirmStop(true)}
            >
              <Square className="size-3" />
              {format("orchestrator.job.stop")}
            </Button>
          </span>
        )}
        {stopFailed ? (
          <p className="text-ui-sm text-destructive">{format("orchestrator.job.stopFailed")}</p>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Decisions
          job={view}
          format={format}
          onDecide={(decision, optionId) => actions.decide(job, decision.id, optionId)}
          onAnswer={(decision) => {
            setNoteTo(decision.taskId);
            noteRef.current?.focus();
          }}
        />
        <Plan plan={view.plan} format={format} />
        <Section title={format("orchestrator.section.steps")}>
          {view.steps.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {format("orchestrator.steps.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {view.steps.map((step) => (
                <StepItem
                  key={step.taskId}
                  step={step}
                  steps={view.steps}
                  format={format}
                  onOpenConversation={(conversationId) => onOpenConversation(job, conversationId)}
                  onNote={(taskId) => {
                    setNoteTo(taskId);
                    noteRef.current?.focus();
                  }}
                />
              ))}
            </ul>
          )}
        </Section>
        <Rulings job={view} format={format} />
        <Section title={format("orchestrator.section.board")}>
          {view.notes.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {format("orchestrator.board.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {view.notes.map((note, index) => (
                <li key={`${note.at}:${index}`} className="flex flex-col gap-0.5 text-ui-sm">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-foreground-subtle">
                    <MessageSquare className="size-3.5 shrink-0" />
                    <span className="font-medium text-foreground">
                      {noteAuthor(note, view.steps, format)}
                    </span>
                    <span>
                      {note.to
                        ? format("orchestrator.note.toStep", {
                            step: stepTitle(view.steps, note.to),
                          })
                        : format("orchestrator.note.toEveryone")}
                    </span>
                    <span className="text-foreground-subtlest">
                      {formatTaskRelativeTime(Date.parse(note.at), intl)}
                    </span>
                  </span>
                  <span className="whitespace-pre-wrap text-foreground">{note.text}</span>
                </li>
              ))}
            </ul>
          )}
          <span className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground-subtle">
            <span className="min-w-0 truncate">
              {noteTo
                ? format("orchestrator.note.toStep", { step: stepTitle(view.steps, noteTo) })
                : format("orchestrator.note.toEveryone")}
            </span>
            {noteTo ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={format("orchestrator.board.clearTarget")}
                onClick={() => setNoteTo(undefined)}
              >
                <X />
              </Button>
            ) : null}
          </span>
          <Textarea
            ref={noteRef}
            value={noteText}
            rows={2}
            aria-label={format("orchestrator.board.placeholder")}
            placeholder={format("orchestrator.board.placeholder")}
            onChange={(event) => setNoteText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                postNote();
              }
            }}
          />
          <span className="flex items-center gap-2">
            {postFailed ? (
              <span className="min-w-0 flex-1 text-ui-sm text-destructive">
                {format("orchestrator.board.failed")}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <Button
              type="button"
              size="sm"
              disabled={posting || !noteText.trim()}
              onClick={postNote}
            >
              {format("orchestrator.board.post")}
            </Button>
          </span>
        </Section>
      </div>
    </DialogContent>
  );
}
