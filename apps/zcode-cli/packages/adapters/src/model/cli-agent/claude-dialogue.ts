import {
  createCliAgentQuestions,
  type CliAgentDialogue,
  type CliAgentDialogueOptions,
} from "./dialogue.js";
import { decodeCliAgentLine, record, string, type JsonRecord } from "./events.js";
import type { CliAgentStdin } from "./process.js";

/** Claude Code's stream-json control protocol; `docs/xatlas/connect.md` has the recording. */
export function createClaudeDialogue(options: CliAgentDialogueOptions): CliAgentDialogue {
  let stdin: CliAgentStdin | undefined;
  const questions = createCliAgentQuestions(options.approve, options.signal);

  const respond = (requestId: string, response: JsonRecord) =>
    stdin?.writeLine({
      type: "control_response",
      response: { request_id: requestId, ...response },
    });

  const onRequest = (requestId: string, request: JsonRecord | undefined) => {
    if (request?.subtype !== "can_use_tool") {
      respond(requestId, {
        subtype: "error",
        error: `xatlas doesn't handle ${string(request?.subtype) ?? "this request"}`,
      });
      return;
    }
    const reason = string(request.decision_reason);
    questions.ask(
      requestId,
      {
        toolCallId: string(request.tool_use_id) ?? requestId,
        toolName: string(request.tool_name) ?? "Tool",
        input: request.input,
        ...(reason ? { reason } : {}),
      },
      (approval) =>
        respond(requestId, {
          subtype: "success",
          response: approval.allowed
            ? { behavior: "allow", updatedInput: approval.input }
            : { behavior: "deny", message: approval.reason },
        }),
    );
  };

  return {
    begin(next) {
      stdin = next;
      next.writeLine({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: options.prompt }] },
        parent_tool_use_id: null,
        session_id: "",
      });
    },
    read(line) {
      switch (line.type) {
        case "control_request": {
          const requestId = string(line.request_id);
          if (requestId) onRequest(requestId, record(line.request));
          return [];
        }
        case "control_cancel_request": {
          const requestId = string(line.request_id);
          if (requestId) questions.withdraw(requestId);
          return [];
        }
        case "result":
          // Open stdin is what keeps it waiting for another message.
          stdin?.end();
          break;
        default:
          break;
      }
      return decodeCliAgentLine("claude", line);
    },
    end: () => questions.end(),
  };
}
