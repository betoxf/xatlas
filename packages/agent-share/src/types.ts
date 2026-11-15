/** The coding agents xatlas keeps in step. */
export const AGENT_IDS = ["claude", "codex", "gemini", "opencode", "xatlas"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** One MCP server, in the neutral shape the shared hub stores. */
export interface SharedMcpServer {
  readonly type: "stdio" | "http" | "sse";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Tool-call timeout in milliseconds, for agents that support one. */
  readonly timeout?: number;
  /** Agents that shouldn't get this server, e.g. Codex for its own computer use. */
  readonly except?: readonly AgentId[];
}

/** What the shared folder (`~/.agents`) holds. */
export interface Hub {
  readonly root: string;
  readonly mcp: Readonly<Record<string, SharedMcpServer>>;
  /** Skill folder names under `<root>/skills`. */
  readonly skills: readonly string[];
  /** `<root>/AGENTS.md`, when it exists. */
  readonly instructionsPath?: string;
}

export type ShareAction =
  | { kind: "mcp-set"; agent: AgentId; name: string; server: SharedMcpServer; replace: boolean }
  | { kind: "mcp-remove"; agent: AgentId; name: string }
  | { kind: "skill-link"; agent: AgentId; name: string; link: string; target: string }
  | { kind: "skill-unlink"; agent: AgentId; name: string; link: string }
  /** Point an instruction file (AGENTS.md / GEMINI.md) at the shared one with a symlink. */
  | { kind: "instructions-link"; agent: AgentId; path: string; target: string }
  /** Make CLAUDE.md import the shared file; `replace` drops content that moved into it. */
  | { kind: "instructions-import"; agent: AgentId; path: string; line: string; replace: boolean }
  /** Add the shared file to opencode.json `instructions`. */
  | { kind: "instructions-entry"; agent: AgentId; path: string; entry: string };

export interface ShareNote {
  readonly agent: AgentId;
  readonly kind: "conflict" | "own-copy" | "manual";
  readonly message: string;
}

export interface SharePlan {
  readonly actions: readonly ShareAction[];
  readonly notes: readonly ShareNote[];
}

/** What xatlas created in each agent, so it only ever removes its own entries. */
export interface ShareState {
  mcp: Partial<Record<AgentId, string[]>>;
  skills: Partial<Record<AgentId, string[]>>;
}
