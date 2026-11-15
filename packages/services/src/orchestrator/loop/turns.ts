import { randomUUID } from "node:crypto";
import { boardDigest } from "@zcode/orchestrator/board";
import {
  findingsMessage,
  lensesFor,
  passes,
  readAdvice,
  readDisputes,
  readReview,
  reminderFor,
  reviewPrompt,
  MAX_WATCHER_CALLS,
  turnEndFlags,
  watcherPrompt,
  type OversightFlag,
} from "@zcode/orchestrator/oversight";
import { pickRole } from "@zcode/orchestrator/routing";
import {
  MAX_REVIEW_ROUNDS,
  type LedgerData,
  type LedgerEntry,
  type ReviewFinding,
  type Run,
  type RunIdentity,
  type Task,
} from "@zcode/orchestrator/types";
import {
  background,
  entriesOf,
  errorText,
  inStep,
  jobClosed,
  ledgerOf,
  openDecision,
  runIn,
  signalOf,
  taskIn,
  type JobRef,
  type Loop,
} from "./context.js";
import { chairDisputes, chairStuck } from "./chair.js";
import {
  changedLines,
  changedPaths,
  commitCount,
  commitsMissingTrailers,
  hasDesignDoc,
  headOf,
  uncommittedPaths,
} from "./gitFacts.js";
import { claimRun, ClaimRefused, deliver, interrupt } from "./guard.js";
import { CARRY_ON, REVIEW_ASK_AGAIN, REVIEW_CARRY_ON, trailerLines } from "./prompts.js";
import {
  allowedPaths,
  askedCommit,
  droppedFindings,
  reminderId,
  reviewAskNote,
  ruledFindings,
  runBase,
  watcherCallNote,
  watcherCalls,
} from "./records.js";
import { kickJob, latestRun, moveTaskTo, setRunState } from "./steps.js";

/** A run whose turn the loop waits on. */
export interface WatchedRun {
  readonly taskId: string;
  readonly runId: string;
  readonly role: "executor" | "reviewer";
  readonly conversationId: string;
}

type ReviewEntry = Extract<LedgerEntry, { kind: "review.decided" }>;
type TurnResult = Awaited<ReturnType<Loop["host"]["waitForTurn"]>>;

/**
 * Waits for a run's turn to end, outside every queue, then handles the end in the step's
 * queue. A wait that fails becomes a decision for the person.
 */
export function watchTurn(loop: Loop, job: JobRef, run: WatchedRun): void {
  const signal = signalOf(loop, job);
  const where = {
    stage: run.role === "executor" ? ("turn" as const) : ("review" as const),
    taskId: run.taskId,
    what: `handling the end of a ${run.role}'s turn`,
  };
  void loop.host
    .waitForTurn({ project: job.project, conversationId: run.conversationId, signal })
    .then(
      (result) => {
        if (signal.aborted) return;
        background(loop, job, where, () =>
          inStep(loop, job, run.taskId, () => turnEnded(loop, job, run, result)),
        );
      },
      (error: unknown) => {
        if (signal.aborted) return;
        background(loop, job, where, () =>
          inStep(loop, job, run.taskId, () => lostTurn(loop, job, run, errorText(error))),
        );
      },
    );
}

function identityOf(run: Run): RunIdentity {
  return {
    runId: run.id,
    taskId: run.taskId,
    agent: run.choice.agent,
    ...(run.choice.model ? { model: run.choice.model } : {}),
  };
}

function short(text: string, max = 400): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The run, when it is still the one the step's work belongs to and has not ended. */
function liveRun(entries: readonly LedgerEntry[], runId: string): Run | undefined {
  const run = runIn(entries, runId);
  return run && (run.state === "working" || run.state === "waiting") ? run : undefined;
}

async function turnEnded(loop: Loop, job: JobRef, watched: WatchedRun, result: TurnResult) {
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId)) return;
  const run = runIn(entries, watched.runId);
  // A run that was stopped or taken over in the meantime has nothing left to say.
  if (run?.state !== "working") return;
  if (result.status === "failed" && loop.interrupted.has(watched.conversationId)) return;
  if (watched.role === "reviewer") return reviewerTurnEnded(loop, job, run, result);
  if (result.status === "failed") {
    await setRunState(ledgerOf(loop, job), run.id, "waiting", "Its turn failed.");
    return openDecision(loop, job, {
      about: "turn",
      kind: "blocked",
      taskId: run.taskId,
      runId: run.id,
      role: "executor",
      question: `Step "${titleOf(entries, run.taskId)}"'s executor turn failed. Open its conversation to see why, then let it carry on or give the step to another executor.`,
      options: ["resume", "reassign", "stop-step"],
    });
  }
  if (result.status === "needs_attention") return asked(loop, job, run, result.text);
  return checkTurn(loop, job, run.id, result.text);
}

function titleOf(entries: readonly LedgerEntry[], taskId: string): string {
  return taskIn(entries, taskId)?.title ?? taskId;
}

/** The app can't see the run's turn any more: the person decides whether it carries on. */
export async function lostTurn(loop: Loop, job: JobRef, watched: WatchedRun, why: string) {
  const entries = await entriesOf(loop, job);
  if (jobClosed(entries, job.jobId) || !liveRun(entries, watched.runId)) return;
  await setRunState(
    ledgerOf(loop, job),
    watched.runId,
    "waiting",
    "The app lost track of its turn.",
  );
  await openDecision(loop, job, {
    about: "turn",
    kind: "blocked",
    taskId: watched.taskId,
    runId: watched.runId,
    role: watched.role,
    question: `The app lost track of step "${titleOf(entries, watched.taskId)}"'s ${watched.role} (${why}). Open its conversation; let it carry on when you are ready, or stop the step.`,
    options:
      watched.role === "executor" ? ["resume", "reassign", "stop-step"] : ["resume", "stop-step"],
  });
}

/**
 * A message for a reviewer, carrying a new token it is asked to echo: a turn with no text may
 * hand back the reply before, and a real reply may read the same as the last one (the same
 * pass), so only the token tells them apart.
 */
function toReviewer(text: string): { readonly text: string; readonly token: string } {
  const token = randomUUID().slice(0, 8);
  return {
    text: `${text}\n\nAdd the field "reply": "${token}" to your JSON object, so this answer can be told from an earlier one.`,
    token,
  };
}

/** Sends a reviewer its next message, keeping the token its reply should carry. */
async function askReviewer(
  loop: Loop,
  job: JobRef,
  reviewer: Run,
  text: string,
  again: boolean,
): Promise<void> {
  const message = toReviewer(text);
  loop.reviewAsks.set(reviewer.conversationId!, { token: message.token, again });
  return sendAndWatch(loop, job, reviewer, message.text);
}

/** A run the person let go on gets a short message and is waited on again. */
export async function resumeRun(loop: Loop, job: JobRef, runId: string): Promise<void> {
  const entries = await entriesOf(loop, job);
  const run = liveRun(entries, runId);
  if (!run?.conversationId) return;
  if (run.role === "reviewer") return askReviewer(loop, job, run, REVIEW_CARRY_ON, false);
  return sendAndWatch(loop, job, run, CARRY_ON);
}

/** The person answered the run in its conversation: its turn is waited on again, nothing sent. */
export async function rewatchRun(loop: Loop, job: JobRef, runId: string): Promise<void> {
  const run = liveRun(await entriesOf(loop, job), runId);
  if (!run?.conversationId) return;
  await setRunState(ledgerOf(loop, job), run.id, "working");
  watchTurn(loop, job, {
    taskId: run.taskId,
    runId: run.id,
    role: run.role === "reviewer" ? "reviewer" : "executor",
    conversationId: run.conversationId,
  });
}

/**
 * Sends a run its next message and waits on that turn. Nothing is sent to a stopped job or
 * run: the check is made at the moment of sending, after any stop in flight.
 */
async function sendAndWatch(loop: Loop, job: JobRef, run: Run, text: string): Promise<void> {
  if (!(await deliver(loop, job, run.id, run.conversationId!, text))) return;
  await setRunState(ledgerOf(loop, job), run.id, "working");
  watchTurn(loop, job, {
    taskId: run.taskId,
    runId: run.id,
    role: run.role === "reviewer" ? "reviewer" : "executor",
    conversationId: run.conversationId!,
  });
}

/**
 * The port can't tell a question from a permission prompt ("needs_attention" for both), so a
 * stop with no text or with these words is taken as a request for permission, which the
 * watcher never answers.
 */
const PERMISSION =
  /\b(permission|permit|allow|approve|approval|authori[sz]e|grant|may i|can i (run|use|install|access))\b/i;

/**
 * Asks the watcher about a run, within its calls. The call is written before it is made, so a
 * failed or unreadable one counts against the cap too. Returns the advice, or why there is none.
 */
async function askWatcher(
  loop: Loop,
  job: JobRef,
  run: Run,
  input: Omit<Parameters<typeof watcherPrompt>[0], "digest">,
): Promise<{ advice?: LedgerData["watcher.advised"]; why: string } | undefined> {
  const entries = await entriesOf(loop, job);
  const calls = watcherCalls(entries, run.id);
  if (calls >= MAX_WATCHER_CALLS) return undefined;
  const roles = await loop.roles.get(job.key);
  const pick = pickRole("watcher", roles, await loop.host.agents(), { now: loop.now() });
  if (!pick.ok) return { why: ` ${pick.reason}` };
  await ledgerOf(loop, job).record(watcherCallNote(run.taskId, run.id, calls + 1));
  let reply: string;
  try {
    reply = await loop.host.ask(
      pick.choice,
      watcherPrompt({ ...input, digest: boardDigest(entries, run.taskId) }),
      { cwd: run.worktreePath ?? job.project.workspacePath, signal: signalOf(loop, job) },
    );
  } catch (error) {
    return { why: ` The watcher couldn't be asked: ${errorText(error)}.` };
  }
  const read = readAdvice(reply);
  if (!read) return { why: " The watcher's advice couldn't be read." };
  const advice = { trigger: input.trigger, ...read, choice: pick.choice };
  await ledgerOf(loop, job).record({
    kind: "watcher.advised",
    taskId: run.taskId,
    runId: run.id,
    data: advice,
  });
  return { advice, why: "" };
}

/**
 * The run stopped to ask something. A message sent now would queue behind the question, so it
 * is always the person's to answer, in the conversation. The watcher (within its calls, never
 * for a permission request) adds its advice as a note on the board for the person to use.
 */
async function asked(loop: Loop, job: JobRef, run: Run, text: string): Promise<void> {
  const entries = await entriesOf(loop, job);
  const task = taskIn(entries, run.taskId)!;
  const fresh = text.trim() !== "" && text !== loop.lastText.get(run.conversationId!);
  loop.lastText.set(run.conversationId!, text);
  const permission = !fresh || PERMISSION.test(text);
  let why = "";
  if (!permission) {
    const watched = await askWatcher(loop, job, run, {
      trigger: "waiting",
      step: stepOf(job, task),
      question: text,
      lastMessages: [text],
    });
    if (signalOf(loop, job).aborted) return;
    why = watched?.why ?? "";
    if (watched?.advice) {
      await ledgerOf(loop, job).record({
        kind: "note",
        taskId: run.taskId,
        data: { from: "watcher", to: run.taskId, text: watched.advice.text },
      });
      why = ` The watcher's ${watched.advice.advice === "note" ? "suggestion" : `advice (${watched.advice.advice})`}, on the board: ${short(watched.advice.text, 300)}`;
    }
  }
  await setRunState(ledgerOf(loop, job), run.id, "waiting", "It stopped to ask something.");
  await openDecision(loop, job, {
    about: "asked",
    kind: "blocked",
    taskId: run.taskId,
    runId: run.id,
    role: "executor",
    question: `Step "${task.title}"'s executor stopped to ask${permission ? " for permission" : ""}${fresh ? `: "${short(text)}"` : "."}${why} Answer it in its conversation and say so here, or stop the step.`,
    options: ["answered", "stop-step"],
  });
}

function stepOf(job: JobRef, task: Task) {
  return {
    key: task.id.startsWith(`${job.jobId}.`) ? task.id.slice(job.jobId.length + 1) : task.id,
    title: task.title,
    brief: task.brief,
    owns: task.owns,
  };
}

function reviewsOf(entries: readonly LedgerEntry[], runId: string): ReviewEntry[] {
  return entries.filter(
    (entry): entry is ReviewEntry => entry.kind === "review.decided" && entry.runId === runId,
  );
}

/** Every finding the step's reviews gave, so new ids never repeat an old one. */
function taskFindings(entries: readonly LedgerEntry[], taskId: string): ReviewFinding[] {
  return entries.flatMap((entry) =>
    entry.kind === "review.decided" && entry.taskId === taskId ? entry.data.findings : [],
  );
}

/** What git says about an executor's work: against the commit the loop started it from. */
async function workOf(loop: Loop, entries: readonly LedgerEntry[], run: Run) {
  const base = runBase(entries, run.id);
  if (!base || !run.worktreePath)
    throw new Error("the run has no recorded start commit or worktree");
  const git = loop.host.git;
  const cwd = run.worktreePath;
  const head = await headOf(git, cwd);
  const lastReview = reviewsOf(entries, run.id).at(-1);
  return {
    base,
    head,
    lastReview,
    changed: await changedPaths(git, cwd, base, head),
    uncommitted: await uncommittedPaths(git, cwd),
    newCommits: await commitCount(git, cwd, lastReview?.data.commit ?? base, head),
    missing: await commitsMissingTrailers(git, cwd, base, head, identityOf(run)),
  };
}

async function recordFlags(
  loop: Loop,
  job: JobRef,
  run: Run,
  flags: readonly OversightFlag[],
): Promise<void> {
  for (const flag of flags) {
    await ledgerOf(loop, job).record({
      kind: "oversight.flagged",
      taskId: run.taskId,
      runId: run.id,
      data: flag,
    });
  }
}

/**
 * An executor's turn ended: the code checks, then disputes, the one reminder, and the review.
 * `text` is "" when the turn's reply was already handled (the person let a paused run go on).
 */
export async function checkTurn(loop: Loop, job: JobRef, runId: string, text: string) {
  const entries = await entriesOf(loop, job);
  const run = liveRun(entries, runId);
  if (!run?.conversationId) return;
  const task = taskIn(entries, run.taskId)!;
  const project = ledgerOf(loop, job);
  const work = await workOf(loop, entries, run);
  const fresh = text.trim() !== "" && text !== loop.lastText.get(run.conversationId);
  if (text) loop.lastText.set(run.conversationId, text);

  const previous = work.lastReview?.data;
  const ruled = ruledFindings(entries, job.jobId, run.taskId);
  const disputes =
    fresh && previous?.verdict === "findings"
      ? readDisputes(text, previous.findings).filter((dispute) => !ruled.has(dispute.findingId))
      : [];
  const allowed = allowedPaths(entries, job.jobId, run.id);
  let flags = turnEndFlags({
    role: "executor",
    owns: task.owns,
    changedPaths: work.changed.filter((path) => !allowed.has(path)),
    newCommits: work.newCommits,
    uncommittedPaths: work.uncommitted.filter((path) => !allowed.has(path)),
    commitsMissingTrailers: work.missing,
  });
  // A turn that only disputes findings rightly commits nothing, and so may one after the
  // final read that found nothing for this step.
  const mayCommitNothing = disputes.length > 0 || previous?.verdict === "pass";
  if (mayCommitNothing) flags = flags.filter((flag) => flag.check !== "no-commit");
  await recordFlags(loop, job, run, flags);

  const outside = flags.find((flag) => flag.check === "outside-owns");
  if (outside) {
    await setRunState(project, run.id, "waiting", "Paused: it changed files outside its step.");
    return openDecision(loop, job, {
      about: "paused",
      kind: "paused-run",
      taskId: run.taskId,
      runId: run.id,
      paths: outside.paths ?? [],
      question: `Step "${task.title}"'s executor was paused. ${outside.detail} Let it carry on with those changes, give the step to another executor, or stop it.`,
      options: ["resume", "reassign", "stop-step"],
    });
  }
  if (disputes.length > 0) return chairDisputes(loop, job, run.id, disputes, previous!.findings);

  const reminded = entries.some((entry) => entry.id === reminderId(run.id));
  const noCommit = !mayCommitNothing && work.newCommits === 0;
  if ((noCommit || work.missing > 0) && !reminded) {
    const reminder = reminderFor({
      newCommits: mayCommitNothing ? 1 : work.newCommits,
      commitsMissingTrailers: work.missing,
      uncommittedPaths: work.uncommitted,
      trailers: trailerLines(identityOf(run)),
    });
    if (reminder) {
      await project.record({
        id: reminderId(run.id),
        kind: "note",
        taskId: run.taskId,
        data: { from: "orchestrator", to: run.taskId, text: reminder },
      });
      return sendAndWatch(loop, job, run, reminder);
    }
  }
  if (work.head === work.base) {
    await setRunState(project, run.id, "waiting", "It committed nothing.");
    return openDecision(loop, job, {
      about: "turn",
      kind: "blocked",
      taskId: run.taskId,
      runId: run.id,
      role: "executor",
      question: `Step "${task.title}"'s executor ended its turn without committing anything${reminded ? ", even after a reminder" : ""}, so there is nothing to review. Let it carry on, give the step to another executor, or stop it.`,
      options: ["resume", "reassign", "stop-step"],
    });
  }
  return reviewRound(loop, job, run.id);
}

/** The round an executor run's next review is: after the last round, the last round again. */
function nextRound(entries: readonly LedgerEntry[], runId: string): number {
  return Math.min(reviewsOf(entries, runId).length + 1, MAX_REVIEW_ROUNDS);
}

async function lensesOf(
  run: Run,
  changed: readonly string[],
): Promise<ReturnType<typeof lensesFor>> {
  return lensesFor({
    changedPaths: changed,
    hasDesignDoc: run.worktreePath ? await hasDesignDoc(run.worktreePath) : false,
  });
}

/** Sends the step to its reviewer: the same conversation for later rounds, a new one at first. */
export async function reviewRound(loop: Loop, job: JobRef, executorRunId: string) {
  const entries = await entriesOf(loop, job);
  const run = liveRun(entries, executorRunId);
  if (!run) return;
  const task = taskIn(entries, run.taskId)!;
  const project = ledgerOf(loop, job);
  const base = runBase(entries, run.id)!;
  const head = await headOf(loop.host.git, run.worktreePath!);
  const changed = await changedPaths(loop.host.git, run.worktreePath!, base, head);
  const dropped = droppedFindings(entries, job.jobId, task.id);
  const prompt = reviewPrompt({
    round: nextRound(entries, run.id),
    title: task.title,
    brief: task.brief,
    owns: task.owns,
    baseSha: base,
    headSha: head,
    lenses: await lensesOf(run, changed),
    digest: boardDigest(entries, task.id),
    previous: taskFindings(entries, task.id).filter((finding) => !dropped.has(finding.id)),
  });
  await moveTaskTo(project, task.id, "in_review");
  const reviewer = latestRun(entries, task.id, "reviewer");
  if (reviewer?.conversationId && (reviewer.state === "working" || reviewer.state === "waiting")) {
    // The commit asked about goes with the request: the verdict is for it alone.
    await project.record(reviewAskNote(task.id, reviewer.id, randomUUID(), head));
    return askReviewer(loop, job, reviewer, prompt, false);
  }
  const blocked = (question: string) =>
    openDecision(loop, job, {
      about: "retry",
      kind: "blocked",
      stage: "review",
      taskId: task.id,
      question,
      options: ["retry", "stop-step"],
    });
  const roles = await loop.roles.get(job.key);
  const pick = pickRole("reviewer", roles, await loop.host.agents(), {
    now: loop.now(),
    avoid: run.choice.agent,
  });
  if (!pick.ok) return blocked(`Step "${task.title}" can't be reviewed: ${pick.reason}`);
  // A reviewer still "starting" here was left so by a stop of the app (this step's queue runs
  // one review start at a time): end it, its conversation first, so a new one may start.
  if (reviewer?.state === "starting") {
    if (reviewer.conversationId && !(await interrupt(loop, job, reviewer.conversationId))) {
      return blocked(
        `Step "${task.title}"'s earlier reviewer couldn't be stopped. Stop it in the app, then ask for the review again.`,
      );
    }
    await setRunState(project, reviewer.id, "failed", "Its start never finished.");
  }
  const reviewerId = loop.newId();
  try {
    await claimRun(loop, job, {
      id: reviewerId,
      taskId: task.id,
      role: "reviewer",
      choice: pick.choice,
    });
  } catch (error) {
    // Another instance owns the job, or it ended: back off. Anything else the person sees.
    if (error instanceof ClaimRefused && error.why !== "busy") return;
    if (error instanceof ClaimRefused) {
      return blocked(`Step "${task.title}" can't be reviewed now: ${error.message}.`);
    }
    throw error;
  }
  await project.record(reviewAskNote(task.id, reviewerId, randomUUID(), head));
  let conversationId: string;
  const first = toReviewer(prompt);
  try {
    ({ conversationId } = await loop.host.startReviewer({
      project: job.project,
      worktreePath: run.worktreePath!,
      title: `Review: ${task.title}`,
      text: first.text,
      choice: pick.choice,
    }));
    loop.reviewAsks.set(conversationId, { token: first.token, again: false });
  } catch (error) {
    await setRunState(project, reviewerId, "failed", `It couldn't start: ${errorText(error)}.`);
    return blocked(`Step "${task.title}"'s reviewer couldn't start: ${errorText(error)}.`);
  }
  // A stop that came while the conversation was being made: it must not go on reviewing.
  const escaped = async () => {
    await interrupt(loop, job, conversationId);
  };
  if (signalOf(loop, job).aborted) return escaped();
  try {
    await project.updateRun(reviewerId, {
      conversationId,
      worktreePath: run.worktreePath!,
      state: "working",
    });
  } catch (error) {
    await escaped();
    if (signalOf(loop, job).aborted || jobClosed(await entriesOf(loop, job), job.jobId)) return;
    throw error;
  }
  if (signalOf(loop, job).aborted || jobClosed(await entriesOf(loop, job), job.jobId)) {
    return escaped();
  }
  watchTurn(loop, job, { taskId: task.id, runId: reviewerId, role: "reviewer", conversationId });
}

async function reviewerTurnEnded(loop: Loop, job: JobRef, reviewer: Run, result: TurnResult) {
  const entries = await entriesOf(loop, job);
  const task = taskIn(entries, reviewer.taskId)!;
  const executor = latestRun(entries, task.id, "executor");
  const project = ledgerOf(loop, job);
  if (!executor || !liveRun(entries, executor.id)) return;
  const unreadable = async (question: string) => {
    await setRunState(project, reviewer.id, "waiting", "Its review couldn't be read.");
    return openDecision(loop, job, {
      about: "retry",
      kind: "blocked",
      stage: "review",
      taskId: task.id,
      question,
      options: ["retry", "stop-step"],
    });
  };
  if (result.status === "failed") {
    return unreadable(
      `Step "${task.title}"'s reviewer turn failed. Open its conversation to see why, then ask for the review again or stop the step.`,
    );
  }
  const conversationId = reviewer.conversationId!;
  const token = loop.reviewAsks.get(conversationId);
  const fresh =
    result.text.trim() !== "" &&
    ((token !== undefined && result.text.includes(token.token)) ||
      result.text !== loop.lastText.get(conversationId));
  loop.lastText.set(conversationId, result.text);
  const round = nextRound(entries, executor.id);
  const previous = taskFindings(entries, task.id);
  const reading = fresh ? readReview(result.text, { round, taskId: task.id, previous }) : undefined;
  if (!reading) {
    if (!token?.again) return askReviewer(loop, job, reviewer, REVIEW_ASK_AGAIN, true);
    return unreadable(
      `Step "${task.title}"'s reviewer gave no verdict that could be read, twice. Ask for the review again, or stop the step.`,
    );
  }
  const dropped = droppedFindings(entries, job.jobId, task.id);
  const findings = reading.findings.filter(
    (finding) => !(finding.repeats && dropped.has(finding.repeats)),
  );
  const base = runBase(entries, executor.id)!;
  const head = await headOf(loop.host.git, executor.worktreePath!);
  const asked = askedCommit(entries, reviewer.id) ?? head;
  // The branch moved while the reviewer read it (someone committed in the executor's
  // conversation): the verdict covers the old commit only, so the round starts again on the new.
  if (head !== asked) return reviewRound(loop, job, executor.id);
  const changed = await changedPaths(loop.host.git, executor.worktreePath!, base, head);
  const verdict = passes(findings) ? "pass" : "findings";
  await project.record({
    kind: "review.decided",
    taskId: task.id,
    runId: executor.id,
    data: {
      round,
      verdict,
      commit: head,
      lenses: (await lensesOf(executor, changed)).map((lens) => lens.key),
      findings,
      reviewerRunId: reviewer.id,
    },
  });
  await recordFlags(
    loop,
    job,
    reviewer,
    turnEndFlags({
      role: "reviewer",
      verdict,
      findings: findings.length,
      changedLines: await changedLines(loop.host.git, executor.worktreePath!, base, head),
    }),
  );
  if (verdict === "pass") return stepPassed(loop, job, task.id, executor.id);
  if (round >= MAX_REVIEW_ROUNDS) return chairStuck(loop, job, executor.id, findings);
  const repeated = round === 2 ? findings.find((finding) => finding.repeats) : undefined;
  if (repeated) return repeatedFinding(loop, job, executor, repeated, findings);
  return sendFindings(loop, job, executor.id, findings);
}

/** Findings go back to the executor with the digest, and the reviewer waits for the next round. */
export async function sendFindings(
  loop: Loop,
  job: JobRef,
  executorRunId: string,
  findings: readonly ReviewFinding[],
  before?: string,
): Promise<void> {
  const entries = await entriesOf(loop, job);
  const executor = liveRun(entries, executorRunId);
  if (!executor) return;
  const project = ledgerOf(loop, job);
  const reviewer = latestRun(entries, executor.taskId, "reviewer");
  if (reviewer)
    await setRunState(project, reviewer.id, "waiting", "Waiting for the executor's fixes.");
  await moveTaskTo(project, executor.taskId, "working");
  const round = reviewsOf(entries, executor.id).at(-1)?.data.round ?? 1;
  const message = findingsMessage({
    round,
    findings,
    digest: boardDigest(await entriesOf(loop, job), executor.taskId),
  });
  return sendAndWatch(loop, job, executor, before ? `${before}\n\n${message}` : message);
}

/** A finding came back in round two: the watcher looks, within its calls for the run. */
async function repeatedFinding(
  loop: Loop,
  job: JobRef,
  executor: Run,
  finding: ReviewFinding,
  findings: readonly ReviewFinding[],
): Promise<void> {
  const entries = await entriesOf(loop, job);
  const task = taskIn(entries, executor.taskId)!;
  const project = ledgerOf(loop, job);
  const watched = await askWatcher(loop, job, executor, {
    trigger: "repeated-finding",
    step: stepOf(job, task),
    finding,
    lastMessages: [loop.lastText.get(executor.conversationId!) ?? ""],
  });
  if (signalOf(loop, job).aborted) return;
  // No call left: the findings go back as they are.
  if (!watched) return sendFindings(loop, job, executor.id, findings);
  if (watched.advice?.advice === "note") {
    await project.record({
      kind: "note",
      taskId: task.id,
      data: { from: "watcher", to: task.id, text: watched.advice.text },
    });
    return sendFindings(loop, job, executor.id, findings);
  }
  const why = watched.advice
    ? ` The watcher advises to ${watched.advice.advice}: ${short(watched.advice.text, 300)}`
    : watched.why;
  const reviewer = latestRun(entries, task.id, "reviewer");
  if (reviewer) await setRunState(project, reviewer.id, "waiting");
  await openDecision(loop, job, {
    about: "watcher",
    kind: "blocked",
    taskId: task.id,
    runId: executor.id,
    question: `Finding ${finding.id} on step "${task.title}" came back in round two.${why} Send the findings back anyway, give the step to another executor, or stop it.`,
    options: ["findings", "reassign", "stop-step"],
  });
}

/** A step passed: it is `queued` (reviewed), its runs wait for the final read, and the job moves on. */
export async function stepPassed(
  loop: Loop,
  job: JobRef,
  taskId: string,
  executorRunId: string,
): Promise<void> {
  const project = ledgerOf(loop, job);
  await moveTaskTo(project, taskId, "queued");
  await setRunState(project, executorRunId, "waiting", "Passed review; waits for the final read.");
  const reviewer = latestRun(await entriesOf(loop, job), taskId, "reviewer");
  if (reviewer) await setRunState(project, reviewer.id, "waiting", "The step passed.");
  kickJob(loop, job);
}

/** The step passes on a ruling (the chair's or the person's "drop"): a passing review is written, so what waits for it can start. */
export async function passByRuling(loop: Loop, job: JobRef, executorRunId: string): Promise<void> {
  const entries = await entriesOf(loop, job);
  const executor = liveRun(entries, executorRunId);
  const last = reviewsOf(entries, executorRunId).at(-1);
  if (!executor || !last) return;
  await ledgerOf(loop, job).record({
    kind: "review.decided",
    taskId: executor.taskId,
    runId: executor.id,
    data: {
      round: last.data.round,
      verdict: "pass",
      commit: last.data.commit,
      lenses: last.data.lenses,
      findings: last.data.findings.filter((finding) => finding.severity !== "blocker"),
    },
  });
  await moveTaskTo(ledgerOf(loop, job), executor.taskId, "in_review");
  return stepPassed(loop, job, executor.taskId, executor.id);
}

/** The latest findings of an executor run, for a person's "send them back". */
export function latestFindings(entries: readonly LedgerEntry[], runId: string): ReviewFinding[] {
  return [...(reviewsOf(entries, runId).at(-1)?.data.findings ?? [])];
}
