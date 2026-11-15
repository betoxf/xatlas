import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LedgerDraft, LedgerEntry } from "../types.js";
import { LedgerConflictError, LedgerCorruptError, LedgerRuleError } from "./errors.js";
import { withLedgerLock } from "./lock.js";
import { applyEntry, replay, type ProjectState } from "./replay.js";
import { entryProblem, idProblem, projectKeyProblem } from "./validate.js";

export interface LedgerOptions {
  /** The folder the ledgers live in. Never inside a repository. */
  readonly dataDir: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** How long a write waits for another live writer before giving up (default 30 s). */
  readonly lockTimeoutMs?: number;
}

/** What a write may look at, inside the lock, to build its entry. */
export interface LedgerWriteContext {
  readonly entries: readonly LedgerEntry[];
  readonly state: ProjectState;
  readonly newId: () => string;
}

/**
 * Builds an entry from the ledger as it is inside the lock, so a check and the write it allows
 * can't be split by another writer. It may throw to refuse; nothing is written then.
 */
export type LedgerDraftBuilder = (context: LedgerWriteContext) => LedgerDraft;

export interface Ledger {
  read(projectKey: string): Promise<readonly LedgerEntry[]>;
  /**
   * Adds one entry and returns it. An entry whose `id` is already there is returned as it is,
   * and nothing is written. `expectedSeq` is the last seq the caller saw; if the ledger has
   * moved on, a `LedgerConflictError` is thrown. An entry that breaks a rule throws a
   * `LedgerRuleError`.
   */
  append(
    projectKey: string,
    draft: LedgerDraft | LedgerDraftBuilder,
    options?: { readonly expectedSeq?: number },
  ): Promise<LedgerEntry>;
}

/** The project's ledger file: named from a hash of the key, so any key makes a safe name. */
export function ledgerPath(dataDir: string, projectKey: string): string {
  const hash = createHash("sha256").update(projectKey).digest("hex");
  return join(dataDir, "ledgers", `${hash}.jsonl`);
}

export function openLedger(options: LedgerOptions): Ledger {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const timeoutMs = options.lockTimeoutMs ?? 30_000;

  return {
    async read(projectKey) {
      refuse(projectKeyProblem(projectKey));
      return (await load(ledgerPath(options.dataDir, projectKey), projectKey)).entries;
    },

    async append(projectKey, draftOrBuilder, appendOptions = {}) {
      refuse(projectKeyProblem(projectKey));
      const file = ledgerPath(options.dataDir, projectKey);
      await mkdir(dirname(file), { recursive: true });
      return withLedgerLock(`${file}.lock`, timeoutMs, async () => {
        const { entries, completeBytes, cutOff } = await load(file, projectKey);
        const state = replay(entries);
        const draft =
          typeof draftOrBuilder === "function"
            ? draftOrBuilder({ entries, state, newId })
            : draftOrBuilder;
        const id = draft.id ?? newId();
        refuse(idProblem(id));
        const existing = entries.find((entry) => entry.id === id);
        if (existing) return existing;
        const { expectedSeq } = appendOptions;
        if (expectedSeq !== undefined && expectedSeq !== state.seq) {
          throw new LedgerConflictError(expectedSeq, state.seq);
        }
        const entry = {
          ...draft,
          id,
          seq: state.seq + 1,
          at: now().toISOString(),
          projectKey,
        } as LedgerEntry;
        // The same check the reader makes, so nothing is written that wouldn't read back.
        refuse(entryProblem(entry));
        applyEntry(state, entry); // throws when the entry breaks a rule
        await write(file, `${JSON.stringify(entry)}\n`, cutOff ? completeBytes : undefined);
        return entry;
      });
    },
  };
}

/** Throws when a check found a problem; nothing has been written by then. */
function refuse(problem: string | undefined): void {
  if (problem !== undefined) throw new LedgerRuleError("invalid-entry", problem);
}

/**
 * Appends one line and waits for it to reach the disk. A cut-off last line left by a writer
 * that crashed is cut away first, so the new line starts on a line of its own.
 */
async function write(file: string, line: string, truncateTo: number | undefined): Promise<void> {
  // By path, before the append handle opens: truncating through an append handle isn't allowed everywhere.
  if (truncateTo !== undefined) await truncate(file, truncateTo);
  const handle = await open(file, "a");
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface Loaded {
  readonly entries: LedgerEntry[];
  /** Bytes up to and including the last newline. */
  readonly completeBytes: number;
  /** Whether text follows the last newline: a write that never finished. */
  readonly cutOff: boolean;
}

/**
 * Reads the file without the lock. A line counts only once its newline is written, so a line
 * still being written (or cut off by a crash) is left out. Any finished line that can't be
 * read stops the read with an error naming it.
 */
async function load(file: string, projectKey: string): Promise<Loaded> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { entries: [], completeBytes: 0, cutOff: false };
    }
    throw error;
  }
  const completeBytes = bytes.lastIndexOf(0x0a) + 1;
  const lines = bytes.subarray(0, completeBytes).toString("utf8").split("\n");
  lines.pop(); // the empty text after the last newline
  const ids = new Set<string>();
  const entries = lines.map((text, index) => {
    const entry = parseLine(text, index + 1, file, projectKey);
    if (ids.has(entry.id)) throw new LedgerCorruptError(`id ${entry.id} repeats`, index + 1, file);
    ids.add(entry.id);
    return entry;
  });
  return { entries, completeBytes, cutOff: completeBytes < bytes.length };
}

function parseLine(text: string, line: number, file: string, projectKey: string): LedgerEntry {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerCorruptError("not JSON", line, file);
  }
  const problem = entryProblem(value);
  if (problem) throw new LedgerCorruptError(problem, line, file);
  const entry = value as LedgerEntry;
  if (entry.seq !== line)
    throw new LedgerCorruptError(`seq ${entry.seq} on line ${line}`, line, file);
  if (entry.projectKey !== projectKey) {
    throw new LedgerCorruptError(`belongs to project ${entry.projectKey}`, line, file);
  }
  return entry;
}
