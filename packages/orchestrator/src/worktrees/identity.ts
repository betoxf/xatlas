import type { AgentId, RunIdentity } from "../types.js";

/**
 * A run's identity, stamped three ways: the branch name, commit trailers and a block in the
 * pull request text. All of it is pure, and each form reads back to the same identity.
 *
 * Ids are rejected, not escaped: an escaped id would read back differently from the one the
 * ledger holds, and xatlas makes its own ids, so a bad one is a bug to surface.
 */

/** Every agent, so a typo or a new agent in the swarm types fails the type check here. */
const AGENTS: Readonly<Record<AgentId, true>> = {
  claude: true,
  codex: true,
  opencode: true,
  gemini: true,
};

/**
 * Letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 100 long. That
 * keeps every id a valid part of a git ref name and a single trailer word; the few dotted
 * forms git refuses (`..`, a trailing `.`, `.lock`) are refused below.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Model, account and conversation are free text on one line, with no edge spaces. */
const MAX_TEXT = 200;

// Control characters are exactly what this has to find.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const PREFIX = "xatlas";

const TRAILERS = {
  runId: "Xatlas-Run",
  taskId: "Xatlas-Task",
  agent: "Xatlas-Agent",
  model: "Xatlas-Model",
  account: "Xatlas-Account",
  conversationId: "Xatlas-Conversation",
} as const satisfies Record<keyof RunIdentity, string>;

type Field = keyof typeof TRAILERS;

const FIELDS = Object.keys(TRAILERS) as Field[];

const PR_START = "<!-- xatlas-run -->";
const PR_END = "<!-- /xatlas-run -->";

export function isAgentId(value: string): value is AgentId {
  return Object.hasOwn(AGENTS, value);
}

function idProblem(name: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !ID.test(value)) {
    return `${name} must be 1 to 100 letters, digits, ".", "_" or "-", starting with a letter or digit`;
  }
  if (value.includes("..") || value.endsWith(".") || value.endsWith(".lock")) {
    return `${name} can't contain "..", or end in "." or ".lock"`;
  }
  return undefined;
}

function textProblem(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) {
    return `${name} must be 1 to ${MAX_TEXT} characters when present`;
  }
  if (CONTROL.test(value) || value.trim() !== value) {
    return `${name} must be one line with no leading or trailing spaces`;
  }
  return undefined;
}

/** Why the identity can't be stamped, or undefined when it can. */
export function identityProblem(identity: RunIdentity): string | undefined {
  if (typeof identity.agent !== "string" || !isAgentId(identity.agent)) {
    return `agent must be one of ${Object.keys(AGENTS).join(", ")}`;
  }
  return (
    idProblem("runId", identity.runId) ??
    idProblem("taskId", identity.taskId) ??
    textProblem("model", identity.model) ??
    textProblem("account", identity.account) ??
    textProblem("conversationId", identity.conversationId)
  );
}

export function assertIdentity(identity: RunIdentity): void {
  const problem = identityProblem(identity);
  if (problem) throw new Error(`Invalid run identity: ${problem}.`);
}

/** Builds an identity from trailer-style fields, or undefined when it isn't a valid one. */
export function identityFromFields(fields: ReadonlyMap<string, string>): RunIdentity | undefined {
  const value = (field: Field) => fields.get(TRAILERS[field].toLowerCase());
  const runId = value("runId");
  const taskId = value("taskId");
  const agent = value("agent");
  if (runId === undefined || taskId === undefined || agent === undefined) return undefined;
  const identity: { -readonly [K in keyof RunIdentity]: RunIdentity[K] } = {
    runId,
    taskId,
    agent: agent as AgentId,
  };
  for (const field of ["model", "account", "conversationId"] as const) {
    const text = value(field);
    if (text !== undefined) identity[field] = text;
  }
  return identityProblem(identity) ? undefined : identity;
}

function identityLines(identity: RunIdentity): string[] {
  return FIELDS.flatMap((field) => {
    const value = identity[field];
    return value === undefined ? [] : [`${TRAILERS[field]}: ${value}`];
  });
}

function sameIdentity(a: RunIdentity, b: RunIdentity): boolean {
  return FIELDS.every((field) => a[field] === b[field]);
}

/** `xatlas/<taskId>/<agent>-<runId>`. Throws on an identity that isn't valid. */
export function branchName(identity: RunIdentity): string {
  assertIdentity(identity);
  return `${PREFIX}/${identity.taskId}/${identity.agent}-${identity.runId}`;
}

/** The ids in a branch made by `branchName`; a leading `refs/heads/` is allowed. */
export function readBranchName(
  branch: string,
): Pick<RunIdentity, "taskId" | "agent" | "runId"> | undefined {
  const match = /^(?:refs\/heads\/)?xatlas\/([^/]+)\/([a-z]+)-([^/]+)$/.exec(branch);
  if (!match) return undefined;
  const [, taskId = "", agent = "", runId = ""] = match;
  if (!isAgentId(agent) || idProblem("taskId", taskId) || idProblem("runId", runId)) {
    return undefined;
  }
  return { taskId, agent, runId };
}

// Git's trailer key: letters, digits and `-`, then `:`. A line starting with a space
// continues the trailer above it.
const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*):(?:\s|$)/;

function isTrailerLine(line: string): boolean {
  return TRAILER_LINE.test(line) || /^\s/.test(line) || line.startsWith("(cherry picked from");
}

interface SplitMessage {
  /** Everything before the trailer block, without trailing blank lines. */
  readonly body: string[];
  /** The trailer block's lines; empty when the message has none. */
  readonly trailers: string[];
}

/**
 * Splits off the trailer block the way git finds it: the last paragraph, when it isn't the
 * first one (the subject never counts) and every line in it is a trailer or a continuation.
 * Git also accepts a block that is only partly trailers when one of them is git's own; that
 * case here starts a new block instead, which git still reads.
 */
function splitMessage(message: string): SplitMessage {
  const lines = message.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.trim() !== "") start -= 1;
  const paragraph = lines.slice(start);
  const hasEarlierParagraph = lines.slice(0, start).some((line) => line.trim() !== "");
  if (
    !hasEarlierParagraph ||
    !paragraph.every(isTrailerLine) ||
    !TRAILER_LINE.test(paragraph[0] ?? "")
  ) {
    return { body: lines, trailers: [] };
  }
  let end = start;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  return { body: lines.slice(0, end), trailers: paragraph };
}

/** Trailer keys (lower case) to their last value, continuation lines joined. */
function trailerFields(lines: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();
  let lastKey: string | undefined;
  for (const line of lines) {
    const match = TRAILER_LINE.exec(line);
    if (match) {
      lastKey = match[1]!.toLowerCase();
      fields.set(lastKey, line.slice(match[0].length).trim());
    } else if (lastKey !== undefined && /^\s/.test(line)) {
      fields.set(lastKey, `${fields.get(lastKey) ?? ""} ${line.trim()}`.trim());
    }
  }
  return fields;
}

/** Trailer lines (as `git log --format=%(trailers:only,unfold)` prints them) as fields. */
export function fieldsFromTrailerLines(text: string): Map<string, string> {
  return trailerFields(text.replace(/\r\n?/g, "\n").split("\n"));
}

function isOurs(line: string): boolean {
  const key = TRAILER_LINE.exec(line)?.[1]?.toLowerCase();
  return key !== undefined && FIELDS.some((field) => TRAILERS[field].toLowerCase() === key);
}

/**
 * Adds the run's trailers after any that are there (such as Co-Authored-By), in the same
 * block so git keeps reading all of them. A message that already carries exactly this
 * identity comes back unchanged; other `Xatlas-*` trailers are replaced, so a commit never
 * names two runs.
 */
export function withTrailers(message: string, identity: RunIdentity): string {
  assertIdentity(identity);
  const current = readTrailers(message);
  if (current && sameIdentity(current, identity)) return message;
  const { body, trailers } = splitMessage(message);
  if (!body.some((line) => line.trim() !== "")) {
    throw new Error("A commit message needs a subject before its trailers.");
  }
  const kept: string[] = [];
  let droppingContinuation = false;
  for (const line of trailers) {
    if (/^\s/.test(line) && !TRAILER_LINE.test(line)) {
      if (!droppingContinuation) kept.push(line);
      continue;
    }
    droppingContinuation = isOurs(line);
    if (!droppingContinuation) kept.push(line);
  }
  return [...body, "", ...kept, ...identityLines(identity)].join("\n");
}

/** The identity in a commit message's trailers, or undefined when it has none or a bad one. */
export function readTrailers(message: string): RunIdentity | undefined {
  return identityFromFields(trailerFields(splitMessage(message).trailers));
}

/** A small block for a pull request body: visible lines between two hidden markers. */
export function prBlock(identity: RunIdentity): string {
  assertIdentity(identity);
  return [PR_START, ...identityLines(identity), PR_END].join("\n");
}

/** The identity in the first xatlas block of a pull request body. */
export function readPrBlock(body: string): RunIdentity | undefined {
  // The markers count only as whole lines, so a value that contains one can't cut the block.
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const start = lines.indexOf(PR_START);
  if (start === -1) return undefined;
  const end = lines.indexOf(PR_END, start + 1);
  if (end === -1) return undefined;
  return identityFromFields(trailerFields(lines.slice(start + 1, end).filter(Boolean)));
}
