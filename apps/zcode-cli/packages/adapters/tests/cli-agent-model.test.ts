import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runWithModelInvocationContext,
  type Model,
  type ModelApiOperation,
  type ModelEvent,
  type ModelInputMessage,
  type ModelInvocationContext,
} from "@zcode/contracts";
import { createCliAgentModel, type CliAgentModelOptions } from "../src/model/cli-agent/model.js";
import { buildCliAgentPrompt } from "../src/model/cli-agent/model.js";
import {
  buildCliAgentCommand,
  cliAgentAccessForMode,
  codexWritableGitRoots,
  parseCliAgentModelId,
  type CliAgentCommand,
  type CliAgentRun,
} from "../src/model/cli-agent/commands.js";
import {
  CLAUDE_STAGING_EXCLUDE,
  excludeFromGit,
  readCliAgentGitDirs,
} from "../src/model/cli-agent/git.js";
import { decodeCliAgentLine, describeToolUse } from "../src/model/cli-agent/events.js";
import type { CliAgentSpawn } from "../src/model/cli-agent/process.js";
import { createCliAgentSessionStore } from "../src/model/cli-agent/sessions.js";

const USER: ModelInputMessage = { role: "user", content: "Say pong" };
const CONVERSATION = { sessionId: "ses_1", workingDirectory: tmpdir(), mode: "guarded" } as const;
const TURN: ModelInvocationContext = {
  agentConversation: CONVERSATION,
  modelCall: { operation: "agent_step" },
};

/** A CLI stand-in: a real process that prints these lines and exits with this code. */
function fakeCli(lines: readonly unknown[], options: { exitCode?: number; stderr?: string } = {}) {
  const calls: CliAgentCommand[] = [];
  const script = `
    for (const line of ${JSON.stringify(lines.map((line) => JSON.stringify(line)))}) console.log(line);
    ${options.stderr ? `console.error(${JSON.stringify(options.stderr)});` : ""}
    process.exitCode = ${options.exitCode ?? 0};
  `;
  const spawnCli: CliAgentSpawn = (command, spawnOptions) => {
    calls.push(command);
    return spawn(process.execPath, ["-e", script], { ...spawnOptions, stdio: "pipe" });
  };
  return { calls, spawnCli };
}

async function newModel(
  spawnCli: CliAgentSpawn,
  overrides: Partial<CliAgentModelOptions> = {},
): Promise<Model> {
  const dir = await mkdtemp(join(tmpdir(), "cli-agent-"));
  return createCliAgentModel({
    agent: "codex",
    providerId: "cli-codex",
    modelId: "default",
    properties: {} as CliAgentModelOptions["properties"],
    optionSpecs: {} as CliAgentModelOptions["optionSpecs"],
    sessions: createCliAgentSessionStore(join(dir, "sessions.json")),
    spawn: spawnCli,
    env: process.env,
    ...overrides,
  });
}

async function collect(
  model: Model,
  context: ModelInvocationContext = TURN,
  messages: ModelInputMessage[] = [USER],
  abortSignal?: AbortSignal,
) {
  const events: ModelEvent[] = [];
  await runWithModelInvocationContext(context, async () => {
    for await (const event of model.streamText({
      messages,
      ...(abortSignal ? { abortSignal } : {}),
    })) {
      events.push(event);
    }
  });
  return events;
}

const CODEX_TURN = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Thinking it over" } },
  {
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc ls", status: "in_progress" },
  },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "pong" } },
  {
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 },
  },
];

describe("CLI agent commands", () => {
  it("maps the conversation's mode to how far the CLI may go", () => {
    const canAsk = { canAsk: false };
    expect(cliAgentAccessForMode("plan", canAsk)).toBe("read-only");
    // "Ask before changes": a CLI that can't ask must not change anything.
    expect(cliAgentAccessForMode("build", canAsk)).toBe("read-only");
    expect(cliAgentAccessForMode(undefined, canAsk)).toBe("read-only");
    expect(cliAgentAccessForMode("guarded", canAsk)).toBe("autonomous");
    expect(cliAgentAccessForMode("auto", canAsk)).toBe("workspace");
    expect(cliAgentAccessForMode("yolo", canAsk)).toBe("full");
  });

  it("resumes Claude Code and sends the prompt on stdin", () => {
    const command = buildCliAgentCommand({
      agent: "claude",
      model: "opus",
      access: "workspace",
      prompt: "hello",
      resumeId: "abc",
    });
    expect(command.args).toEqual(
      expect.arrayContaining(["--model", "opus", "--permission-mode", "acceptEdits", "--resume", "abc"]),
    );
    expect(command.args).not.toContain("hello");
    expect(command.stdin).toBe("hello");
  });

  it("puts Codex's resume before its options, with the sandbox as config", () => {
    const { args } = buildCliAgentCommand({
      agent: "codex",
      access: "read-only",
      prompt: "hello",
      resumeId: "thread-1",
    });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(args).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="read-only"']));
    expect(args.at(-1)).toBe("-");
  });

  it("keeps a prompt that looks like a flag from reaching OpenCode's parser", () => {
    const { args } = buildCliAgentCommand({ agent: "opencode", access: "full", prompt: "--help" });
    expect(args.slice(-2)).toEqual(["--", "--help"]);
    expect(args).toContain("--auto");
  });

  it("only skips permissions for full access", () => {
    const full = buildCliAgentCommand({ agent: "claude", access: "full", prompt: "x" });
    const workspace = buildCliAgentCommand({ agent: "claude", access: "workspace", prompt: "x" });
    expect(full.args).toContain("--dangerously-skip-permissions");
    expect(workspace.args).not.toContain("--dangerously-skip-permissions");
  });
});

describe("CLI agent effort", () => {
  it("reads effort and fast mode off the model id, in the swarm's syntax", () => {
    expect(parseCliAgentModelId("opus")).toEqual({ model: "opus" });
    expect(parseCliAgentModelId("opus+high")).toEqual({ model: "opus", effort: "high" });
    expect(parseCliAgentModelId("gpt-6.1-sol+max+fast")).toEqual({
      model: "gpt-6.1-sol",
      effort: "max",
      fast: true,
    });
    expect(parseCliAgentModelId("gpt-6.1-sol+fast+XHigh")).toEqual({
      model: "gpt-6.1-sol",
      effort: "xhigh",
      fast: true,
    });
    expect(parseCliAgentModelId("default+low")).toEqual({ model: "default", effort: "low" });
  });

  it("drops an option it doesn't know instead of sending it as part of the model", () => {
    expect(parseCliAgentModelId("opus+ultra")).toEqual({ model: "opus" });
    expect(parseCliAgentModelId("opus+vote+w2+medium")).toEqual({
      model: "opus",
      effort: "medium",
    });
  });

  it("gives Claude Code --effort, and nothing for fast mode", () => {
    const run = { agent: "claude", model: "opus", access: "workspace", prompt: "x" } as const;
    expect(buildCliAgentCommand(run).args).not.toContain("--effort");
    const { args } = buildCliAgentCommand({ ...run, effort: "high", fast: true });
    expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
    expect(args.join(" ")).not.toMatch(/fast|service_tier/u);
  });

  it("gives Codex its effort and fast mode as config, also when resuming", () => {
    const run = { agent: "codex", model: "gpt-6.1-sol", access: "workspace", prompt: "x" } as const;
    expect(buildCliAgentCommand(run).args.join(" ")).not.toMatch(
      /model_reasoning_effort|service_tier/u,
    );
    const fast = buildCliAgentCommand({ ...run, effort: "max", fast: true, resumeId: "thread-1" });
    expect(fast.args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(fast.args).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-6.1-sol",
        "-c",
        'model_reasoning_effort="max"',
        "-c",
        'service_tier="priority"',
      ]),
    );
    expect(fast.args.at(-1)).toBe("-");
    const slow = buildCliAgentCommand({ ...run, effort: "low" });
    expect(slow.args).toContain('model_reasoning_effort="low"');
    expect(slow.args.join(" ")).not.toContain("service_tier");
  });

  it("gives OpenCode --variant before the prompt", () => {
    const run = {
      agent: "opencode",
      model: "anthropic/opus",
      access: "full",
      prompt: "x",
    } as const;
    expect(buildCliAgentCommand(run).args).not.toContain("--variant");
    const { args } = buildCliAgentCommand({ ...run, effort: "high", fast: true });
    expect(args).toEqual(expect.arrayContaining(["--variant", "high"]));
    expect(args.indexOf("--variant")).toBeLessThan(args.indexOf("--"));
  });

  it("leaves effort out for Gemini CLI, which has no flag for it", () => {
    const run = { agent: "gemini", model: "gemini-2.5-pro", access: "full", prompt: "x" } as const;
    const plain = buildCliAgentCommand(run);
    expect(buildCliAgentCommand({ ...run, effort: "max", fast: true })).toEqual(plain);
  });

  it("runs a conversation at the effort its model id asks for, with the bare model", async () => {
    const { calls, spawnCli } = fakeCli([{ type: "result", result: "pong", usage: {} }]);
    await collect(await newModel(spawnCli, { agent: "claude", modelId: "opus+high" }));
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
    expect(calls[0]!.args).not.toContain("opus+high");
  });

  it("keeps the CLI's default model when only the options are given", async () => {
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    await collect(await newModel(spawnCli, { modelId: "default+max+fast" }));
    expect(calls[0]!.args).not.toContain("--model");
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(['model_reasoning_effort="max"', 'service_tier="priority"']),
    );
  });

  it("runs on an unknown level without any effort flag", async () => {
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    const events = await collect(await newModel(spawnCli, { modelId: "gpt-6.1-sol+ultra" }));
    expect(events.at(-1)).toMatchObject({ type: "finish" });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--model", "gpt-6.1-sol"]));
    expect(calls[0]!.args.join(" ")).not.toMatch(/ultra|model_reasoning_effort/u);
  });
});

/** A repository with one commit and a linked worktree beside it, as an executor gets. */
async function linkedWorktree() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cli-agent-git-")));
  const repo = join(dir, "repo");
  await mkdir(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(repo, "init", "-q");
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  git(repo, ...identity, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "executor", join(dir, "worktree"));
  return { repo, worktree: join(dir, "worktree"), commonDir: join(repo, ".git") };
}

const LINKED = { gitDir: "/repo/.git/worktrees/wt", commonDir: "/repo/.git" };
const AUTONOMOUS: CliAgentRun = { agent: "claude", access: "autonomous", prompt: "x", git: LINKED };

const claudeSettings = (args: readonly string[]) =>
  JSON.parse(args[args.indexOf("--settings") + 1]!) as { sandbox: Record<string, unknown> };

describe("CLI agent autonomous access", () => {
  it("runs Claude Code's commands in its sandbox, with the git directory writable", () => {
    const { args } = buildCliAgentCommand(AUTONOMOUS);
    expect(args.join(" ")).toContain("--permission-mode acceptEdits --permission-prompts none");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(claudeSettings(args).sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      allowAppleEvents: false,
      filesystem: { disabled: false, allowWrite: ["/repo/.git"] },
    });
  });

  it("keeps Claude Code to its folder outside a repository, with confinement forced on", () => {
    const { git: _git, ...run } = AUTONOMOUS;
    const { sandbox } = claudeSettings(buildCliAgentCommand(run).args);
    // The person's own `sandbox.filesystem.disabled: true` would otherwise turn it off.
    expect(sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true });
    expect(sandbox.filesystem).toEqual({ disabled: false });
  });

  it("opens Codex's sandbox to the worktree's git directory and what a commit writes", () => {
    const { args } = buildCliAgentCommand({ ...AUTONOMOUS, agent: "codex", resumeId: "thread-1" });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(args).toEqual(
      expect.arrayContaining([
        'sandbox_mode="workspace-write"',
        'approval_policy="never"',
        'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/wt","/repo/.git/objects","/repo/.git/refs","/repo/.git/logs"]',
      ]),
    );
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.at(-1)).toBe("-");
  });

  it("leaves a repository's hooks and config out of Codex's writable roots", () => {
    for (const root of codexWritableGitRoots(LINKED)) {
      expect(root).not.toMatch(/\/(hooks|config)$/u);
      expect(root).not.toBe(LINKED.commonDir);
    }
  });

  it("opens nothing of a plain checkout's .git to Codex, so it can't commit there", () => {
    const plain = { gitDir: "/repo/.git", commonDir: "/repo/.git" };
    // Its index lock sits at the top of `.git`, beside hooks and config.
    expect(codexWritableGitRoots(plain)).toEqual([]);
    const { args } = buildCliAgentCommand({ ...AUTONOMOUS, agent: "codex", git: plain });
    expect(args).toEqual(expect.arrayContaining(['sandbox_mode="workspace-write"']));
    expect(args.join(" ")).not.toContain("writable_roots");
  });

  it("gives Codex no extra roots outside a repository", () => {
    const { git: _git, ...run } = AUTONOMOUS;
    const { args } = buildCliAgentCommand({ ...run, agent: "codex" });
    expect(args).toEqual(expect.arrayContaining(['sandbox_mode="workspace-write"']));
    expect(args.join(" ")).not.toContain("writable_roots");
  });

  it("gives Gemini CLI and OpenCode their workspace access, which they can't confine further", () => {
    for (const agent of ["gemini", "opencode"] as const) {
      const workspace = buildCliAgentCommand({ agent, access: "workspace", prompt: "x" });
      expect(buildCliAgentCommand({ ...AUTONOMOUS, agent })).toEqual(workspace);
    }
  });

  it("leaves the other modes as they were", () => {
    const args = (agent: CliAgentRun["agent"], access: CliAgentRun["access"]) =>
      buildCliAgentCommand({ agent, access, prompt: "x", git: LINKED }).args.join(" ");
    expect(args("claude", "read-only")).toContain("--permission-mode plan");
    expect(args("claude", "workspace")).toContain("--permission-mode acceptEdits");
    expect(args("claude", "full")).toContain("--dangerously-skip-permissions");
    expect(args("claude", "ask")).toContain("--permission-prompt-tool stdio");
    for (const access of ["read-only", "ask", "workspace", "full"] as const) {
      expect(args("claude", access)).not.toMatch(/--settings|--permission-prompts/u);
      expect(args("codex", access)).not.toMatch(/writable_roots|approval_policy/u);
    }
    expect(args("codex", "workspace")).toContain('sandbox_mode="workspace-write"');
    expect(cliAgentAccessForMode("edit", { canAsk: true })).toBe("workspace");
    expect(cliAgentAccessForMode("build", { canAsk: true })).toBe("ask");
    expect(cliAgentAccessForMode("plan", { canAsk: true })).toBe("read-only");
    expect(cliAgentAccessForMode("yolo", { canAsk: true })).toBe("full");
  });

  it("finds a linked worktree's own git directory and the repository's", async () => {
    const { worktree, commonDir } = await linkedWorktree();
    expect(await readCliAgentGitDirs(worktree)).toEqual({
      gitDir: join(commonDir, "worktrees", "worktree"),
      commonDir,
    });
    expect(await readCliAgentGitDirs(await mkdtemp(join(tmpdir(), "cli-agent-no-git-")))).toBe(
      undefined,
    );
  });

  it("passes the conversation's git directories to an autonomous turn only", async () => {
    const { worktree, commonDir } = await linkedWorktree();
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    const model = await newModel(spawnCli);
    const inWorktree = (mode: "guarded" | "edit") => ({
      ...TURN,
      agentConversation: { ...CONVERSATION, workingDirectory: worktree, mode },
    });
    await collect(model, inWorktree("guarded"));
    const roots = [
      join(commonDir, "worktrees", "worktree"),
      ...["objects", "refs", "logs"].map((dir) => join(commonDir, dir)),
    ];
    expect(calls[0]!.args).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
    await collect(model, inWorktree("edit"));
    expect(calls[1]!.args.join(" ")).not.toContain("writable_roots");
  });

  it("opens no git directory to an autonomous Codex turn in a plain checkout", async () => {
    const { repo } = await linkedWorktree();
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    await collect(await newModel(spawnCli), {
      ...TURN,
      agentConversation: { ...CONVERSATION, workingDirectory: repo, mode: "guarded" },
    });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['sandbox_mode="workspace-write"']));
    expect(calls[0]!.args.join(" ")).not.toContain("writable_roots");
  });
});

describe("Claude Code's staging folder", () => {
  // The person's own global ignore file may have the rule already, so it is left out.
  const ignored = (cwd: string, path: string) => {
    try {
      execFileSync("git", ["-c", "core.excludesFile=", "check-ignore", "-q", path], {
        cwd,
        stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      return true;
    } catch {
      return false;
    }
  };

  it("is excluded once in the repository's exclude file, keeping what was there", async () => {
    const { worktree, commonDir } = await linkedWorktree();
    const file = join(commonDir, "info", "exclude");
    await writeFile(file, "# kept\nbuild/");
    expect(ignored(worktree, ".claude/.cc-writes/left-over")).toBe(false);
    await excludeFromGit(commonDir, CLAUDE_STAGING_EXCLUDE);
    const once = await readFile(file, "utf8");
    expect(once).toBe(`# kept\nbuild/\n${CLAUDE_STAGING_EXCLUDE}\n`);
    await excludeFromGit(commonDir, CLAUDE_STAGING_EXCLUDE);
    expect(await readFile(file, "utf8")).toBe(once);
    // The common directory's exclude file covers every worktree, at any depth in it.
    expect(ignored(worktree, ".claude/.cc-writes/left-over")).toBe(true);
    expect(ignored(worktree, "sub/.claude/.cc-writes/left-over")).toBe(true);
    expect(ignored(worktree, ".claude/settings.json")).toBe(false);
  });

  it("makes the exclude file when the repository has none, and never fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-agent-exclude-"));
    await excludeFromGit(dir, CLAUDE_STAGING_EXCLUDE);
    expect(await readFile(join(dir, "info", "exclude"), "utf8")).toBe(`${CLAUDE_STAGING_EXCLUDE}\n`);
    // `info` is a file here, so nothing can be written: the call still returns.
    const blocked = await mkdtemp(join(tmpdir(), "cli-agent-exclude-"));
    await writeFile(join(blocked, "info"), "");
    await expect(excludeFromGit(blocked, CLAUDE_STAGING_EXCLUDE)).resolves.toBeUndefined();
  });

  it("is excluded before an autonomous Claude Code turn, and by no other run", async () => {
    const { worktree, commonDir } = await linkedWorktree();
    const file = join(commonDir, "info", "exclude");
    const before = await readFile(file, "utf8");
    const reply = [{ type: "result", result: "pong", usage: {} }];
    const inWorktree = (mode: "guarded" | "edit") => ({
      ...TURN,
      agentConversation: { ...CONVERSATION, workingDirectory: worktree, mode },
    });
    await collect(await newModel(fakeCli(CODEX_TURN).spawnCli), inWorktree("guarded"));
    await collect(await newModel(fakeCli(reply).spawnCli, { agent: "claude" }), inWorktree("edit"));
    expect(await readFile(file, "utf8")).toBe(before);
    const claude = await newModel(fakeCli(reply).spawnCli, { agent: "claude" });
    await collect(claude, inWorktree("guarded"));
    await collect(claude, inWorktree("guarded"));
    expect(await readFile(file, "utf8")).toBe(`${before}${CLAUDE_STAGING_EXCLUDE}\n`);
  });
});

describe("CLI agent events", () => {
  it("reads Claude Code's streamed text, thinking and tool use", () => {
    expect(
      decodeCliAgentLine("claude", {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "po" } },
      }),
    ).toEqual([{ type: "text", text: "po" }]);
    expect(
      decodeCliAgentLine("claude", {
        type: "stream_event",
        event: { delta: { type: "thinking_delta", thinking: "hm" } },
      }),
    ).toEqual([{ type: "thinking", text: "hm" }]);
    expect(
      decodeCliAgentLine("claude", {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "already streamed" },
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      }),
    ).toEqual([{ type: "activity", text: "Bash: ls -la" }]);
  });

  it("turns a signed-out Claude Code into an error", () => {
    const events = decodeCliAgentLine("claude", {
      type: "result",
      is_error: true,
      result: "Not logged in · Please run /login",
      usage: {},
    });
    expect(events).toContainEqual({ type: "error", message: "Not logged in · Please run /login" });
  });

  it("reads OpenCode's parts and session id", () => {
    const events = decodeCliAgentLine("opencode", {
      type: "text",
      sessionID: "ses_9",
      part: { text: "pong" },
    });
    expect(events).toEqual([
      { type: "session", id: "ses_9" },
      { type: "message", text: "pong" },
    ]);
    expect(
      decodeCliAgentLine("opencode", {
        type: "error",
        error: { data: { message: "Unexpected server error" } },
      }),
    ).toEqual([{ type: "error", message: "Unexpected server error" }]);
  });

  it("reads Gemini CLI's assistant text and ignores the echoed prompt", () => {
    expect(
      decodeCliAgentLine("gemini", { type: "message", role: "assistant", content: "pong" }),
    ).toEqual([{ type: "text", text: "pong" }]);
    expect(decodeCliAgentLine("gemini", { type: "message", role: "user", content: "hi" })).toEqual(
      [],
    );
  });

  it("describes a tool call in one short line", () => {
    expect(describeToolUse("Read", { file_path: "src/a.ts" })).toBe("Read: src/a.ts");
    expect(describeToolUse("Odd", { nothing: 1 })).toBe("Odd");
    expect(describeToolUse("Bash", { command: "x".repeat(400) }).length).toBeLessThan(180);
  });
});

describe("CLI agent prompts", () => {
  const history: ModelInputMessage[] = [
    { role: "system", content: "You are ZCode" },
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Second question" },
  ];

  it("sends only the new message to a session that has the rest", () => {
    expect(buildCliAgentPrompt(history, { resuming: true })).toBe("Second question");
  });

  it("passes the transcript to a CLI seeing the conversation for the first time", () => {
    const prompt = buildCliAgentPrompt(history, { resuming: false });
    expect(prompt).toContain("user: First question");
    expect(prompt).toContain("assistant: First answer");
    expect(prompt).toContain("Second question");
    expect(prompt).not.toContain("You are ZCode");
  });

  it("leads with the system content when asked, and keeps it apart from the message", () => {
    const prompt = buildCliAgentPrompt(
      [
        { role: "system", content: "Write a title" },
        { role: "user", content: "Fix the login bug" },
      ],
      { resuming: false, includeSystem: true },
    );
    expect(prompt).toBe("Write a title\n\nThe new message:\n\nFix the login bug");
  });

  it("keeps the system content ahead of a transcript", () => {
    const prompt = buildCliAgentPrompt(history, { resuming: false, includeSystem: true });
    expect(prompt.indexOf("You are ZCode")).toBe(0);
    expect(prompt.indexOf("Earlier in this conversation:")).toBeGreaterThan(0);
    expect(prompt.endsWith("The new message:\n\nSecond question")).toBe(true);
  });

  it("joins every system message and skips the empty ones", () => {
    const prompt = buildCliAgentPrompt(
      [
        { role: "system", content: "First rule" },
        { role: "system", content: "   " },
        { role: "system", content: [{ type: "text", text: "Second rule" }] },
        { role: "user", content: "Go" },
      ],
      { resuming: false, includeSystem: true },
    );
    expect(prompt).toBe("First rule\n\nSecond rule\n\nThe new message:\n\nGo");
  });

  it("sends the message alone when there's no system content, as for commit messages", () => {
    const prompt = buildCliAgentPrompt([{ role: "user", content: "Write one commit message" }], {
      resuming: false,
      includeSystem: true,
    });
    expect(prompt).toBe("Write one commit message");
  });
});

describe("CLI agent model", () => {
  it("streams a CLI's turn as thinking, then the reply, then usage", async () => {
    const { spawnCli } = fakeCli(CODEX_TURN);
    const events = await collect(await newModel(spawnCli));
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "reasoning_start",
      "reasoning_delta",
      "reasoning_delta",
      "reasoning_end",
      "text_start",
      "text_delta",
      "text_end",
      "finish",
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "pong" }));
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 },
    });
  });

  it("keeps whole messages apart", async () => {
    const { spawnCli } = fakeCli([
      { type: "item.completed", item: { type: "agent_message", text: "I'll try." } },
      { type: "item.completed", item: { type: "agent_message", text: "That failed." } },
      { type: "turn.completed", usage: {} },
    ]);
    const events = await collect(await newModel(spawnCli));
    const text = events.flatMap((event) => (event.type === "text_delta" ? [event.text] : []));
    expect(text.join("")).toBe("I'll try.\n\nThat failed.");
  });

  it("resumes the CLI's session on the next turn, and keeps it after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-agent-"));
    const file = join(dir, "sessions.json");
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    const model = await newModel(spawnCli, { sessions: createCliAgentSessionStore(file) });

    await collect(model);
    expect(calls[0]!.args).not.toContain("resume");

    await collect(model);
    expect(calls[1]!.args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);

    const restarted = await newModel(spawnCli, { sessions: createCliAgentSessionStore(file) });
    await collect(restarted);
    expect(calls[2]!.args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "ses_1:codex": "thread-1" });
  });

  it("keeps sessions apart per conversation and per CLI", async () => {
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    const model = await newModel(spawnCli);
    await collect(model);
    await collect(model, {
      ...TURN,
      agentConversation: { ...CONVERSATION, sessionId: "ses_2" },
    });
    expect(calls[1]!.args).not.toContain("resume");
  });

  it("runs side calls read-only and outside the conversation's session", async () => {
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    const model = await newModel(spawnCli);
    await collect(model);
    await collect(model, {
      agentConversation: CONVERSATION,
      modelCall: { operation: "workspace_generate_text" },
    });
    expect(calls[1]!.args).not.toContain("resume");
    expect(calls[1]!.args).toEqual(
      expect.arrayContaining(["--ephemeral", "-c", 'sandbox_mode="read-only"']),
    );
  });

  describe("system content", () => {
    const INSTRUCTIONS: ModelInputMessage = { role: "system", content: "Reply with a title" };
    const sideCall = (operation: ModelApiOperation): ModelInvocationContext => ({
      agentConversation: CONVERSATION,
      modelCall: { operation },
    });
    const claudeTurn = [{ type: "result", is_error: false, result: "pong", usage: {} }];

    it.each(["claude", "codex"] as const)("reaches %s on a title call", async (agent) => {
      const { calls, spawnCli } = fakeCli(agent === "claude" ? claudeTurn : CODEX_TURN);
      await collect(await newModel(spawnCli, { agent }), sideCall("session_title_generation"), [
        INSTRUCTIONS,
        USER,
      ]);
      expect(calls[0]!.stdin).toBe("Reply with a title\n\nThe new message:\n\nSay pong");
    });

    it("runs a title call on the bare model, without the conversation's effort or fast mode", async () => {
      const { calls, spawnCli } = fakeCli(CODEX_TURN);
      await collect(await newModel(spawnCli, { modelId: "gpt-6.1-sol+max+fast" }), sideCall("session_title_generation"), [INSTRUCTIONS, USER]);
      expect(calls[0]!.args).toEqual(expect.arrayContaining(["--model", "gpt-6.1-sol"]));
      expect(calls[0]!.args.join(" ")).not.toMatch(/model_reasoning_effort|service_tier/u);
    });

    it.each(["gemini", "opencode"] as const)("reaches %s on a title call", async (agent) => {
      const { calls, spawnCli } = fakeCli([]);
      const model = await newModel(spawnCli, { agent });
      await expect(
        collect(model, sideCall("goal_title_generation"), [INSTRUCTIONS, USER]),
      ).rejects.toThrow("The CLI finished without a reply.");
      expect(calls[0]!.args).toContain("Reply with a title\n\nThe new message:\n\nSay pong");
    });

    it.each([
      "project_memory_recall",
      "workspace_generate_text",
      "workspace_git_commit_message",
    ] as const)("reaches the CLI on %s", async (operation) => {
      const { calls, spawnCli } = fakeCli(CODEX_TURN);
      await collect(await newModel(spawnCli), sideCall(operation), [INSTRUCTIONS, USER]);
      expect(calls[0]!.stdin).toContain("Reply with a title");
    });

    it("stays out of a turn: the CLI uses its own system prompt", async () => {
      const { calls, spawnCli } = fakeCli(CODEX_TURN);
      await collect(await newModel(spawnCli), TURN, [INSTRUCTIONS, USER]);
      expect(calls[0]!.stdin).toBe("Say pong");
    });

    it.each([
      "context_compaction",
      "goal_completion_verification",
      "project_memory_dream",
      "project_memory_extract",
    ] as const)("stays out of %s, where it's the runtime's own prompt", async (operation) => {
      const { calls, spawnCli } = fakeCli(CODEX_TURN);
      const replay: ModelInputMessage[] = [
        { role: "system", content: "You are ZCode" },
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Summarize the conversation" },
      ];
      await collect(await newModel(spawnCli), sideCall(operation), replay);
      expect(calls[0]!.stdin).not.toContain("You are ZCode");
      expect(calls[0]!.stdin).toContain("First answer");
      expect(calls[0]!.stdin).toContain("Summarize the conversation");
    });
  });

  it("uses the conversation's mode for each turn", async () => {
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    const model = await newModel(spawnCli);
    await collect(model, { ...TURN, agentConversation: { ...CONVERSATION, mode: "plan" } });
    await collect(model, { ...TURN, agentConversation: { ...CONVERSATION, mode: "yolo" } });
    expect(calls[0]!.args).toContain('sandbox_mode="read-only"');
    expect(calls[1]!.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("leaves the model to the CLI unless one was chosen", async () => {
    const { calls, spawnCli } = fakeCli(CODEX_TURN);
    await collect(await newModel(spawnCli));
    await collect(await newModel(spawnCli, { modelId: "gpt-6-astra" }));
    expect(calls[0]!.args).not.toContain("--model");
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["--model", "gpt-6-astra"]));
  });

  it("surfaces what the CLI reported instead of a blank reply", async () => {
    const { spawnCli } = fakeCli([{ type: "turn.failed", error: { message: "Usage limit reached" } }]);
    await expect(collect(await newModel(spawnCli))).rejects.toThrow("Usage limit reached");
  });

  it("surfaces a failed exit with what the CLI printed", async () => {
    const { spawnCli } = fakeCli([], { exitCode: 3, stderr: "unexpected argument" });
    await expect(collect(await newModel(spawnCli))).rejects.toThrow(
      "codex exited with 3: unexpected argument",
    );
  });

  it("uses Claude Code's final result when the text didn't stream", async () => {
    const { spawnCli } = fakeCli([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", is_error: false, result: "pong", usage: {} },
    ]);
    const events = await collect(await newModel(spawnCli, { agent: "claude" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "pong" }));
  });

  it("doesn't repeat a reply that already streamed", async () => {
    const { spawnCli } = fakeCli([
      { type: "stream_event", event: { delta: { type: "text_delta", text: "pong" } } },
      { type: "result", is_error: false, result: "pong", usage: {} },
    ]);
    const events = await collect(await newModel(spawnCli, { agent: "claude" }));
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
  });

  it("stops the CLI when the turn is stopped", async () => {
    let stopped: Promise<number | null> | undefined;
    const spawnCli: CliAgentSpawn = (_command, options) => {
      const child = spawn(
        process.execPath,
        ["-e", 'console.log(JSON.stringify({type:"turn.started"})); setInterval(() => {}, 1000)'],
        { ...options, stdio: "pipe" },
      );
      stopped = new Promise((resolve) => child.once("close", resolve));
      return child;
    };
    const controller = new AbortController();
    const running = collect(await newModel(spawnCli), TURN, [USER], controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(running).rejects.toThrow();
    await expect(stopped).resolves.toBeNull();
  });

  it("stops the commands the CLI started along with it", async () => {
    let grandchild = 0;
    const spawnCli: CliAgentSpawn = (_command, options) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
           const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
           console.log(JSON.stringify({ type: "turn.started", sleeper: sleeper.pid }));
           setInterval(() => {}, 1000);`,
        ],
        { ...options, stdio: "pipe" },
      );
      child.stdout.once("data", (chunk) => {
        grandchild = (JSON.parse(String(chunk)) as { sleeper: number }).sleeper;
      });
      return child;
    };
    const controller = new AbortController();
    const running = collect(await newModel(spawnCli), TURN, [USER], controller.signal);
    await vi.waitFor(() => expect(grandchild).toBeGreaterThan(0));
    controller.abort();
    await expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow(), { timeout: 3000 });
  });

  it("collects the reply for callers that don't stream", async () => {
    const { spawnCli } = fakeCli(CODEX_TURN);
    const model = await newModel(spawnCli);
    const result = await runWithModelInvocationContext(TURN, () =>
      model.generateText({ messages: [USER] }),
    );
    expect(result).toMatchObject({ text: "pong", finishReason: "stop" });
  });
});
