import {
  createCliAgentQuestions,
  type CliAgentDialogue,
  type CliAgentDialogueOptions,
  type CliAgentQuestion,
} from "./dialogue.js";
import { codexCommandLine, record, string, type CliAgentEvent, type JsonRecord } from "./events.js";
import {
  decodeCodexAppServerNotification,
  describeCodexFileChanges,
} from "./codex-app-server-events.js";
import { CODEX_FAST_SERVICE_TIER } from "./commands.js";
import type { CliAgentStdin } from "./process.js";

const INITIALIZE_REQUEST_ID = 1;
const THREAD_REQUEST_ID = 2;
const TURN_REQUEST_ID = 3;
const METHOD_NOT_FOUND = -32601;

/** Reads run unasked and the sandbox blocks every write until one is approved. */
const THREAD_PERMISSIONS = {
  approvalPolicy: "on-request",
  // A config that sends approvals to an automatic reviewer mustn't answer for the person.
  approvalsReviewer: "user",
  sandbox: "read-only",
} as const;

/** `codex app-server`'s JSON-RPC over stdio; `docs/xatlas/connect.md` has the recording. */
export function createCodexDialogue(options: CliAgentDialogueOptions): CliAgentDialogue {
  let stdin: CliAgentStdin | undefined;
  /** A file change's paths and diff arrive with the item, before the request to approve it. */
  const fileChanges = new Map<string, unknown>();
  const questions = createCliAgentQuestions(options.approve, options.signal);

  const startThread = () => {
    stdin?.writeLine({ method: "initialized" });
    const model = options.model ? { model: options.model } : {};
    stdin?.writeLine({
      id: THREAD_REQUEST_ID,
      method: options.resumeId ? "thread/resume" : "thread/start",
      params: {
        cwd: options.cwd,
        ...THREAD_PERMISSIONS,
        ...model,
        ...(options.resumeId ? { threadId: options.resumeId, excludeTurns: true } : {}),
      },
    });
  };

  // `thread/resume` takes no effort, so both go on the turn, which keeps them for the next ones.
  const startTurn = (threadId: string) =>
    stdin?.writeLine({
      id: TURN_REQUEST_ID,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: options.prompt }],
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.fast ? { serviceTier: CODEX_FAST_SERVICE_TIER } : {}),
      },
    });

  const onResponse = (line: JsonRecord): CliAgentEvent[] => {
    const error = record(line.error);
    if (error) {
      return [{ type: "error", message: string(error.message) ?? "Codex refused the request" }];
    }
    if (line.id === INITIALIZE_REQUEST_ID) {
      startThread();
    } else if (line.id === THREAD_REQUEST_ID) {
      const threadId = string(record(record(line.result)?.thread)?.id);
      if (!threadId) return [{ type: "error", message: "Codex didn't start a session" }];
      startTurn(threadId);
      return [{ type: "session", id: threadId }];
    }
    return [];
  };

  const askAndAnswer = (id: unknown, question: CliAgentQuestion) =>
    questions.ask(String(id), question, (approval) =>
      stdin?.writeLine({ id, result: { decision: approval.allowed ? "accept" : "decline" } }),
    );

  const onRequest = (id: unknown, method: string, params: JsonRecord | undefined) => {
    const reason = string(params?.reason);
    const asked = reason ? { reason } : {};
    switch (method) {
      case "item/commandExecution/requestApproval":
        askAndAnswer(id, {
          toolCallId: string(params?.approvalId) ?? string(params?.itemId) ?? String(id),
          toolName: "Bash",
          input: { command: codexCommandLine(params), ...(reason ? { description: reason } : {}) },
          ...asked,
        });
        break;
      case "item/fileChange/requestApproval": {
        const itemId = string(params?.itemId);
        askAndAnswer(id, {
          toolCallId: itemId ?? String(id),
          toolName: "Edit",
          input: { changes: describeCodexFileChanges(fileChanges.get(itemId ?? "")) },
          ...asked,
        });
        break;
      }
      default:
        stdin?.writeLine({
          id,
          error: { code: METHOD_NOT_FOUND, message: `xatlas doesn't handle ${method}` },
        });
    }
  };

  const onNotification = (method: string, params: JsonRecord | undefined): CliAgentEvent[] => {
    switch (method) {
      case "item/started": {
        const item = record(params?.item);
        const itemId = string(item?.id);
        if (item?.type === "fileChange" && itemId) fileChanges.set(itemId, item.changes);
        break;
      }
      case "serverRequest/resolved":
        questions.withdraw(String(params?.requestId));
        break;
      case "turn/completed":
        // The server stays up for another turn until its stdin closes.
        stdin?.end();
        break;
      default:
        break;
    }
    return decodeCodexAppServerNotification(method, params);
  };

  return {
    begin(next) {
      stdin = next;
      next.writeLine({
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          clientInfo: { name: "xatlas", title: "xatlas", version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      });
    },
    read(line) {
      const method = string(line.method);
      if (!method) return onResponse(line);
      if (line.id === undefined) return onNotification(method, record(line.params));
      onRequest(line.id, method, record(line.params));
      return [];
    },
    end: () => questions.end(),
  };
}
