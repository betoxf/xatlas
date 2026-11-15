import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

type SnapshotRow = ConversationSnapshot["rows"]["window"][number];

/** Something the conversation drew on: a page it read, web search, an MCP server. */
export type ConversationSource =
  | { kind: "link"; key: string; url: string; label: string }
  | { kind: "search"; key: string; queries: number }
  | { kind: "mcp"; key: string; label: string };

const WEB_FETCH_TOOL = /^(web_?fetch|fetch_url|read_url)$/i;
const WEB_SEARCH_TOOL = /^web_?search$/i;

function linkLabel(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    return `${parsed.host.replace(/^www\./, "")}${path}`;
  } catch {
    return null;
  }
}

/**
 * Sources used in the loaded part of a conversation, most recent first: pages
 * fetched, web search (one entry, counting queries) and MCP servers.
 */
export function collectConversationSources(rows: readonly SnapshotRow[]): ConversationSource[] {
  const links = new Map<string, ConversationSource>();
  const servers = new Map<string, ConversationSource>();
  let searches = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== "toolCall") {
      continue;
    }
    if (row.display?.kind === "mcp_tool") {
      const key = `mcp:${row.display.serverName}`;
      if (!servers.has(key)) {
        servers.set(key, { kind: "mcp", key, label: row.display.serverName });
      }
      continue;
    }
    if (WEB_SEARCH_TOOL.test(row.toolName)) {
      searches += 1;
      continue;
    }
    const url =
      row.input && typeof row.input === "object" && "url" in row.input
        ? (row.input as { url?: unknown }).url
        : undefined;
    if (WEB_FETCH_TOOL.test(row.toolName) && typeof url === "string") {
      const label = linkLabel(url);
      const key = `link:${label}`;
      if (label && !links.has(key)) {
        links.set(key, { kind: "link", key, url, label });
      }
    }
  }
  return [
    ...links.values(),
    ...(searches > 0 ? [{ kind: "search" as const, key: "search", queries: searches }] : []),
    ...servers.values(),
  ];
}
