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
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "error"; readonly message: string };

export type JsonRecord = Record<string, unknown>;

export type CliAgentDecoder = (line: JsonRecord) => CliAgentEvent[];

const ACTIVITY_MAX_LENGTH = 160;
/** The input field that best says what a tool call is about, most telling first. */
const TOOL_SUBJECT_FIELDS = [
  "command",
  "file_path",
  "filePath",
  "path",
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

export function describeToolUse(name: string, input: unknown): string {
  const fields = record(input);
  const subject = TOOL_SUBJECT_FIELDS.map((field) => string(fields?.[field])).find(Boolean);
  return subject ? `${name}: ${truncate(subject)}` : name;
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

function decodeClaude(line: JsonRecord): CliAgentEvent[] {
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
      if (delta?.type === "thinking_delta" && thinking) return [{ type: "thinking", text: thinking }];
      return [];
    }
    case "assistant": {
      // Text and thinking already arrived as deltas; only tool use is new here.
      const content = record(line.message)?.content;
      if (!Array.isArray(content)) return [];
      return content
        .map(record)
        .filter((block) => block?.type === "tool_use")
        .map((block) => ({
          type: "activity",
          text: describeToolUse(string(block?.name) ?? "Tool", block?.input),
        }));
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
    case "command_execution": {
      const command = completed ? undefined : string(item.command);
      return command ? [{ type: "activity", text: `Run: ${truncate(command)}` }] : [];
    }
    case "file_change": {
      if (!completed || !Array.isArray(item.changes)) return [];
      return item.changes.flatMap((change) => {
        const path = string(record(change)?.path);
        return path ? [{ type: "activity", text: `Edit: ${truncate(path)}` } as const] : [];
      });
    }
    case "mcp_tool_call":
    case "web_search": {
      if (!completed) return [];
      const subject = string(item.tool) ?? string(item.query);
      return [{ type: "activity", text: subject ? truncate(subject) : String(item.type) }];
    }
    default:
      return [];
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
    case "tool_use":
      return [
        {
          type: "activity",
          text: describeToolUse(string(line.tool_name) ?? "Tool", line.parameters),
        },
      ];
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
    case "tool_use":
      events.push({
        type: "activity",
        text: describeToolUse(string(part?.tool) ?? "Tool", record(part?.state)?.input),
      });
      break;
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
        message:
          string(record(record(line.error)?.data)?.message) ?? "OpenCode reported an error",
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
