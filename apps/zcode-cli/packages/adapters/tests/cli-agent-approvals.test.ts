import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runWithModelInvocationContext,
  type Model,
  type ModelAgentToolApproval,
  type ModelAgentToolApprovalPort,
  type ModelAgentToolApprovalRequest,
  type ModelEvent,
  type ModelInvocationContext,
} from "@zcode/contracts";
import {
  buildCliAgentCommand,
  cliAgentAccessForMode,
  type CliAgentCommand,
} from "../src/model/cli-agent/commands.js";
import { createCliAgentModel, type CliAgentModelOptions } from "../src/model/cli-agent/model.js";
import type { CliAgentSpawn } from "../src/model/cli-agent/process.js";
import { createCliAgentSessionStore } from "../src/model/cli-agent/sessions.js";

const ASK = { sessionId: "ses_1", workingDirectory: tmpdir(), mode: "build" } as const;

/** Runs in the stand-in CLI: reads JSON lines on stdin, skipping a plain prompt, and prints some. */
const CLI_HELPERS = `
  const { createInterface } = require("node:readline");
  const inbox = [];
  const waiters = [];
  let closed = false;
  const settle = () => { for (const check of waiters.splice(0)) check(); };
  createInterface({ input: process.stdin })
    .on("line", (text) => { if (text.startsWith("{")) inbox.push(JSON.parse(text)); settle(); })
    .on("close", () => { closed = true; settle(); });
  const print = (line) => console.log(JSON.stringify(line));
  const take = (matches) => new Promise((resolve) => {
    const check = () => {
      const index = inbox.findIndex(matches);
      if (index >= 0) resolve(inbox.splice(index, 1)[0]);
      else waiters.push(check);
    };
    check();
  });
  const stdinClosed = () => new Promise((resolve) => {
    const check = () => (closed ? resolve() : waiters.push(check));
    check();
  });
`;

/** A CLI stand-in: a real process running this script, which talks over its stdio. */
function talkingCli(script: string) {
  const calls: CliAgentCommand[] = [];
  const spawnCli: CliAgentSpawn = (command, options) => {
    calls.push(command);
    return spawn(process.execPath, ["-e", `${CLI_HELPERS}(async () => {${script}})();`], {
      ...options,
      stdio: "pipe",
    });
  };
  return { calls, spawnCli };
}

async function newModel(
  spawnCli: CliAgentSpawn,
  agent: CliAgentModelOptions["agent"],
  modelId = "default",
): Promise<Model> {
  const dir = await mkdtemp(join(tmpdir(), "cli-agent-approvals-"));
  return createCliAgentModel({
    agent,
    providerId: `cli-${agent}`,
    modelId,
    properties: {} as CliAgentModelOptions["properties"],
    optionSpecs: {} as CliAgentModelOptions["optionSpecs"],
    sessions: createCliAgentSessionStore(join(dir, "sessions.json")),
    spawn: spawnCli,
    env: process.env,
  });
}

function turn(requestToolApproval?: ModelAgentToolApprovalPort): ModelInvocationContext {
  return {
    agentConversation: { ...ASK, ...(requestToolApproval ? { requestToolApproval } : {}) },
    modelCall: { operation: "agent_step" },
  };
}

async function collect(model: Model, context: ModelInvocationContext, abortSignal?: AbortSignal) {
  const events: ModelEvent[] = [];
  await runWithModelInvocationContext(context, async () => {
    for await (const event of model.streamText({
      messages: [{ role: "user", content: "Change the file" }],
      ...(abortSignal ? { abortSignal } : {}),
    })) {
      events.push(event);
    }
  });
  return events;
}

const replyOf = (events: readonly ModelEvent[]): string =>
  events.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("");

/** Records the requests and answers each with `approval`. */
function approving(approval: (request: ModelAgentToolApprovalRequest) => ModelAgentToolApproval) {
  const requests: ModelAgentToolApprovalRequest[] = [];
  const port: ModelAgentToolApprovalPort = (request) => {
    requests.push(request);
    return Promise.resolve(approval(request));
  };
  return { port, requests };
}

/** A port that stays open until its signal fires, then refuses, as the runtime's does. */
function waitingForever() {
  const requests: ModelAgentToolApprovalRequest[] = [];
  const closed = vi.fn();
  const port: ModelAgentToolApprovalPort = (request) => {
    requests.push(request);
    return new Promise((resolve) => {
      request.signal?.addEventListener("abort", () => {
        closed();
        resolve({ allowed: false, reason: "Permission request cancelled" });
      });
    });
  };
  return { closed, port, requests };
}

const WRITE_REQUEST = {
  type: "control_request",
  request_id: "req-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Write",
    display_name: "Write",
    input: { file_path: "/project/note.txt", content: "hello" },
    description: "note.txt",
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    tool_use_id: "toolu_1",
  },
};

/** Claude Code asking once, then reporting the answer it got as its reply. */
const CLAUDE_ASKS = `
  await take((line) => line.type === "user");
  print({ type: "system", subtype: "init", session_id: "claude-1" });
  print(${JSON.stringify(WRITE_REQUEST)});
  const answer = await take((line) => line.type === "control_response");
  print({ type: "result", result: JSON.stringify(answer), usage: {} });
  await stdinClosed();
`;

describe("CLI agent access", () => {
  it("asks in Ask before changes only where the CLI can", () => {
    expect(cliAgentAccessForMode("build", { canAsk: true })).toBe("ask");
    expect(cliAgentAccessForMode("build", { canAsk: false })).toBe("read-only");
    expect(cliAgentAccessForMode("plan", { canAsk: true })).toBe("read-only");
    expect(cliAgentAccessForMode("guarded", { canAsk: true })).toBe("autonomous");
    expect(cliAgentAccessForMode("yolo", { canAsk: true })).toBe("full");
  });

  it("gives Claude Code stream input and the prompt tool, because the host flag alone refuses", () => {
    const { args, stdin } = buildCliAgentCommand({ agent: "claude", access: "ask", prompt: "Hi" });
    expect(args.join(" ")).toContain("--input-format stream-json");
    expect(args.join(" ")).toContain("--permission-mode default");
    expect(args.join(" ")).toContain("--permission-prompt-tool stdio");
    expect(stdin).toBeUndefined();
  });

  it("gives Claude Code its effort when it asks too", () => {
    const { args } = buildCliAgentCommand({
      agent: "claude",
      model: "opus",
      access: "ask",
      prompt: "Hi",
      effort: "high",
    });
    expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
    expect(args.join(" ")).toContain("--permission-prompt-tool stdio");
  });

  it("runs Codex's server to ask, and leaves it out of the other modes", () => {
    expect(buildCliAgentCommand({ agent: "codex", access: "ask", prompt: "Hi" }).args).toEqual([
      "app-server",
    ]);
    expect(
      buildCliAgentCommand({ agent: "codex", access: "workspace", prompt: "Hi" }).args[0],
    ).toBe("exec");
  });

  it("keeps Gemini CLI and OpenCode read-only in Ask before changes", async () => {
    const { port, requests } = approving((request) => ({ allowed: true, input: request.input }));
    for (const agent of ["gemini", "opencode"] as const) {
      const { calls, spawnCli } = talkingCli(`print({ type: "error", message: "stop here" });`);
      await expect(collect(await newModel(spawnCli, agent), turn(port))).rejects.toThrow();
      expect(calls[0]?.args.join(" ")).toMatch(/--approval-mode plan|--agent plan/u);
    }
    expect(requests).toEqual([]);
  });

  it("stays read-only where nobody can answer", async () => {
    const { calls, spawnCli } = talkingCli(`print({ type: "result", result: "pong", usage: {} });`);
    await collect(await newModel(spawnCli, "claude"), turn());
    expect(calls[0]?.args.join(" ")).toContain("--permission-mode plan");
    expect(calls[0]?.args).not.toContain("--input-format");
  });

  it("never asks from a side call", async () => {
    const { port, requests } = approving((request) => ({ allowed: true, input: request.input }));
    const { calls, spawnCli } = talkingCli(
      `print({ type: "result", result: "A title", usage: {} });`,
    );
    const context = { ...turn(port), modelCall: { operation: "title" } } as ModelInvocationContext;
    await collect(await newModel(spawnCli, "claude"), context);
    expect(calls[0]?.args.join(" ")).toContain("--permission-mode plan");
    expect(requests).toEqual([]);
  });
});

describe("Claude Code approvals", () => {
  it("sends the prompt on stdin, asks, and hands back what was approved", async () => {
    const { port, requests } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(CLAUDE_ASKS);
    const events = await collect(await newModel(spawnCli, "claude"), turn(port));

    expect(requests).toEqual([
      expect.objectContaining({
        toolCallId: "toolu_1",
        toolName: "Write",
        input: WRITE_REQUEST.request.input,
      }),
    ]);
    expect(JSON.parse(replyOf(events))).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: WRITE_REQUEST.request.input },
      },
    });
  });

  it("passes on a refusal with its reason", async () => {
    const { port } = approving(() => ({ allowed: false, reason: "Not that file" }));
    const { spawnCli } = talkingCli(CLAUDE_ASKS);
    const events = await collect(await newModel(spawnCli, "claude"), turn(port));
    expect(JSON.parse(replyOf(events)).response.response).toEqual({
      behavior: "deny",
      message: "Not that file",
    });
  });

  it("hands back the person's answers to a question", async () => {
    const answered = { questions: [], answers: { "Which color?": "Blue" } };
    const { port } = approving(() => ({ allowed: true, input: answered }));
    const { spawnCli } = talkingCli(CLAUDE_ASKS);
    const events = await collect(await newModel(spawnCli, "claude"), turn(port));
    expect(JSON.parse(replyOf(events)).response.response.updatedInput).toEqual(answered);
  });

  it("gives the CLI's reason, when it has one, to the approval", async () => {
    const { port, requests } = approving(() => ({ allowed: false, reason: "No" }));
    const { spawnCli } = talkingCli(`
      print({ type: "control_request", request_id: "req-2", request: {
        subtype: "can_use_tool", tool_name: "Read", input: { file_path: "/etc/hosts" },
        decision_reason: "Path is outside allowed working directories",
        tool_use_id: "toolu_2" } });
      await take((line) => line.type === "control_response");
      print({ type: "result", result: "ok", usage: {} });
      await stdinClosed();
    `);
    await collect(await newModel(spawnCli, "claude"), turn(port));
    expect(requests[0]?.reason).toBe("Path is outside allowed working directories");
  });

  it("refuses when the approval fails", async () => {
    const port: ModelAgentToolApprovalPort = () => Promise.reject(new Error("No client attached"));
    const { spawnCli } = talkingCli(CLAUDE_ASKS);
    const events = await collect(await newModel(spawnCli, "claude"), turn(port));
    expect(JSON.parse(replyOf(events)).response.response).toEqual({
      behavior: "deny",
      message: "No client attached",
    });
  });

  it("closes an approval the CLI withdraws, and doesn't answer it", async () => {
    const { closed, port, requests } = waitingForever();
    const { spawnCli } = talkingCli(`
      print(${JSON.stringify(WRITE_REQUEST)});
      await new Promise((resolve) => setTimeout(resolve, 100));
      print({ type: "control_cancel_request", request_id: "req-1" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      print({ type: "result", result: JSON.stringify(inbox.filter((line) => line.type === "control_response")), usage: {} });
      await stdinClosed();
    `);
    const events = await collect(await newModel(spawnCli, "claude"), turn(port));
    expect(requests).toHaveLength(1);
    expect(closed).toHaveBeenCalledOnce();
    expect(JSON.parse(replyOf(events))).toEqual([]);
  });

  it("closes an open approval before a stopped turn ends, and ends the CLI", async () => {
    const { closed, port, requests } = waitingForever();
    let exit: Promise<number | null> | undefined;
    const { spawnCli } = talkingCli(`
      print(${JSON.stringify(WRITE_REQUEST)});
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const running = collect(
      await newModel((command, options) => {
        const child = spawnCli(command, options);
        exit = new Promise((resolve) => child.once("close", resolve));
        return child;
      }, "claude"),
      turn(port),
      controller.signal,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(closed).toHaveBeenCalledOnce();
    await expect(exit).resolves.toBeNull();
  });

  it("closes an open approval when the CLI exits under it", async () => {
    const { closed, port } = waitingForever();
    const { spawnCli } = talkingCli(`
      print({ type: "assistant", message: { content: [{ type: "text", text: "Bye" }] } });
      print(${JSON.stringify(WRITE_REQUEST)});
      process.exit(3);
    `);
    await expect(collect(await newModel(spawnCli, "claude"), turn(port))).rejects.toThrow(
      "exited with 3",
    );
    expect(closed).toHaveBeenCalledOnce();
  });

  it("turns down other control requests", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(`
      print({ type: "control_request", request_id: "req-3", request: { subtype: "hook_callback" } });
      const answer = await take((line) => line.type === "control_response");
      print({ type: "result", result: JSON.stringify(answer.response), usage: {} });
      await stdinClosed();
    `);
    const events = await collect(await newModel(spawnCli, "claude"), turn(port));
    expect(JSON.parse(replyOf(events))).toEqual({
      subtype: "error",
      request_id: "req-3",
      error: "xatlas doesn't handle hook_callback",
    });
  });
});

/** Codex's opening exchange, then the script for the turn. */
const codexTurn = (script: string) => `
  const init = await take((line) => line.method === "initialize");
  print({ id: init.id, result: {} });
  await take((line) => line.method === "initialized");
  const thread = await take((line) => line.method && line.method.startsWith("thread/"));
  print({ id: thread.id, result: { thread: { id: thread.params.threadId ?? "thread-1" } } });
  const started = await take((line) => line.method === "turn/start");
  print({ id: started.id, result: { turn: { id: "turn-1" } } });
  ${script}
  print({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: JSON.stringify({ thread, started, ...globalThis.report }) } } });
  print({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } });
  await stdinClosed();
`;

const COMMAND_APPROVAL = {
  method: "item/commandExecution/requestApproval",
  id: 0,
  params: {
    kind: "command",
    itemId: "exec-1",
    reason: "Allow creating note.txt?",
    command: "/bin/zsh -lc \"printf 'hello' > note.txt\"",
    commandActions: [{ type: "unknown", command: "printf 'hello' > note.txt" }],
    availableDecisions: ["accept", "cancel"],
  },
};

const FILE_CHANGE = {
  type: "fileChange",
  id: "exec-2",
  changes: [
    { path: "/project/new.txt", kind: { type: "add" }, diff: "hello\n" },
    {
      path: "/project/old.txt",
      kind: { type: "update", move_path: null },
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    },
    { path: "/project/gone.txt", kind: { type: "delete" }, diff: "bye\n" },
  ],
  status: "inProgress",
};

describe("Codex approvals", () => {
  it("opens a thread with the sandbox closed and approvals coming to the person", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(codexTurn(""));
    const events = await collect(await newModel(spawnCli, "codex"), turn(port));
    const { thread, started } = JSON.parse(replyOf(events));
    expect(thread.method).toBe("thread/start");
    expect(thread.params).toMatchObject({
      cwd: ASK.workingDirectory,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(started.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Change the file" }],
    });
  });

  it("sends the model on the thread, and its effort and fast mode on the turn", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { calls, spawnCli } = talkingCli(codexTurn(""));
    const model = await newModel(spawnCli, "codex", "gpt-6.1-sol+max+fast");
    const { thread, started } = JSON.parse(replyOf(await collect(model, turn(port))));
    expect(calls[0]?.args).toEqual(["app-server"]);
    expect(thread.params.model).toBe("gpt-6.1-sol");
    expect(started.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Change the file" }],
      effort: "max",
      serviceTier: "priority",
    });
    // A resumed thread gets them again on its turn, since `thread/resume` takes no effort.
    const resumed = JSON.parse(replyOf(await collect(model, turn(port))));
    expect(resumed.thread.method).toBe("thread/resume");
    expect(resumed.started.params).toMatchObject({ effort: "max", serviceTier: "priority" });
  });

  it("leaves effort and fast mode off the turn when the model id has none it knows", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(codexTurn(""));
    const model = await newModel(spawnCli, "codex", "gpt-6.1-sol+ultra");
    const { thread, started } = JSON.parse(replyOf(await collect(model, turn(port))));
    expect(thread.params.model).toBe("gpt-6.1-sol");
    expect(started.params).not.toHaveProperty("effort");
    expect(started.params).not.toHaveProperty("serviceTier");
  });

  it("continues the conversation's session on the next turn", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(codexTurn(""));
    const model = await newModel(spawnCli, "codex");
    await collect(model, turn(port));
    const { thread } = JSON.parse(replyOf(await collect(model, turn(port))));
    expect(thread.method).toBe("thread/resume");
    expect(thread.params.threadId).toBe("thread-1");
  });

  it("asks about a command, showing what the model wrote", async () => {
    const { port, requests } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(
      codexTurn(`
        print(${JSON.stringify(COMMAND_APPROVAL)});
        globalThis.report = { answer: await take((line) => line.id === 0 && line.result) };
      `),
    );
    const events = await collect(await newModel(spawnCli, "codex"), turn(port));
    expect(requests[0]).toMatchObject({
      toolCallId: "exec-1",
      toolName: "Bash",
      input: {
        command: "printf 'hello' > note.txt",
        description: "Allow creating note.txt?",
      },
      reason: "Allow creating note.txt?",
    });
    expect(JSON.parse(replyOf(events)).answer).toEqual({ id: 0, result: { decision: "accept" } });
  });

  it("asks about a file change with its paths and diff, and declines when refused", async () => {
    const { port, requests } = approving(() => ({ allowed: false, reason: "No" }));
    const { spawnCli } = talkingCli(
      codexTurn(`
        print({ method: "item/started", params: { item: ${JSON.stringify(FILE_CHANGE)} } });
        print({ method: "item/fileChange/requestApproval", id: 1, params: { itemId: "exec-2", reason: null } });
        globalThis.report = { answer: await take((line) => line.id === 1 && line.result) };
      `),
    );
    const events = await collect(await newModel(spawnCli, "codex"), turn(port));
    expect(requests[0]).toMatchObject({ toolCallId: "exec-2", toolName: "Edit" });
    expect(requests[0]?.input).toEqual({
      changes: {
        "/project/new.txt": { type: "add", content: "hello\n" },
        "/project/old.txt": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n" },
        "/project/gone.txt": { type: "delete", old_content: "bye\n" },
      },
    });
    expect(JSON.parse(replyOf(events)).answer).toEqual({ id: 1, result: { decision: "decline" } });
  });

  it("closes an approval the server resolves by itself", async () => {
    const { closed, port } = waitingForever();
    const { spawnCli } = talkingCli(
      codexTurn(`
        print(${JSON.stringify(COMMAND_APPROVAL)});
        await new Promise((resolve) => setTimeout(resolve, 100));
        print({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 0 } });
        await new Promise((resolve) => setTimeout(resolve, 200));
        globalThis.report = { answers: inbox.filter((line) => line.id === 0) };
      `),
    );
    const events = await collect(await newModel(spawnCli, "codex"), turn(port));
    expect(closed).toHaveBeenCalledOnce();
    expect(JSON.parse(replyOf(events)).answers).toEqual([]);
  });

  it("turns down other server requests", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(
      codexTurn(`
        print({ method: "item/tool/requestUserInput", id: 2, params: {} });
        globalThis.report = { answer: await take((line) => line.id === 2 && line.error) };
      `),
    );
    const events = await collect(await newModel(spawnCli, "codex"), turn(port));
    expect(JSON.parse(replyOf(events)).answer.error.message).toBe(
      "xatlas doesn't handle item/tool/requestUserInput",
    );
  });

  it("reports the turn's work the way a headless run does", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(
      codexTurn(`
        print({ method: "item/started", params: { item: { type: "commandExecution", id: "c", command: "/bin/zsh -lc ls", commandActions: [{ type: "listFiles", command: "ls" }] } } });
        print({ method: "item/completed", params: { item: { type: "reasoning", id: "r", summary: ["Thinking it over"], content: [] } } });
        print({ method: "item/completed", params: { item: { ...${JSON.stringify(FILE_CHANGE)}, status: "completed" } } });
        print({ method: "item/completed", params: { item: { ...${JSON.stringify(FILE_CHANGE)}, status: "declined" } } });
        print({ method: "thread/tokenUsage/updated", params: { tokenUsage: {
          total: { inputTokens: 900, outputTokens: 90, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
          last: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, cacheWriteInputTokens: 0, reasoningOutputTokens: 1 } } } });
      `),
    );
    const events = await collect(await newModel(spawnCli, "codex"), turn(port));
    const thinking = events.flatMap((event) =>
      event.type === "reasoning_delta" ? [event.text] : [],
    );
    expect(thinking).toEqual([
      "Run: ls\n",
      "Thinking it over",
      "Edit: /project/new.txt\n",
      "Edit: /project/old.txt\n",
      "Edit: /project/gone.txt\n",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1 },
    });
  });

  it("surfaces a failed turn", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(`
      const init = await take((line) => line.method === "initialize");
      print({ id: init.id, result: {} });
      print({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "Out of credits" } } } });
      await stdinClosed();
    `);
    await expect(collect(await newModel(spawnCli, "codex"), turn(port))).rejects.toThrow(
      "Out of credits",
    );
  });

  it("surfaces a refused request", async () => {
    const { port } = approving((request) => ({ allowed: true, input: request.input }));
    const { spawnCli } = talkingCli(`
      const init = await take((line) => line.method === "initialize");
      print({ id: init.id, error: { code: -32600, message: "Unsupported client" } });
      await stdinClosed();
    `);
    await expect(collect(await newModel(spawnCli, "codex"), turn(port))).rejects.toThrow(
      "Unsupported client",
    );
  });
});
