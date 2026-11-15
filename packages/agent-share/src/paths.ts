import { join } from "node:path";
import type { AgentId } from "./types.js";

export interface AgentPaths {
  /** Where its MCP servers live (read directly; some are written through the agent's CLI). */
  readonly mcpFile: string;
  readonly skillsDir: string;
  /** Its global instruction file. */
  readonly instructionsFile: string;
}

export function hubRoot(home: string): string {
  return join(home, ".agents");
}

export function agentPaths(home: string, agent: AgentId): AgentPaths {
  switch (agent) {
    case "claude":
      return {
        mcpFile: join(home, ".claude.json"),
        skillsDir: join(home, ".claude", "skills"),
        instructionsFile: join(home, ".claude", "CLAUDE.md"),
      };
    case "codex":
      return {
        mcpFile: join(home, ".codex", "config.toml"),
        skillsDir: join(home, ".codex", "skills"),
        instructionsFile: join(home, ".codex", "AGENTS.md"),
      };
    case "gemini":
      return {
        mcpFile: join(home, ".gemini", "settings.json"),
        skillsDir: join(home, ".gemini", "skills"),
        instructionsFile: join(home, ".gemini", "GEMINI.md"),
      };
    case "opencode":
      return {
        mcpFile: join(home, ".config", "opencode", "opencode.json"),
        skillsDir: join(home, ".config", "opencode", "skills"),
        instructionsFile: join(home, ".config", "opencode", "AGENTS.md"),
      };
    case "xatlas":
      return {
        mcpFile: join(home, ".zcode", "cli", "config.json"),
        // The built-in agent already reads ~/.agents/skills itself.
        skillsDir: join(home, ".agents", "skills"),
        instructionsFile: join(home, ".zcode", "AGENTS.md"),
      };
  }
}
