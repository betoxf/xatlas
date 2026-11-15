import type {
  ModelAgentToolApproval,
  ModelAgentToolApprovalPort,
  ModelAgentToolApprovalRequest,
} from "@zcode/contracts";
import type { CliAgentEffort } from "./commands.js";
import type { CliAgentEvent, JsonRecord } from "./events.js";
import type { CliAgentStdin } from "./process.js";

/** A run that talks back: it answers the CLI's questions while the turn goes on. */
export interface CliAgentDialogue {
  /** Opens the conversation, once the CLI is up. */
  begin(stdin: CliAgentStdin): void;
  /** Takes in one line of the CLI's output and says what it means for the turn. */
  read(line: JsonRecord): CliAgentEvent[];
  /** Withdraws whatever is still waiting, and resolves once that has settled. */
  end(): Promise<void>;
}

export interface CliAgentDialogueOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: CliAgentEffort;
  readonly fast?: boolean;
  readonly resumeId?: string;
  readonly approve: ModelAgentToolApprovalPort;
  readonly signal?: AbortSignal;
}

/** A question the CLI put to the person, in the runtime's terms. */
export type CliAgentQuestion = Omit<ModelAgentToolApprovalRequest, "signal">;

export interface CliAgentQuestions {
  ask(
    id: string,
    question: CliAgentQuestion,
    answer: (approval: ModelAgentToolApproval) => void,
  ): void;
  withdraw(id: string): void;
  end(): Promise<void>;
}

/**
 * What a run is waiting on. Reading goes on meanwhile, because the CLI can withdraw a question
 * while it's open, and each question gets one answer, or none once withdrawn.
 */
export function createCliAgentQuestions(
  approve: ModelAgentToolApprovalPort,
  signal: AbortSignal | undefined,
): CliAgentQuestions {
  const withdrawals = new Map<string, AbortController>();
  const waiting = new Set<Promise<void>>();

  return {
    ask(id, question, answer) {
      const withdrawal = new AbortController();
      withdrawals.set(id, withdrawal);
      const settled = approve({
        ...question,
        signal: signal ? AbortSignal.any([signal, withdrawal.signal]) : withdrawal.signal,
      })
        .catch(
          (error: unknown): ModelAgentToolApproval => ({
            allowed: false,
            reason: error instanceof Error ? error.message : "The approval failed",
          }),
        )
        .then((approval) => {
          withdrawals.delete(id);
          if (!withdrawal.signal.aborted) answer(approval);
        })
        .finally(() => waiting.delete(settled));
      waiting.add(settled);
    },
    withdraw(id) {
      withdrawals.get(id)?.abort();
    },
    async end() {
      for (const withdrawal of withdrawals.values()) withdrawal.abort();
      await Promise.all(waiting);
    },
  };
}
