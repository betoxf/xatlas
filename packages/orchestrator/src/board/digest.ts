import {
  MAX_DIGEST_WORDS,
  RESERVED_NOTE_PREFIX,
  type LedgerEntry,
  type ModelChoice,
  type Run,
} from "../types.js";
import { splitBeyond } from "../division/beyond.js";
import { replay } from "../tasks/replay.js";
import { latestExecutor, stepsOf } from "./steps.js";

type NoteEntry = Extract<LedgerEntry, { kind: "note" }>;

/** The newest note keeps at least this many words before sibling lines are dropped for it. */
const NOTE_FLOOR = 40;
/** A cut plan shows at least this many words, or none of it. */
const PLAN_FLOOR = 20;

/** How much of each part a rendering shows. */
interface Shown {
  readonly planWords: number;
  readonly notes: number;
  readonly newestNoteWords: number;
  readonly siblings: number;
}

/**
 * What one step's executor is told about the board, at most `maxWords` words: the step's
 * title and what it owns, the notes meant for it (newest first: addressed to it, addressed to
 * nobody within its job, or written by a step it builds on), one line per sibling step,
 * and the plan the parliament chose. When it is too long the plan is cut first, then the
 * oldest notes, then the newest note's text, then the sibling lines, and each cut is marked.
 * `entries` is the whole ledger, from seq 1. Throws when the task is unknown or `maxWords` is
 * not a whole number from 1 to `MAX_DIGEST_WORDS`.
 */
export function boardDigest(
  entries: readonly LedgerEntry[],
  taskId: string,
  options: { readonly maxWords?: number } = {},
): string {
  const maxWords = options.maxWords ?? MAX_DIGEST_WORDS;
  // A caller may ask for less than the constant, never more.
  if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > MAX_DIGEST_WORDS) {
    throw new Error(
      `A digest's word limit must be a whole number above 0 and at most ${MAX_DIGEST_WORDS}, not ${maxWords}.`,
    );
  }
  const { tasks, runs } = replay(entries);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`No task ${taskId} in the ledger.`);
  const jobId = task.parentId ?? task.id;
  const steps = stepsOf(tasks, jobId);
  const inJob = new Set([jobId, ...steps.map((step) => step.id)]);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const dependencies = new Set(task.dependsOn);

  const header = [
    `Your step: ${task.id}, "${task.title}".`,
    `You own: ${ownsText(task.owns)}.`,
    ...(task.dependsOn.length > 0 ? [`It builds on: ${task.dependsOn.join(", ")}.`] : []),
  ].join("\n");

  const notes = entries
    .filter((entry): entry is NoteEntry => entry.kind === "note")
    // The orchestrator's own bookkeeping is nobody's to read.
    .filter(({ data }) => !data.from.startsWith(RESERVED_NOTE_PREFIX))
    .filter(({ data, taskId: scope }) => {
      // A dependency's notes matter whoever they were addressed to.
      const writer = runsById.get(data.from);
      if (writer !== undefined && dependencies.has(writer.taskId)) return true;
      if (data.to !== undefined) return data.to === task.id;
      // Addressed to nobody: shown when it belongs to this job, by its entry's task or its
      // writer's. A note that names neither is the project's, and every job sees it.
      const home = scope ?? writer?.taskId;
      return home === undefined || inJob.has(home);
    })
    .reverse()
    .map(({ data }) => ({ from: author(data.from, runsById), text: data.text }));

  const siblings = steps
    .filter((step) => step.id !== task.id)
    .map((step) => {
      const run = latestExecutor(runs, step.id);
      return [
        `- ${step.id}, "${step.title}": ${step.state}`,
        run === undefined ? "no executor yet" : choiceText(run.choice),
        `owns ${ownsText(step.owns)}`,
        ...(run?.branch === undefined ? [] : [`branch ${run.branch}`]),
      ].join("; ");
    });

  const decided = entries.findLast(
    (entry) => entry.kind === "parliament.decided" && entry.taskId === jobId,
  );
  const plan = decided?.kind === "parliament.decided" ? decided.data : undefined;
  // An executor gets the work only; the ideas beyond the request stay with the person.
  const planText = plan === undefined ? "" : splitBeyond(plan.plan).work;
  const planTotal = plan === undefined ? 0 : wordCount(planText);

  function render(shown: Shown): string {
    const parts = [header];
    if (notes.length === 0) {
      parts.push("No notes for you yet.");
    } else {
      const kept = notes.slice(0, shown.notes).map((note, index) => {
        const total = wordCount(note.text);
        const words = index === 0 ? Math.min(shown.newestNoteWords, total) : total;
        const text = words < total ? `${firstWords(note.text, words)} [note cut]` : note.text;
        return `- From ${note.from}: ${text}`;
      });
      const dropped = notes.length - shown.notes;
      parts.push(
        [
          "Notes for you, newest first:",
          ...kept,
          ...(dropped > 0 ? [`[${dropped} older ${dropped === 1 ? "note" : "notes"} cut]`] : []),
        ].join("\n"),
      );
    }
    if (siblings.length === 0) {
      parts.push("No other steps in this job.");
    } else {
      const dropped = siblings.length - shown.siblings;
      parts.push(
        [
          "The other steps in this job (read a branch when you need it):",
          ...siblings.slice(0, shown.siblings),
          ...(dropped > 0 ? [`[${dropped} more ${dropped === 1 ? "step" : "steps"} cut]`] : []),
        ].join("\n"),
      );
    }
    if (plan !== undefined) {
      if (shown.planWords === 0) {
        parts.push(`[The parliament's plan (${planTotal} words) was cut.]`);
      } else {
        const by = plan.winner === undefined ? "" : ` (written by ${plan.winner})`;
        const cut =
          shown.planWords < planTotal
            ? `\n[plan cut after ${shown.planWords} of ${planTotal} words]`
            : "";
        parts.push(
          `The plan the parliament chose${by}:\n${firstWords(planText, shown.planWords)}${cut}`,
        );
      }
    }
    return parts.join("\n\n");
  }

  const fits = (shown: Shown) => wordCount(render(shown)) <= maxWords;
  const newestTotal = notes[0] === undefined ? 0 : wordCount(notes[0].text);
  let shown: Shown = {
    planWords: planTotal,
    notes: notes.length,
    newestNoteWords: newestTotal,
    siblings: siblings.length,
  };
  /** As much of the plan as fits beside the rest; none rather than a stub under PLAN_FLOOR words. */
  const planFit = (rest: Shown) => {
    if (fits({ ...rest, planWords: planTotal })) return planTotal;
    const words = largest(0, planTotal - 1, (count) => fits({ ...rest, planWords: count }));
    return words < PLAN_FLOOR ? 0 : words;
  };
  shown = { ...shown, planWords: planFit(shown) };
  if (!fits(shown) && notes.length > 1) {
    shown = {
      ...shown,
      notes: largest(1, notes.length, (count) => fits({ ...shown, notes: count })),
    };
  }
  if (!fits(shown) && newestTotal > NOTE_FLOOR) {
    const newestNoteWords = largest(NOTE_FLOOR, newestTotal, (words) =>
      fits({ ...shown, newestNoteWords: words }),
    );
    shown = { ...shown, newestNoteWords };
  }
  if (!fits(shown) && siblings.length > 0) {
    shown = {
      ...shown,
      siblings: largest(0, siblings.length, (count) => fits({ ...shown, siblings: count })),
    };
  }
  // Room freed by the cuts above goes back to the plan.
  shown = { ...shown, planWords: planFit(shown) };
  return clamp(render(shown), maxWords);
}

function ownsText(owns: readonly string[]): string {
  // An empty list is the whole repository, as in division.
  return owns.length === 0 ? "the whole repository" : owns.join(", ");
}

function choiceText(choice: ModelChoice): string {
  return choice.model === undefined ? choice.agent : `${choice.agent} ${choice.model}`;
}

/** Who wrote a note, in words: the person, the orchestrator, or a run's step and agent. */
function author(from: string, runs: ReadonlyMap<string, Run>): string {
  if (from === "person" || from === "orchestrator" || from === "watcher") return `the ${from}`;
  const run = runs.get(from);
  return run === undefined
    ? from
    : `${run.taskId}'s ${run.role} (${choiceText(run.choice)}, run ${run.id})`;
}

function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** The text up to the end of its `count`th word, line breaks kept. */
function firstWords(text: string, count: number): string {
  if (count <= 0) return "";
  let seen = 0;
  for (const match of text.matchAll(/\S+/g)) {
    seen += 1;
    if (seen === count) return text.slice(0, match.index + match[0].length);
  }
  return text;
}

/** The last resort: the first `max` words, the last of them a marker when there is room. */
function clamp(text: string, max: number): string {
  if (wordCount(text) <= max) return text;
  return max < 2 ? firstWords(text, max) : `${firstWords(text, max - 1)} [cut]`;
}

/**
 * The largest n in [low, high] for which `fits(n)` holds, or `low` when none does. `fits` must
 * not hold above a value it fails at.
 */
function largest(low: number, high: number, fits: (n: number) => boolean): number {
  let best = low;
  let lo = low;
  let hi = high;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
