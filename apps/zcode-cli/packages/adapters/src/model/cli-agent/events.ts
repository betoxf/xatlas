import type { ModelUsage } from "@zcode/contracts";
import type { CliAgentId } from "@zcode/shared/cli-agents";

/** What every CLI's event stream comes down to. */
export type CliAgentEvent =
  | { readonly type: "session"; readonly id: string }
  /** Part of a message, as it streams. */
  | { readonly type: "text"; readonly text: string }
  /** A whole message, from a CLI that doesn't stream them. */
  | { readonly type: "message"; readonly text: string }
  /** The whole reply again, for a turn whose text didn't stream. */
  | { readonly type: "reply"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  /** One line saying what the agent is doing with its own tools. */
  | { readonly type: "activity"; readonly text: string }
  /** A call the CLI made with its own tool, shown as a card; the CLI runs it, never the runtime. */
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  /** What that call returned, as text, cut to `TOOL_OUTPUT_MAX_LENGTH`. */
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "error"; readonly message: string };

export type JsonRecord = Record<string, unknown>;

export type CliAgentDecoder = (line: JsonRecord) => CliAgentEvent[];

const ACTIVITY_MAX_LENGTH = 160;
/** Tool output is saved with the conversation and replayed, so a long one is cut. */
export const TOOL_OUTPUT_MAX_LENGTH = 4_000;
/** The input field that best says what a tool call is about, most telling first. */
const TOOL_SUBJECT_FIELDS = [
  "command",
  "file_path",
  "filePath",
  "path",
  "dir_path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
] as const;

export const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

export const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function truncate(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > ACTIVITY_MAX_LENGTH ? `${line.slice(0, ACTIVITY_MAX_LENGTH)}…` : line;
}

/** What a tool call is about, from its input: a path, a command, a query. */
export function toolSubject(input: unknown): string | undefined {
  const fields = record(input);
  const subject = TOOL_SUBJECT_FIELDS.map((field) => string(fields?.[field])).find(Boolean);
  if (subject) return truncate(subject);
  const files = Array.isArray(fields?.files) ? fields.files.flatMap((file) => string(file) ?? []) : [];
  return files.length > 0 ? truncate(files.join(", ")) : undefined;
}

export function describeToolUse(name: string, input: unknown): string {
  const subject = toolSubject(input);
  return subject ? `${name}: ${subject}` : name;
}

export function usage(fields: {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
}): CliAgentEvent {
  return {
    type: "usage",
    usage: {
      inputTokens: number(fields.input),
      outputTokens: number(fields.output),
      cacheReadTokens: number(fields.cacheRead),
      cacheWriteTokens: number(fields.cacheWrite),
      reasoningTokens: number(fields.reasoning),
    },
  };
}

/** A tool result's content as text: a string, or text blocks (images are named, not inlined). */
function toolResultText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map(record)
            .map((block) =>
              block?.type === "text"
                ? (string(block.text) ?? "")
                : block?.type
                  ? `[${String(block.type)}]`
                  : "",
            )
            .filter(Boolean)
            .join("\n")
        : "";
  return capToolOutput(text);
}

/** Text cut to `TOOL_OUTPUT_MAX_LENGTH`, saying how much was left out. */
function capToolOutput(text: string): string {
  return text.length > TOOL_OUTPUT_MAX_LENGTH
    ? `${text.slice(0, TOOL_OUTPUT_MAX_LENGTH)}\n… (${text.length - TOOL_OUTPUT_MAX_LENGTH} more characters)`
    : text;
}

/** The command as the model wrote it, without the shell Codex wraps around it. */
export function codexCommandLine(fields: JsonRecord | undefined): string {
  const actions = Array.isArray(fields?.commandActions) ? fields.commandActions : [];
  const commands = actions.flatMap((action) => string(record(action)?.command) ?? []);
  return commands.length > 0 ? commands.join("\n") : (string(fields?.command) ?? "");
}

const CODEX_FAILED = new Set(["failed", "declined"]);

/**
 * A Codex tool item as a card: the call when it starts (or, for one that only reports its end,
 * when it completes) and its result when it completes. `codex exec --json` and the app server
 * name the same items in snake_case and camelCase; both are read here.
 */
export function decodeCodexToolItem(
  item: JsonRecord | undefined,
  completed: boolean,
): CliAgentEvent[] {
  const id = string(item?.id);
  if (!item || !id) return [];
  const call = (name: string, input: unknown): CliAgentEvent => ({
    type: "tool_call",
    id,
    name,
    input,
  });
  const result = (output: string, isError: boolean): CliAgentEvent => ({
    type: "tool_result",
    id,
    output: capToolOutput(output),
    isError,
  });
  const failed = CODEX_FAILED.has(String(item.status));
  switch (item.type) {
    case "command_execution":
    case "commandExecution": {
      const events = [call("Shell", { command: codexCommandLine(item) })];
      if (!completed) return events;
      const output = string(item.aggregated_output) ?? string(item.aggregatedOutput) ?? "";
      const exit = item.exit_code ?? item.exitCode;
      const code = typeof exit === "number" ? exit : undefined;
      const tail = code !== undefined && code !== 0 ? `\n(exit code ${code})` : "";
      return [...events, result(`${output}${tail}`, failed || (code !== undefined && code !== 0))];
    }
    case "file_change":
    case "fileChange": {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(record);
      const lines = changes.flatMap((change) => {
        const path = string(change?.path);
        const kind = string(change?.kind) ?? string(record(change?.kind)?.type) ?? "update";
        return path ? [`${kind} ${path}`] : [];
      });
      const events = [call("Edit", { files: lines })];
      return completed ? [...events, result(lines.join("\n"), failed)] : events;
    }
    case "mcp_tool_call":
    case "mcpToolCall": {
      const name = [string(item.server), string(item.tool)].filter(Boolean).join(".") || "MCP tool";
      const events = [call(name, item.arguments ?? {})];
      if (!completed) return events;
      const error = string(record(item.error)?.message);
      const content = record(item.result)?.content;
      return [...events, result(error ?? toolResultText(content), failed || error !== undefined)];
    }
    case "dynamic_tool_call":
    case "dynamicToolCall": {
      const events = [call(string(item.tool) ?? "Tool", item.arguments ?? {})];
      if (!completed) return events;
      const output = toolResultText(item.content_items ?? item.contentItems);
      return [...events, result(output, failed || item.success === false)];
    }
    case "web_search":
    case "webSearch": {
      // The query is only known once the search is done.
      if (!completed) return [];
      const query = string(item.query) ?? "";
      const results = Array.isArray(item.results) ? `${item.results.length} results` : "Done";
      return [call("WebSearch", { query }), result(results, false)];
    }
    default:
      return [];
  }
}

function decodeClaude(line: JsonRecord): CliAgentEvent[] {
  // Calls made inside a subagent belong to the subagent's own card; they stay one-line activity.
  const topLevel = line.parent_tool_use_id === null || line.parent_tool_use_id === undefined;
  switch (line.type) {
    case "system": {
      const id = line.subtype === "init" ? string(line.session_id) : undefined;
      return id ? [{ type: "session", id }] : [];
    }
    case "stream_event": {
      const delta = record(record(line.event)?.delta);
      const text = string(delta?.text);
      if (delta?.type === "text_delta" && text) return [{ type: "text", text }];
      const thinking = string(delta?.thinking);
      if (delta?.type === "thinking_delta" && thinking)
        return [{ type: "thinking", text: thinking }];
      return [];
    }
    case "assistant": {
      // Text and thinking already arrived as deltas; only tool use is new here.
      const content = record(line.message)?.content;
      if (!Array.isArray(content)) return [];
      return content
        .map(record)
        .filter((block) => block?.type === "tool_use")
        .map((block): CliAgentEvent => {
          const name = string(block?.name) ?? "Tool";
          const id = string(block?.id);
          return topLevel && id
            ? { type: "tool_call", id, name, input: block?.input ?? {} }
            : { type: "activity", text: describeToolUse(name, block?.input) };
        });
    }
    case "user": {
      const content = record(line.message)?.content;
      if (!topLevel || !Array.isArray(content)) return [];
      return content
        .map(record)
        .filter((block) => block?.type === "tool_result")
        .flatMap((block): CliAgentEvent[] => {
          const id = string(block?.tool_use_id);
          return id
            ? [
                {
                  type: "tool_result",
                  id,
                  output: toolResultText(block?.content),
                  isError: block?.is_error === true,
                },
              ]
            : [];
        });
    }
    case "result": {
      const counts = record(line.usage);
      const events: CliAgentEvent[] = [
        usage({
          input: counts?.input_tokens,
          output: counts?.output_tokens,
          cacheRead: counts?.cache_read_input_tokens,
          cacheWrite: counts?.cache_creation_input_tokens,
        }),
      ];
      const result = string(line.result);
      if (line.is_error === true) {
        events.push({
          type: "error",
          message: result ?? string(line.subtype) ?? "Claude Code reported an error",
        });
      } else if (result) {
        events.push({ type: "reply", text: result });
      }
      return events;
    }
    default:
      return [];
  }
}

function decodeCodexItem(line: JsonRecord): CliAgentEvent[] {
  const item = record(line.item);
  const completed = line.type === "item.completed";
  switch (item?.type) {
    case "agent_message": {
      const text = completed ? string(item.text) : undefined;
      return text ? [{ type: "message", text }] : [];
    }
    case "reasoning": {
      const text = completed ? string(item.text) : undefined;
      return text ? [{ type: "thinking", text }] : [];
    }
    default:
      return decodeCodexToolItem(item, completed);
  }
}

function decodeCodex(line: JsonRecord): CliAgentEvent[] {
  switch (line.type) {
    case "thread.started": {
      const id = string(line.thread_id);
      return id ? [{ type: "session", id }] : [];
    }
    case "item.started":
    case "item.completed":
      return decodeCodexItem(line);
    case "turn.completed": {
      const counts = record(line.usage);
      return [
        usage({
          input: counts?.input_tokens,
          output: counts?.output_tokens,
          cacheRead: counts?.cached_input_tokens,
          cacheWrite: counts?.cache_write_input_tokens,
          reasoning: counts?.reasoning_output_tokens,
        }),
      ];
    }
    case "turn.failed":
      return [
        {
          type: "error",
          message: string(record(line.error)?.message) ?? "Codex couldn't finish this turn",
        },
      ];
    case "error":
      return [{ type: "error", message: string(line.message) ?? "Codex reported an error" }];
    default:
      return [];
  }
}

function decodeGemini(line: JsonRecord): CliAgentEvent[] {
  switch (line.type) {
    case "message": {
      const text = line.role === "assistant" ? string(line.content) : undefined;
      return text ? [{ type: "text", text }] : [];
    }
    case "tool_use": {
      const name = string(line.tool_name) ?? "Tool";
      const id = string(line.tool_id);
      return id
        ? [{ type: "tool_call", id, name, input: line.parameters ?? {} }]
        : [{ type: "activity", text: describeToolUse(name, line.parameters) }];
    }
    case "tool_result": {
      const id = string(line.tool_id);
      if (!id) return [];
      const error = string(record(line.error)?.message);
      const output = string(line.output) ?? error ?? (line.status === "error" ? "Failed" : "Done");
      return [
        {
          type: "tool_result",
          id,
          output: capToolOutput(output),
          isError: line.status === "error" || error !== undefined,
        },
      ];
    }
    case "error":
      return [{ type: "error", message: string(line.message) ?? "Gemini CLI reported an error" }];
    case "result": {
      const stats = record(line.stats);
      const events: CliAgentEvent[] = [
        usage({ input: stats?.input_tokens, output: stats?.output_tokens }),
      ];
      if (line.status === "error") {
        events.push({
          type: "error",
          message: string(record(line.error)?.message) ?? "Gemini CLI couldn't finish this turn",
        });
      }
      return events;
    }
    default:
      return [];
  }
}

function decodeOpenCode(line: JsonRecord): CliAgentEvent[] {
  const part = record(line.part);
  const events: CliAgentEvent[] = [];
  const id = string(line.sessionID);
  if (id) events.push({ type: "session", id });
  switch (line.type) {
    case "text": {
      const text = string(part?.text);
      if (text) events.push({ type: "message", text });
      break;
    }
    case "reasoning": {
      const text = string(part?.text);
      if (text) events.push({ type: "thinking", text });
      break;
    }
    case "tool_use": {
      // `opencode run` reports a tool once, when it has finished, with its input and output.
      const name = string(part?.tool) ?? "Tool";
      const state = record(part?.state);
      const callId = string(part?.callID) ?? string(part?.id);
      if (!callId) {
        events.push({ type: "activity", text: describeToolUse(name, state?.input) });
        break;
      }
      events.push({ type: "tool_call", id: callId, name, input: state?.input ?? {} });
      if (state?.status === "completed" || state?.status === "error") {
        const isError = state.status === "error";
        const output = isError
          ? (string(state.error) ?? "Failed")
          : (string(state.output) ?? string(state.title) ?? "Done");
        events.push({ type: "tool_result", id: callId, output: capToolOutput(output), isError });
      }
      break;
    }
    case "step_finish": {
      const tokens = record(part?.tokens);
      const cache = record(tokens?.cache);
      events.push(
        usage({
          input: tokens?.input,
          output: tokens?.output,
          cacheRead: cache?.read,
          cacheWrite: cache?.write,
          reasoning: tokens?.reasoning,
        }),
      );
      break;
    }
    case "error":
      events.push({
        type: "error",
        message: string(record(record(line.error)?.data)?.message) ?? "OpenCode reported an error",
      });
      break;
    default:
      break;
  }
  return events;
}

const DECODERS: Record<CliAgentId, CliAgentDecoder> = {
  claude: decodeClaude,
  codex: decodeCodex,
  gemini: decodeGemini,
  opencode: decodeOpenCode,
};

export function decodeCliAgentLine(agent: CliAgentId, line: JsonRecord): CliAgentEvent[] {
  return DECODERS[agent](line);
}
