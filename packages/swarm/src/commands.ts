import type { Effort, SwarmMember, SwarmMemberOption } from "./types.js";

/**
 * How each agent CLI is run for one member, as a pure function so tests can check the
 * arguments without starting anything. Checked on 2026-11-15 against Claude Code 2.1.325,
 * Codex 0.169.0, OpenCode 1.18.21 and Gemini CLI 0.66.0: the flags come from each CLI's help,
 * and Codex's config keys from its own config file and model catalog. docs/xatlas/swarm.md
 * has the table.
 */
export interface MemberCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Sent on stdin; absent when the prompt goes in the arguments. */
  readonly stdin?: string;
}

/**
 * The command for one member. Effort is sent as named: Claude Code's `--effort` lists low,
 * medium, high, xhigh and max, and Codex's catalog has the same levels for its current models.
 * OpenCode's `--variant` is provider-specific and its help only gives examples ("high, max,
 * minimal"), so whether a level exists depends on the model. Fast mode is
 * sent only when `fast` is true; false and absent both leave the CLI's own setting alone.
 * The read-only modes (Claude Code plan mode, Codex read-only sandbox) are always on.
 *
 * `replyFile` is where Codex writes its last message; the others print theirs.
 */
export function memberCommand(
  member: SwarmMember,
  prompt: string,
  replyFile: string,
): MemberCommand {
  const effort = member.effort;
  switch (member.agent) {
    case "claude":
      return {
        command: "claude",
        args: [
          "-p",
          "--permission-mode",
          "plan",
          ...(member.model ? ["--model", member.model] : []),
          ...(effort ? ["--effort", effort] : []),
        ],
        stdin: prompt,
      };
    case "codex":
      return {
        command: "codex",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          ...(member.model ? ["-m", member.model] : []),
          ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
          ...(member.fast ? ["-c", 'service_tier="priority"'] : []),
          "-o",
          replyFile,
          "-",
        ],
        stdin: prompt,
      };
    case "opencode":
      return {
        command: "opencode",
        args: [
          "run",
          ...(member.model ? ["-m", member.model] : []),
          ...(effort ? ["--variant", effort] : []),
          "--format",
          "json",
          prompt,
        ],
      };
    case "gemini":
      return {
        command: "gemini",
        args: ["-p", prompt, ...(member.model ? ["-m", member.model] : [])],
      };
  }
}

/**
 * The command for an outside advisor in Claude Code, with no tools and nothing of the person's:
 * `--safe-mode` leaves out their CLAUDE.md (whose imports could pull in any file), hooks,
 * plugins and settings while keeping their sign-in; `--tools ""` turns every built-in tool
 * off; `--strict-mcp-config` with no `--mcp-config` starts no MCP server;
 * `--disable-slash-commands` leaves out skills; and `--no-session-persistence` saves no
 * session. The prompt goes on stdin, and `askClaudeAdvisor` runs it in an empty folder.
 * `--bare` would also do, but it ignores the person's sign-in. Checked on 2026-11-15 against
 * Claude Code 2.1.325: asked to read a file by its full path, it answered that it has no
 * tools; asked for its instructions, it quoted the global CLAUDE.md without `--safe-mode` and
 * had none with it.
 */
export function claudeAdvisorCommand(
  prompt: string,
  choice: { readonly model: string; readonly effort?: Effort },
): MemberCommand {
  return {
    command: "claude",
    args: [
      "-p",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--model",
      choice.model,
      ...(choice.effort ? ["--effort", choice.effort] : []),
    ],
    stdin: prompt,
  };
}

const NO_FAST: Record<SwarmMember["agent"], string | undefined> = {
  claude:
    "Claude Code has no fast-mode flag in print mode (its fastMode setting through --settings is not confirmed to work there), so the account's own setting applies",
  codex: undefined,
  opencode: "OpenCode run has no fast-mode flag, so the model runs at its normal speed",
  gemini: "Gemini CLI has no fast-mode flag, so the model runs at its normal speed",
};

/** What the member asked for that its CLI can't take; the run reports each one. */
export function unsupportedOptions(
  member: SwarmMember,
): Array<{ option: SwarmMemberOption; detail: string }> {
  const problems: Array<{ option: SwarmMemberOption; detail: string }> = [];
  if (member.effort && member.agent === "gemini") {
    problems.push({
      option: "effort",
      detail: `Gemini CLI has no effort flag, so "${member.effort}" was not sent and the model's default applies`,
    });
  }
  const noFast = NO_FAST[member.agent];
  if (member.fast && noFast) problems.push({ option: "fast", detail: noFast });
  return problems;
}
