import { join } from "node:path";
import type { CollaborationMode } from "@zcode/contracts";
import type { CliAgentId } from "@zcode/shared/cli-agents";

/**
 * How far a CLI may go. `ask` stops at each change it wants to make and waits for the answer.
 * `autonomous` edits and runs commands without asking anyone, confined to the working folder and
 * the repository's git directory, so a run in a linked worktree can test and commit.
 */
export type CliAgentAccess = "read-only" | "ask" | "workspace" | "autonomous" | "full";

/** Where a checkout keeps its git data; a linked worktree's is outside its folder. */
export interface CliAgentGitDirs {
  /** This checkout's own (`git rev-parse --git-dir`): its index and HEAD. */
  readonly gitDir: string;
  /** The repository's shared one (`--git-common-dir`): objects, branches, hooks and config. */
  readonly commonDir: string;
}

/** How hard the model thinks: Claude Code's `--effort` levels, which Codex's catalog shares. */
export const CLI_AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type CliAgentEffort = (typeof CLI_AGENT_EFFORTS)[number];

/** Codex's fast mode is its priority service tier. */
export const CODEX_FAST_SERVICE_TIER = "priority";

export interface CliAgentModelChoice {
  /** The CLI's own model name, without the options. */
  readonly model: string;
  readonly effort?: CliAgentEffort;
  readonly fast?: boolean;
}

const isEffort = (option: string): option is CliAgentEffort =>
  (CLI_AGENT_EFFORTS as readonly string[]).includes(option);

/**
 * A CLI model id with options after it, in the swarm's syntax: `opus+high`,
 * `gpt-6.1-sol+max+fast`. The provider's model selection has nowhere else to carry effort or
 * fast mode. An option this doesn't know is dropped, so it never reaches the CLI as part of the
 * model name.
 */
export function parseCliAgentModelId(id: string): CliAgentModelChoice {
  const [model = "", ...options] = id.split("+");
  let choice: CliAgentModelChoice = { model: model.trim() };
  for (const raw of options) {
    const option = raw.trim().toLowerCase();
    if (isEffort(option)) choice = { ...choice, effort: option };
    else if (option === "fast") choice = { ...choice, fast: true };
  }
  return choice;
}

export interface CliAgentRun {
  readonly agent: CliAgentId;
  /** The CLI's own model name; its configured default when absent. */
  readonly model?: string;
  /** The model's default when absent. */
  readonly effort?: CliAgentEffort;
  /** Fast mode where the CLI has one (Codex); the CLI's own setting otherwise. */
  readonly fast?: boolean;
  readonly access: CliAgentAccess;
  /** The checkout's git directories, writable in `autonomous`; absent outside a repository. */
  readonly git?: CliAgentGitDirs;
  readonly prompt: string;
  /** The CLI's session to continue. */
  readonly resumeId?: string;
  /** A one-off call (a title, a commit message) that leaves no session behind. */
  readonly ephemeral?: boolean;
}

export interface CliAgentCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Sent on stdin, which keeps the prompt out of the process list. */
  readonly stdin?: string;
}

/** The CLIs that can stop mid-turn and wait for an answer. */
export function cliAgentCanAsk(agent: CliAgentId): boolean {
  return agent === "claude" || agent === "codex";
}

export function cliAgentAccessForMode(
  mode: CollaborationMode | undefined,
  options: { readonly canAsk: boolean },
): CliAgentAccess {
  switch (mode) {
    // Autonomous: nobody is there to ask.
    case "guarded":
      return "autonomous";
    case "auto":
    case "edit":
      return "workspace";
    case "yolo":
      return "full";
    // A CLI that can't ask can't be allowed to change anything.
    case "build":
      return options.canAsk ? "ask" : "read-only";
    default:
      return "read-only";
  }
}

type BasicAccess = Exclude<CliAgentAccess, "ask" | "autonomous">;

/**
 * Gemini CLI and OpenCode can't ask, so they are read-only if given `ask`, and have no sandbox
 * to confine commands to the git directory, so `autonomous` is their `workspace`.
 */
const basicAccess = (access: CliAgentAccess): BasicAccess =>
  access === "ask" ? "read-only" : access === "autonomous" ? "workspace" : access;

/**
 * Claude Code runs Bash in its sandbox and approves sandboxed commands without asking. Writes
 * outside the working folder and the git directory fail, a command can't leave the sandbox, and
 * the sandbox keeps `.git/hooks` and `.git/config` read-only. Anything that would still ask
 * (an edit outside the folder) is refused, and a sandbox that can't start stops the run instead
 * of running commands unconfined.
 *
 * `--settings` outranks the person's own settings, so the switches that would loosen the
 * confinement are set here too: `filesystem.disabled` in user settings turns off every write
 * rule, the mandatory `.git` protections included, and `allowAppleEvents` lets a command start
 * other apps outside the sandbox.
 */
function claudeAutonomousSettings(git: CliAgentGitDirs | undefined): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      allowAppleEvents: false,
      filesystem: {
        disabled: false,
        // A linked worktree's own git directory is inside the common one.
        ...(git ? { allowWrite: [git.commonDir] } : {}),
      },
    },
  });
}

/**
 * What Codex's workspace-write sandbox must also let a commit write. Codex keeps `<root>/.git`
 * of every writable root read-only, and the git directory a `.git` file points to, unless a
 * writable root of its own sits inside it. Of the common directory only objects, branches and
 * their logs are opened, which leaves hooks and config read-only: a hook a command wrote would
 * later run outside the sandbox.
 *
 * A plain checkout keeps its index and its lock at the top of `.git`, beside hooks and config,
 * so a commit there needs all of `.git` writable. Nothing is opened instead: Codex edits and
 * runs commands in a plain checkout, and can't commit.
 */
export function codexWritableGitRoots(git: CliAgentGitDirs): string[] {
  if (git.gitDir === git.commonDir) return [];
  return [git.gitDir, ...["objects", "refs", "logs"].map((dir) => join(git.commonDir, dir))];
}

function codexAutonomousAccess(git: CliAgentGitDirs | undefined): readonly string[] {
  const roots = git ? codexWritableGitRoots(git) : [];
  return [
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    'approval_policy="never"',
    // A JSON array of strings is also a TOML one.
    ...(roots.length > 0
      ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`]
      : []),
  ];
}

const CLAUDE_ACCESS: Record<Exclude<CliAgentAccess, "autonomous">, readonly string[]> = {
  "read-only": ["--permission-mode", "plan"],
  // Without the prompt tool Claude Code refuses instead of asking, even though prompts go to the
  // host by default.
  ask: ["--permission-mode", "default", "--permission-prompt-tool", "stdio"],
  workspace: ["--permission-mode", "acceptEdits"],
  full: ["--dangerously-skip-permissions"],
};

const CODEX_ACCESS: Record<BasicAccess, readonly string[]> = {
  // `codex exec resume` has no --sandbox flag, so the config key serves both forms.
  "read-only": ["-c", 'sandbox_mode="read-only"'],
  workspace: ["-c", 'sandbox_mode="workspace-write"'],
  full: ["--dangerously-bypass-approvals-and-sandbox"],
};

const GEMINI_APPROVAL: Record<BasicAccess, string> = {
  "read-only": "plan",
  workspace: "auto_edit",
  full: "yolo",
};

const OPENCODE_ACCESS: Record<BasicAccess, readonly string[]> = {
  "read-only": ["--agent", "plan"],
  workspace: [],
  full: ["--auto"],
};

/**
 * Each CLI's headless mode, with one JSON event per line on stdout. Effort goes to Claude Code's
 * `--effort`, Codex's `model_reasoning_effort` and OpenCode's `--variant`; Gemini CLI has no
 * flag for it. Only Codex has a fast mode to ask for.
 */
export function buildCliAgentCommand(run: CliAgentRun): CliAgentCommand {
  const model = run.model ? ["--model", run.model] : [];
  const effort = run.effort;
  switch (run.agent) {
    case "claude":
      return {
        command: "claude",
        args: [
          "-p",
          ...(run.access === "ask" ? ["--input-format", "stream-json"] : []),
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          ...model,
          ...(effort ? ["--effort", effort] : []),
          ...(run.access === "autonomous"
            ? [
                "--permission-mode",
                "acceptEdits",
                "--permission-prompts",
                "none",
                "--settings",
                claudeAutonomousSettings(run.git),
              ]
            : CLAUDE_ACCESS[run.access]),
          ...(run.resumeId ? ["--resume", run.resumeId] : []),
          ...(run.ephemeral ? ["--no-session-persistence"] : []),
        ],
        // In `ask` the dialogue sends the prompt and keeps stdin open for the answers.
        ...(run.access === "ask" ? {} : { stdin: run.prompt }),
      };
    case "codex":
      // The dialogue sends the prompt, model, effort, fast mode and session over JSON-RPC.
      if (run.access === "ask") return { command: "codex", args: ["app-server"] };
      return {
        command: "codex",
        args: [
          "exec",
          ...(run.resumeId ? ["resume", run.resumeId] : []),
          "--json",
          "--skip-git-repo-check",
          ...model,
          ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
          ...(run.fast ? ["-c", `service_tier="${CODEX_FAST_SERVICE_TIER}"`] : []),
          ...(run.access === "autonomous"
            ? codexAutonomousAccess(run.git)
            : CODEX_ACCESS[run.access]),
          ...(run.ephemeral ? ["--ephemeral"] : []),
          "-",
        ],
        stdin: run.prompt,
      };
    case "gemini":
      // --resume only takes "latest" or a list index, so Gemini gets the transcript instead.
      return {
        command: "gemini",
        args: [
          "--prompt",
          run.prompt,
          "--output-format",
          "stream-json",
          "--approval-mode",
          GEMINI_APPROVAL[basicAccess(run.access)],
          ...model,
        ],
      };
    case "opencode":
      return {
        command: "opencode",
        args: [
          "run",
          "--format",
          "json",
          ...model,
          ...(effort ? ["--variant", effort] : []),
          ...OPENCODE_ACCESS[basicAccess(run.access)],
          ...(run.resumeId ? ["--session", run.resumeId] : []),
          "--",
          run.prompt,
        ],
      };
  }
}
