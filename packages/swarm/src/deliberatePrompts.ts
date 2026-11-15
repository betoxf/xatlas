/**
 * Prompts and reply readers for a deliberation (`runDeliberation`). Members are shown by
 * letter only (A, B, C, …), so they answer each other and not a model. Every prompt carries the
 * person's request word for word. Every reply is untrusted: it is read with `jsonObjectsIn` and
 * every field is cut to a limit. A source a member cites is shown as text and never opened.
 */
import { ANCHOR_RULES, cutTo, fenced, QUOTED_DATA, quoted, READ_ONLY } from "./prompts.js";
import { jsonObjectsIn } from "./replies.js";

/** The most approaches one member suggests in its opening. */
export const MAX_IDEAS = 3;
/** The most findings, questions, replies and amendments read from one reply. */
export const MAX_FINDINGS = 5;
export const MAX_QUESTIONS = 3;
export const MAX_REPLIES = 6;
export const MAX_AMENDMENTS = 5;
/** Word limits asked for in the prompts. */
export const OPENING_WORDS = 250;
export const DISCUSS_WORDS = 250;
export const PLAN_WORDS = 600;
export const AMEND_WORDS = 150;
/** Character limits on what is read from a reply. */
export const NAME_CHARS = 120;
export const IDEA_CHARS = 1_200;
export const TRADEOFF_CHARS = 400;
export const REMARK_CHARS = 1_200;
export const FACT_CHARS = 600;
export const SOURCE_CHARS = 300;
export const BEYOND_CHARS = 800;
export const PLAN_CHARS = 12_000;
export const ANSWERS_CHARS = 4_000;
/** The most of the discussion so far that one prompt shows, newest kept. */
export const TRANSCRIPT_CHARS = 16_000;
/** The most one member's turn takes in the transcript. */
export const TURN_CHARS = 3_000;

const RESEARCH =
  "If your tools let you search the web or open pages, you may; give the source (a file path in the project, or a URL) of anything you found.";

/** One approach as a member wrote it, before it gets a label. */
export interface Idea {
  readonly name: string;
  readonly idea: string;
  readonly tradeoff: string;
}

/** One approach as the prompts show it: its label and the letter of who offered it. */
export interface LabelledIdea extends Idea {
  readonly label: string;
  readonly from: string;
}

/** A fact a member brought, and where it came from. */
export interface Finding {
  readonly fact: string;
  readonly source: string;
}

export interface Opening {
  readonly findings: Finding[];
  readonly approaches: Idea[];
  readonly questions: string[];
  /** Index among `approaches` of the member's pick. */
  readonly pick?: number;
  readonly beyond: string;
}

export interface Turn {
  readonly replies: Array<{ to: string; point: string }>;
  readonly research: Finding[];
  readonly merged?: Idea;
  /** An approach label, or "merged" (with `merged`); absent when it named none it could. */
  readonly stand?: string;
  readonly why: string;
  readonly beyond: string;
}

export interface Amendment {
  /** False: the member says the plan no longer does what was asked, which blocks it. */
  readonly onRequest: boolean;
  readonly drift: string;
  readonly amendments: string[];
  readonly block: string;
}

/** A field of a reply as text: trimmed, cut to `max`, empty when it isn't a string. */
function text(value: unknown, max: number): string {
  return typeof value === "string" ? cutTo(value.trim(), max) : "";
}

/** "3", 3, "Approach 3" and " approach 3 " all read as "3". */
function label(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
        .trim()
        .replace(/^approach\s*/i, "")
    : "";
}

/** true/false, or "yes"/"no"/"true"/"false" in any case; undefined otherwise. */
function yesNo(value: unknown): boolean | undefined {
  const read = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (read === true || read === "true" || read === "yes") return true;
  if (read === false || read === "false" || read === "no") return false;
  return undefined;
}

function texts(value: unknown, most: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, most * 4)
    .map((entry) => text(entry, max))
    .filter(Boolean)
    .slice(0, most);
}

function readIdea(value: unknown): Idea | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const idea = text(entry.idea, IDEA_CHARS);
  if (!idea) return undefined;
  return {
    name: text(entry.name, NAME_CHARS) || "Unnamed",
    idea,
    tradeoff: text(entry.tradeoff, TRADEOFF_CHARS),
  };
}

function readFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_FINDINGS * 4)
    .flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const fact = text(record.fact, FACT_CHARS);
      return fact ? [{ fact, source: text(record.source, SOURCE_CHARS) }] : [];
    })
    .slice(0, MAX_FINDINGS);
}

/** The request word for word under its own heading, and what may and may not change. */
function anchor(task: string): string[] {
  return ["## The request, word for word", task.trim(), "", ANCHOR_RULES];
}

/** Who the member is: its letter among the others. */
function voice(letter: string, letters: readonly string[]): string {
  const others = letters.filter((entry) => entry !== letter);
  return `${letters.length} planners are discussing this request, each shown only by a letter. You are ${letter}; the others are ${others.join(", ")}.`;
}

export function approachBlock(approaches: readonly LabelledIdea[]): string {
  return approaches
    .map(
      (approach) =>
        `### Approach ${approach.label} (from ${approach.from}): ${quoted(approach.name)}\nIdea: ${quoted(approach.idea)}${approach.tradeoff ? `\nTrade-off: ${quoted(approach.tradeoff)}` : ""}`,
    )
    .join("\n\n");
}

const findingLine = (finding: Finding) =>
  `  Found: ${quoted(finding.fact)} ${finding.source ? `Source: ${quoted(finding.source)}` : "No source given."}`;

/** A member's opening as the others read it. */
export function openingBlock(letter: string, opening: Opening, labels: readonly string[]): string {
  const pick = opening.pick === undefined ? undefined : labels[opening.pick];
  return cutTo(
    [
      `${letter} (opening): offered ${labels.map((entry) => `Approach ${entry}`).join(", ") || "no approach"}${pick ? `; would pick Approach ${pick}` : ""}.`,
      ...opening.findings.map(findingLine),
      ...opening.questions.map((question) => `  Asks: ${quoted(question)}`),
      ...(opening.beyond ? [`  Beyond the request: ${quoted(opening.beyond)}`] : []),
    ].join("\n"),
    TURN_CHARS,
  );
}

/** A discussion turn as the others read it; `stand` and `merged` are labels in the pool. */
export function turnBlock(
  letter: string,
  round: number,
  turn: Turn,
  stand: string | undefined,
  merged: string | undefined,
): string {
  return cutTo(
    [
      `${letter} (round ${round}): ${stand ? `stands on Approach ${stand}` : "named no approach it backs"}.${turn.why ? ` Why: ${quoted(turn.why)}` : ""}`,
      ...turn.replies.map((reply) => `  To ${reply.to}: ${quoted(reply.point)}`),
      ...turn.research.map(findingLine),
      ...(merged && turn.merged
        ? [`  Offered Approach ${merged}: ${quoted(turn.merged.name)}`]
        : []),
      ...(turn.beyond ? [`  Beyond the request: ${quoted(turn.beyond)}`] : []),
    ].join("\n"),
    TURN_CHARS,
  );
}

/** The discussion so far, newest kept within `TRANSCRIPT_CHARS`, with a note of what was left out. */
export function transcriptBlock(turns: readonly string[]): string[] {
  if (turns.length === 0) return [];
  const kept: string[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    if (used + turn.length + 1 > TRANSCRIPT_CHARS) break;
    kept.unshift(turn);
    used += turn.length + 1;
  }
  const left = turns.length - kept.length;
  return [
    "",
    "## The discussion so far",
    ...(left > 0
      ? [`[${left} earlier turn${left === 1 ? "" : "s"} left out to keep this short]`]
      : []),
    ...kept,
  ];
}

/** What the plan is written in; the writer, the revision, positions and counter-plans use it. */
export const PLAN_SECTIONS = [
  "## How it does what was asked",
  "## Approach and why",
  "## Taken from (what came from whom, by letter)",
  "## Steps (numbered; for each, the files it owns and whether it runs beside the others or waits for a step)",
  "## Risks",
  "## How to verify",
  "## Beyond the request (not steps: ideas for the person to decide)",
].join("\n");

const IDEA_SHAPE =
  '{"name": "a few words", "idea": "a few lines", "tradeoff": "its main trade-off"}';
const FINDING_SHAPE = '{"fact": "what you found", "source": "a file path or a URL"}';

export function openingPrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
}): string {
  return [
    voice(input.letter, input.letters),
    "First each of you gives an opening alone; then you will discuss and agree on one plan.",
    "",
    ...anchor(input.task),
    "",
    READ_ONLY,
    RESEARCH,
    "",
    `Give: what you found that matters here, each with its source; up to ${MAX_IDEAS} genuinely different approaches, each with its trade-off; questions for the others; and the approach you would pick. At most ${OPENING_WORDS} words in all.`,
    `Reply with only a JSON object: {"findings": [${FINDING_SHAPE}], "approaches": [${IDEA_SHAPE}], "questions": ["a question for the others"], "pick": the number of your pick in your list, starting at 1, "beyond": "ideas beyond the request, for the person; empty if none"}`,
  ].join("\n");
}

export function discussPrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
  round: number;
  /** The last round takes no new merge: a merge offered there could be backed by its offerer alone. */
  last: boolean;
  approaches: readonly LabelledIdea[];
  transcript: readonly string[];
}): string {
  return [
    voice(input.letter, input.letters),
    `This is discussion round ${input.round}${input.last ? ", the last" : ""}.`,
    "",
    ...anchor(input.task),
    "",
    "## The approaches",
    approachBlock(input.approaches),
    ...transcriptBlock(input.transcript),
    "",
    READ_ONLY,
    QUOTED_DATA,
    RESEARCH,
    "",
    `Answer the others' points and questions by letter: agree and say why, or challenge with evidence. Add what you know or found. ${input.last ? "This is the last round, so offer no new approach: stand on the listed approach closest to where the discussion has come, even if it is not your own, so that the group can agree." : "If a merge of approaches beats every single one and no listed approach already says it, offer it."} Then say where you now stand. At most ${DISCUSS_WORDS} words in all.`,
    input.last
      ? `Reply with only a JSON object: {"replies": [{"to": "a letter", "point": "…"}], "research": [${FINDING_SHAPE}], "stand": "the number of the approach you back", "why": "why you stand there", "beyond": "ideas beyond the request, for the person; empty if none"}`
      : `Reply with only a JSON object: {"replies": [{"to": "a letter", "point": "…"}], "research": [${FINDING_SHAPE}], "merged": ${IDEA_SHAPE}, "stand": "the number of the approach you back, or \\"merged\\" for your merge", "why": "why you stand there", "beyond": "ideas beyond the request, for the person; empty if none"}. Leave out "merged" unless you offer one.`,
  ].join("\n");
}

export function writePrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
  agreed: LabelledIdea;
  others: readonly LabelledIdea[];
  transcript: readonly string[];
}): string {
  return [
    voice(input.letter, input.letters),
    `More than half of you back Approach ${input.agreed.label}. You write the plan for all of you.`,
    "",
    ...anchor(input.task),
    "",
    "## The agreed approach",
    approachBlock([input.agreed]),
    ...(input.others.length > 0
      ? ["", "## The other approaches, to take from", approachBlock(input.others)]
      : []),
    ...transcriptBlock(input.transcript),
    "",
    READ_ONLY,
    QUOTED_DATA,
    `Write the plan in exactly these sections, at most ${PLAN_WORDS} words:`,
    PLAN_SECTIONS,
    "Every step ends as its own reviewed branch: do not plan a step that merges the branches. Reply with the plan only, without <plan> tags.",
  ].join("\n");
}

export function amendPrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
  /** A fresh reader took no part in the discussion. */
  fresh: boolean;
  plan: string;
}): string {
  return [
    input.fresh
      ? `You are ${input.letter}, a fresh reader: you took no part in the discussion. Planners shown as ${input.letters.join(", ")} discussed this request, and one of them wrote the plan below.`
      : `${voice(input.letter, input.letters)} One of you wrote the plan below for all of you.`,
    "",
    ...anchor(input.task),
    "",
    "## The plan",
    fenced(input.plan),
    "",
    READ_ONLY,
    QUOTED_DATA,
    `Answer three things. Does the plan still do what was asked (no means it blocks)? What specific amendments would make it better? Is there one concern that should block it: a real flaw that would make the work go wrong, not a preference? At most ${AMEND_WORDS} words.`,
    'Reply with only a JSON object: {"onRequest": true or false, "drift": "if false, how it drifts from the request", "amendments": ["a specific change"], "block": "the one blocking concern, or empty"}',
  ].join("\n");
}

export function revisePrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
  plan: string;
  amendments: ReadonlyArray<{ from: string; text: string }>;
  blocks: ReadonlyArray<{ from: string; text: string }>;
}): string {
  return [
    voice(input.letter, input.letters),
    "You wrote the plan below. The others answered it; revise it once.",
    "",
    ...anchor(input.task),
    "",
    "## Your plan",
    fenced(input.plan),
    ...(input.amendments.length > 0
      ? [
          "",
          "## Amendments",
          ...input.amendments.map((entry) => `- ${entry.from}: ${quoted(entry.text)}`),
        ]
      : []),
    ...(input.blocks.length > 0
      ? [
          "",
          "## Blocking concerns",
          ...input.blocks.map((entry) => `- ${entry.from}: ${quoted(entry.text)}`),
        ]
      : []),
    "",
    READ_ONLY,
    QUOTED_DATA,
    "Take the amendments you accept, decline the others, and answer every blocking concern. An amendment that goes beyond or against the request goes under Beyond the request, not into the steps.",
    `Reply with the whole revised plan in the same sections, at most ${PLAN_WORDS} words:`,
    PLAN_SECTIONS,
    "Give the plan itself, without <plan> tags. Then one last section, ## Answers, saying for each letter what you took or declined and why, and how you answered each blocking concern.",
  ].join("\n");
}

export function recheckPrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
  fresh: boolean;
  plan: string;
  concern: string;
  answers: string;
}): string {
  return [
    input.fresh
      ? `You are ${input.letter}, a fresh reader of a plan that planners shown as ${input.letters.join(", ")} discussed.`
      : voice(input.letter, input.letters),
    "You blocked the plan. Its writer revised it once and answered you.",
    "",
    ...anchor(input.task),
    "",
    "## Your blocking concern",
    quoted(input.concern),
    "",
    "## The revised plan",
    fenced(input.plan),
    ...(input.answers ? ["", "## The writer's answers", quoted(input.answers)] : []),
    "",
    READ_ONLY,
    QUOTED_DATA,
    "Do you still block it? Block only for a real flaw, or because it no longer does what was asked.",
    'Reply with only a JSON object: {"stillBlocks": true or false, "block": "the concern that still blocks, or empty"}',
  ].join("\n");
}

/** The plan for one side of a split: a leading approach with no majority behind it. */
export function positionPrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
  approach: LabelledIdea;
  transcript: readonly string[];
}): string {
  return [
    voice(input.letter, input.letters),
    "No approach has more than half of you behind it. Write the plan for the approach below; another of you writes one for a competing approach. Nobody votes: outside advisors or the person choose between them.",
    "",
    ...anchor(input.task),
    "",
    "## Your approach",
    approachBlock([input.approach]),
    ...transcriptBlock(input.transcript),
    "",
    READ_ONLY,
    QUOTED_DATA,
    `Write the plan in exactly these sections, at most ${PLAN_WORDS} words:`,
    PLAN_SECTIONS,
    "Reply with the plan only, without <plan> tags.",
  ].join("\n");
}

/** The plan a member that still blocks would follow instead. */
export function counterPrompt(input: {
  task: string;
  letter: string;
  letters: readonly string[];
  fresh: boolean;
  plan: string;
  concern: string;
}): string {
  return [
    input.fresh
      ? `You are ${input.letter}, a fresh reader of a plan that planners shown as ${input.letters.join(", ")} discussed.`
      : voice(input.letter, input.letters),
    "The plan below was revised once and still does not have more than half of the weight behind it. You still block it. Write the plan you would follow instead. Nobody votes: outside advisors or the person choose between the two.",
    "",
    ...anchor(input.task),
    "",
    "## Your blocking concern",
    quoted(input.concern),
    "",
    "## The plan you block",
    fenced(input.plan),
    "",
    READ_ONLY,
    QUOTED_DATA,
    `Write your plan in exactly these sections, at most ${PLAN_WORDS} words:`,
    PLAN_SECTIONS,
    "Reply with the plan only, without <plan> tags.",
  ].join("\n");
}

/** What a heading must name for each section a plan can't do without; "Beyond the request" may be left out. */
/** The steps, without which nothing can be built. */
const STEPS_SECTION = /\bsteps?\b|\btasks?\b|\bwork\b/;
/** The other sections, by the words a writer is likely to head them with. */
const OTHER_SECTIONS = [
  /asked|request|goal/,
  /approach|design|solution/,
  /taken from|took from|from whom|borrow|credit/,
  /\brisks?\b/,
  /verif|\btest|\bcheck/,
];
/** How many of the other sections a plan must have besides its steps. */
const OTHER_SECTIONS_NEEDED = 3;

/**
 * Whether a reply is a plan and not a refusal or a note: it has a heading for its steps and
 * for at least three of the other sections. A heading is a `#` line of any level, a bold line,
 * or a short line that ends in a colon, in any case. The words are matched loosely ("Main
 * risks", "Verification", "What we took from whom"), because a writer that renames a section
 * has still written a plan, and refusing it would leave the parliament with none.
 */
export function isPlan(text: string): boolean {
  const headings = text.split("\n").flatMap((line) => {
    const match = /^\s{0,3}(?:#{1,6}\s+(.+)|\*\*(.+)|([^:\n]{2,60}):\s*)$/.exec(line);
    const heading = match?.[1] ?? match?.[2] ?? match?.[3];
    return heading ? [heading.toLowerCase()] : [];
  });
  const has = (section: RegExp) => headings.some((heading) => section.test(heading));
  return has(STEPS_SECTION) && OTHER_SECTIONS.filter(has).length >= OTHER_SECTIONS_NEEDED;
}

/** A plan from a reply: trimmed, a wrapping <plan> … </plan> taken off, cut to `PLAN_CHARS`; empty unless it is a plan before the cut. */
export function readPlan(reply: string): string {
  const plan = reply
    .trim()
    .replace(/^<plan>\s*\n/i, "")
    .replace(/\n\s*<\/plan>$/i, "")
    .trim();
  // Checked before the cut, so a long plan isn't refused for the heading the cut took off.
  return isPlan(plan) ? cutTo(plan, PLAN_CHARS) : "";
}

/**
 * Reads an opening: the last JSON object with an `approaches` list. Entries without an idea are
 * dropped, at most `MAX_IDEAS` are kept, and `pick` is the index among those kept of the entry
 * the member picked by its place in its own list (absent when it named none of them, or one that
 * was dropped).
 */
export function parseOpening(reply: string): Opening | undefined {
  for (const parsed of jsonObjectsIn(reply)) {
    if (!Array.isArray(parsed.approaches)) continue;
    // Each kept idea remembers where it stood in the member's list, which is what `pick` counts.
    const kept = parsed.approaches
      .slice(0, MAX_IDEAS * 4)
      .map((entry, position) => ({ idea: readIdea(entry), position }))
      .filter((entry): entry is { idea: Idea; position: number } => entry.idea !== undefined)
      .slice(0, MAX_IDEAS);
    if (kept.length === 0) continue;
    const named = Number(label(parsed.pick)) - 1;
    const pick = kept.findIndex((entry) => entry.position === named);
    return {
      findings: readFindings(parsed.findings),
      approaches: kept.map((entry) => entry.idea),
      questions: texts(parsed.questions, MAX_QUESTIONS, REMARK_CHARS),
      ...(pick >= 0 ? { pick } : {}),
      beyond: text(parsed.beyond, BEYOND_CHARS),
    };
  }
  return undefined;
}

/**
 * Reads a discussion turn: the last JSON object with a `stand`, `replies`, `research` or `why`.
 * `stand` is kept only when it names one of `labels`, or "merged" with a readable merge; a merge
 * is kept whether or not it is backed. A reply to a letter not in `letters` (or to the member
 * itself) is dropped.
 */
export function parseTurn(
  reply: string,
  labels: readonly string[],
  letters: readonly string[],
): Turn | undefined {
  const valid = new Set(labels);
  const others = new Set(letters.map((letter) => letter.toUpperCase()));
  for (const parsed of jsonObjectsIn(reply)) {
    if (!["stand", "replies", "research", "why"].some((key) => key in parsed)) continue;
    const merged = readIdea(parsed.merged);
    const named = label(parsed.stand).toLowerCase();
    const stand = valid.has(named) || (named === "merged" && merged) ? named : undefined;
    const replies = (Array.isArray(parsed.replies) ? parsed.replies : [])
      .slice(0, MAX_REPLIES * 4)
      .flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const record = entry as Record<string, unknown>;
        const to = text(record.to, 8).toUpperCase();
        const point = text(record.point, REMARK_CHARS);
        return others.has(to) && point ? [{ to, point }] : [];
      })
      .slice(0, MAX_REPLIES);
    return {
      replies,
      research: readFindings(parsed.research),
      ...(merged ? { merged } : {}),
      ...(stand ? { stand } : {}),
      why: text(parsed.why, REMARK_CHARS),
      beyond: text(parsed.beyond, BEYOND_CHARS),
    };
  }
  return undefined;
}

/** Reads an answer to the plan: the last JSON object whose `onRequest` is true or false. */
export function parseAmendment(reply: string): Amendment | undefined {
  for (const parsed of jsonObjectsIn(reply)) {
    const onRequest = yesNo(parsed.onRequest);
    if (onRequest === undefined) continue;
    return {
      onRequest,
      drift: text(parsed.drift, REMARK_CHARS),
      amendments: texts(parsed.amendments, MAX_AMENDMENTS, REMARK_CHARS),
      block: text(parsed.block, REMARK_CHARS),
    };
  }
  return undefined;
}

/** Reads a recheck: the last JSON object whose `stillBlocks` is true or false. */
export function parseRecheck(reply: string): { stillBlocks: boolean; block: string } | undefined {
  for (const parsed of jsonObjectsIn(reply)) {
    const stillBlocks = yesNo(parsed.stillBlocks);
    if (stillBlocks === undefined) continue;
    return { stillBlocks, block: text(parsed.block, REMARK_CHARS) };
  }
  return undefined;
}

/**
 * Splits a revision into the plan and the writer's answers (the last `## Answers` section), so
 * the argument is kept apart and the executors get only the plan.
 */
export function splitRevision(reply: string): { plan: string; answers: string } {
  const matches = [...reply.matchAll(/^#{1,3}\s*answers\s*$/gim)];
  const last = matches.at(-1);
  if (last?.index === undefined) return { plan: cutTo(reply.trim(), PLAN_CHARS), answers: "" };
  return {
    plan: cutTo(reply.slice(0, last.index).trim(), PLAN_CHARS),
    answers: cutTo(reply.slice(last.index + last[0].length).trim(), ANSWERS_CHARS),
  };
}
