import {
  decodeCodexToolItem,
  record,
  string,
  usage,
  type CliAgentEvent,
  type JsonRecord,
} from "./events.js";

/** Codex's file changes in the form the approval dialog reads, keyed by path. */
export function describeCodexFileChanges(changes: unknown): JsonRecord {
  if (!Array.isArray(changes)) return {};
  const described: JsonRecord = {};
  for (const change of changes.map(record)) {
    const path = string(change?.path);
    if (!path) continue;
    const type = string(record(change?.kind)?.type);
    const diff = string(change?.diff);
    // `diff` is the whole file for an added or deleted one, and a unified diff for an update.
    if (type === "add") described[path] = { type, content: diff };
    else if (type === "delete") described[path] = { type, old_content: diff };
    else described[path] = { type: "update", unified_diff: diff };
  }
  return described;
}

function decodeCompletedItem(item: JsonRecord | undefined): CliAgentEvent[] {
  switch (item?.type) {
    case "agentMessage": {
      const text = string(item.text);
      return text ? [{ type: "message", text }] : [];
    }
    case "reasoning": {
      const parts = [item.summary, item.content].flatMap((part) =>
        Array.isArray(part) ? part.flatMap((text) => string(text) ?? []) : [],
      );
      return parts.length > 0 ? [{ type: "thinking", text: parts.join("\n") }] : [];
    }
    default:
      return decodeCodexToolItem(item, true);
  }
}

/** What `codex exec --json` reports, from the app server's notifications. */
export function decodeCodexAppServerNotification(
  method: string,
  params: JsonRecord | undefined,
): CliAgentEvent[] {
  switch (method) {
    case "item/started":
      return decodeCodexToolItem(record(params?.item), false);
    case "item/completed":
      return decodeCompletedItem(record(params?.item));
    case "thread/tokenUsage/updated": {
      // `total` adds up the whole session, earlier turns included.
      const counts = record(record(params?.tokenUsage)?.last);
      return [
        usage({
          input: counts?.inputTokens,
          output: counts?.outputTokens,
          cacheRead: counts?.cachedInputTokens,
          cacheWrite: counts?.cacheWriteInputTokens,
          reasoning: counts?.reasoningOutputTokens,
        }),
      ];
    }
    case "turn/completed": {
      const turn = record(params?.turn);
      if (turn?.status === "completed") return [];
      return [
        {
          type: "error",
          message: string(record(turn?.error)?.message) ?? "Codex couldn't finish this turn",
        },
      ];
    }
    default:
      return [];
  }
}
