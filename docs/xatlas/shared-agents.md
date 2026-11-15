# One setup for every coding agent

Status: first version (2026-10-20). `pnpm agents:share` previews; `--apply` changes things.

Claude Code, Codex, Gemini CLI, OpenCode and xatlas each keep their own MCP servers, skills,
instructions and memory. `packages/agent-share` keeps one copy of each in `~/.agents` and
points every agent at it, in the agent's own format.

| Shared in `~/.agents` | Claude Code | Codex | Gemini CLI | OpenCode | xatlas |
|---|---|---|---|---|---|
| `mcp.json` MCP servers | `claude mcp add-json -s user` | `codex mcp add` | `settings.json` | `opencode.json` | `.zcode/cli/config.json` |
| `skills/` | symlinks in `~/.claude/skills` | `~/.codex/skills` | `~/.gemini/skills` | `~/.config/opencode/skills` | reads `~/.agents/skills` |
| `AGENTS.md` instructions | `@~/.agents/AGENTS.md` in CLAUDE.md | AGENTS.md symlink | GEMINI.md symlink | `instructions` entry | AGENTS.md symlink |
| `memory/` | `xatlas-memory` MCP server for all of them | | | | |

- **First run** builds the hub from what's there: the union of the agents' enabled MCP
  servers (Claude's entry wins on a name clash), Claude's CLAUDE.md as the shared
  instructions (CLAUDE.md then just imports it), plus a shared-memory section.
- **Computer use:** [UCU](https://github.com/betoxf/universal-computer-use) is shared with every
  agent except Codex, which has computer use built in (`"except": ["codex"]` in `mcp.json`).
  The **Use in all my agents** switch in the Connect window does this on its own; see
  [connect.md](connect.md).
- **Memory:** `packages/agent-share/src/memoryServer.mjs` is a dependency-free stdio MCP
  server over `~/.agents/memory` (`memory_list`, `memory_search`, `memory_read`,
  `memory_write`, `memory_delete`), in Claude's auto-memory layout.
- **Safety:** previews by default; backups of every changed file in
  `~/.agents/backups/<time>/`; `~/.agents/.xatlas-share.json` records what xatlas added, so
  it only removes its own entries. An agent's own differing entry, or its own copy of a
  skill, is reported and left alone.
- **xatlas target is opt-in** (`--agents xatlas`): it writes `~/.zcode`, which an installed
  ZCode also uses.

Next: a Settings page in the app (preview, apply, per-agent toggles), running on change
instead of by hand, hooks and "ways of working" (commands, subagents), and importing each
agent's existing memories into the shared one.
