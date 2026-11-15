import { describe, expect, it } from "vitest";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { collectConversationSources } from "@/v4/conversationSummarySources.js";

let rowId = 0;
function toolCall(toolName: string, extra: Partial<ToolCallRow> = {}): ToolCallRow {
  rowId += 1;
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 0,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName,
    status: "success",
    inputText: "",
    ...extra,
  } as ToolCallRow;
}

describe("collectConversationSources", () => {
  it("lists fetched pages (newest first, deduped), one web search entry, then MCP servers", () => {
    const sources = collectConversationSources([
      toolCall("WebFetch", { input: { url: "https://www.github.com/apple/ml-depth-pro/" } }),
      toolCall("WebSearch", { input: { query: "depth estimation" } }),
      toolCall("mcp__history__search", {
        display: { kind: "mcp_tool", serverName: "Computer History", toolName: "search" },
      }),
      toolCall("WebFetch", { input: { url: "https://docs.example.com/guide" } }),
      toolCall("WebFetch", { input: { url: "https://github.com/apple/ml-depth-pro" } }),
      toolCall("web_search", { input: { query: "monocular depth" } }),
      toolCall("Bash", { input: { command: "ls" } }),
    ]);
    expect(sources).toEqual([
      {
        kind: "link",
        key: "link:github.com/apple/ml-depth-pro",
        url: "https://github.com/apple/ml-depth-pro",
        label: "github.com/apple/ml-depth-pro",
      },
      {
        kind: "link",
        key: "link:docs.example.com/guide",
        url: "https://docs.example.com/guide",
        label: "docs.example.com/guide",
      },
      { kind: "search", key: "search", queries: 2 },
      { kind: "mcp", key: "mcp:Computer History", label: "Computer History" },
    ]);
  });

  it("ignores fetches without a usable URL", () => {
    expect(
      collectConversationSources([
        toolCall("WebFetch", { input: { url: "not a url" } }),
        toolCall("WebFetch", { input: { prompt: "summarise" } }),
      ]),
    ).toEqual([]);
  });
});
