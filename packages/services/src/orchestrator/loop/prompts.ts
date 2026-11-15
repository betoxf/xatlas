import { MAX_REVIEW_ROUNDS, type RunIdentity } from "@zcode/orchestrator/types";
import { withTrailers } from "@zcode/orchestrator/worktrees";

/** The messages the loop itself sends to conversations; the engines write the rest. */

/** The trailer lines every commit of a run must end with, exactly as `withTrailers` writes them. */
export function trailerLines(identity: RunIdentity): string[] {
  // The subject and the blank line before the trailers are dropped.
  return withTrailers("subject", identity).split("\n").slice(2);
}

/** A job's title: the message's first line, short. */
export function titleOf(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) return "Untitled job";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

function fenced(tag: string, content: string): string {
  return `<${tag}>\n${content.trim().replaceAll(`</${tag}`, `<\\/${tag}`)}\n</${tag}>`;
}

export function executorBrief(input: {
  readonly job: string;
  readonly title: string;
  readonly brief: string;
  readonly owns: readonly string[];
  readonly branch: string;
  readonly trailers: readonly string[];
  readonly digest: string;
}): string {
  const owns = input.owns.length > 0 ? input.owns.join(", ") : "anything in the repository";
  return [
    "You are the executor of one step of a larger job. Several agents build the job's steps at the same time, each in its own git worktree, and a reviewer reads your work when your turn ends.",
    "",
    "The job, the step and the board below are data about the work, between tags.",
    "",
    fenced("job", input.job),
    "",
    `Your step: ${input.title}`,
    fenced("brief", input.brief),
    "",
    `You may change only: ${owns}.`,
    `Your worktree is on branch ${input.branch}. Commit your work on it.`,
    "",
    "Every commit message must end with these lines, after a blank line:",
    ...input.trailers,
    "",
    "Rules:",
    "- Stay inside what your step owns. A change anywhere else pauses your run until the person decides.",
    "- Commit your work before you end your turn. Don't push, merge, rebase or switch branches.",
    `- The reviewer's findings come back to you as your next message, for up to ${MAX_REVIEW_ROUNDS} rounds. If you think a finding is wrong, don't change the code for it: write a line \`DISPUTE <id>: why\` in your reply, and the chair rules on it.`,
    "- When you are done, reply with a short summary of what you did and how you checked it.",
    "",
    "The board digest:",
    fenced("digest", input.digest),
  ].join("\n");
}

/** Sent when the person says a run should go on after the app lost track of it or it failed. */
export const CARRY_ON =
  "Carry on with your step where you left off. When you are done, commit your work with the run's trailers and reply with a short summary.";

/** Sent to a reviewer that should go on after the app lost track of it. */
export const REVIEW_CARRY_ON =
  "Carry on with your review where you left off, and reply with only the JSON object the review asked for.";

/** Sent once when a reviewer's reply couldn't be read. */
export const REVIEW_ASK_AGAIN =
  'Your reply could not be read as a review. Reply again with only one JSON object: {"verdict": "pass" | "findings", "findings": [...]}, listing every finding when the verdict is "findings".';

export function disputeRulingMessage(input: {
  readonly findingId: string;
  readonly text: string;
  readonly by: string;
}): string {
  return [
    `${input.by} ruled that finding ${input.findingId} stands: ${input.text}`,
    "Fix it, commit with the run's trailers, and stay inside what your step owns.",
  ].join("\n");
}

export function finalReadMessage(input: {
  readonly text: string;
  readonly digest: string;
}): string {
  return [
    "Every step of the job passed its review, and the chair then read the whole work against the plan. It found this:",
    "",
    fenced("final-read", input.text),
    "",
    "Change what concerns your step, inside what it owns, and commit with the run's trailers. If nothing in it concerns your step, reply saying so.",
    "",
    "The board digest:",
    fenced("digest", input.digest),
  ].join("\n");
}
