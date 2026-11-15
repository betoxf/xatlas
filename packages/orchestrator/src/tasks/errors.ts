/** Why the ledger refused an entry. Callers branch on `code`, not on the message. */
export type LedgerRuleCode =
  | "unknown-task"
  | "unknown-run"
  | "task-exists"
  | "run-exists"
  | "illegal-move"
  | "task-closed"
  | "run-ended"
  | "wrong-task"
  | "wrong-run"
  /** The entry isn't well formed (an empty or multi-line id, a missing field, an unknown value). */
  | "invalid-entry";

/** An entry that breaks a rule (an illegal move, an unknown task or run). Nothing was written. */
export class LedgerRuleError extends Error {
  override readonly name = "LedgerRuleError";
  constructor(
    readonly code: LedgerRuleCode,
    message: string,
  ) {
    super(message);
  }
}

/** The ledger file has a line that can't be read, or entries that don't replay. */
export class LedgerCorruptError extends Error {
  override readonly name = "LedgerCorruptError";
  readonly code = "corrupt";
  constructor(
    message: string,
    /** 1-based line in the file (equal to the entry's place in the ledger). */
    readonly line: number,
    readonly file?: string,
  ) {
    super(file ? `${file}:${line}: ${message}` : `line ${line}: ${message}`);
  }
}

/** `expectedSeq` was given and the ledger has moved on since. Nothing was written. */
export class LedgerConflictError extends Error {
  override readonly name = "LedgerConflictError";
  readonly code = "conflict";
  constructor(
    readonly expectedSeq: number,
    readonly actualSeq: number,
  ) {
    super(`The ledger is at seq ${actualSeq}, not ${expectedSeq}`);
  }
}

/**
 * Another process held the lock for longer than the wait allowed. The lock was left alone: it
 * is never broken because of its age. The message says how to clear it by hand, for the case
 * where the pid now belongs to some other program (a pid reused after a crash).
 */
export class LedgerLockTimeoutError extends Error {
  override readonly name = "LedgerLockTimeoutError";
  readonly code = "lock-timeout";
  constructor(
    /** The lock folder; removing it by hand frees the ledger. */
    readonly lockPath: string,
    readonly ownerPid: number | undefined,
    /** ISO time the owner took the lock. */
    readonly since: string | undefined,
    /** Something that isn't a folder sits at the lock path, so it isn't a lock xatlas made. */
    readonly notALock = false,
  ) {
    super(
      notALock
        ? `Timed out waiting for the ledger lock: ${lockPath} is not a lock xatlas made. If no ` +
            `xatlas is running, remove ${lockPath} and try again.`
        : ownerPid === undefined
          ? `Timed out waiting for the ledger lock ${lockPath}, which holds no owner record xatlas ` +
            `can read. If no xatlas window is writing to this project, remove ${lockPath} and try again.`
          : `Timed out waiting for the ledger lock ${lockPath}, held by pid ${ownerPid} since ` +
            `${since ?? "an unknown time"}. If pid ${ownerPid} is not an xatlas process (its pid ` +
            `was reused after a crash), remove ${lockPath} and try again.`,
    );
  }
}
