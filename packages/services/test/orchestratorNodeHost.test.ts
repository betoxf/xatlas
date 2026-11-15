import { Emitter } from "@zcode/rpc";
import type {
  AppOperationRef,
  OperationStatus,
  OperationUpdate,
} from "@zcode/session-control/contracts";
import type {
  ManagedWorktreeCreation,
  ManagedWorktreeCreationSettlement,
  ManagedWorktreeError,
} from "@zcode/shared";
import { cliAgentEndpoint, type CliAgentId } from "@zcode/shared/cli-agents";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { AvailableAgent, SwarmOptions } from "@zcode/swarm/types";
import { describe, expect, it, vi } from "vitest";
import {
  createNodeOrchestratorHost,
  memberIdOf,
  membersOf,
  type NodeOrchestratorHostDeps,
} from "../src/orchestrator/nodeHost.js";
import { HOST_WORKTREE_COMMAND } from "../src/zcode-agent/zcodeAgent.js";

const project = { projectId: "p1", workspacePath: "/repo" };

function ack(commandId: string, status: CommandAck["status"] = "accepted", extra = {}): CommandAck {
  return { commandId, status, revisionAtDecision: 0, ...extra } as CommandAck;
}

function creation(
  id: string,
  phase: ManagedWorktreeCreation["phase"],
  worktreePath: string | null,
  error: ManagedWorktreeError | null = null,
): ManagedWorktreeCreation {
  return {
    id,
    kind: "new-task",
    projectId: "p1",
    workspacePath: "/repo",
    phase,
    ref: null,
    worktreePath,
    output: "",
    error,
    promptText: "",
    parentSessionId: null,
    createdAt: 0,
  };
}

/**
 * A feed whose statuses come one by one; "lost" is an invalidation. Like the real one it stays
 * open after its last update until it is closed.
 */
function feed(statuses: ReadonlyArray<OperationStatus | "lost">) {
  const [first = "running", ...rest] = statuses;
  const snapshot = (status: OperationStatus) =>
    ({ operation: {} as AppOperationRef, epoch: "e", revision: 0, status }) as never;
  let closed!: () => void;
  const whenClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  return {
    initial: snapshot(first === "lost" ? "unknown" : first),
    updates: (async function* (): AsyncGenerator<OperationUpdate<never>> {
      for (const status of rest) {
        yield status === "lost"
          ? ({ type: "invalidated", operation: {} as never, reason: "Owner restarted" } as never)
          : { type: "snapshot", snapshot: snapshot(status) };
      }
      await whenClosed;
    })(),
    close: vi.fn(async () => closed()),
  };
}

/** A user message as the CLI keeps it: the command that sent it is in its input intent. */
function userMessage(messageId: string, commandId?: string) {
  return {
    info: {
      role: "user",
      messageId,
      ...(commandId ? { metadata: { inputIntent: { sourceCommandId: commandId } } } : {}),
    },
    parts: [{ type: "text", text: "input" }],
  };
}

/** Every assistant message of a turn names the turn's input message as its parent. */
function assistantMessage(messageId: string, parentMessageId: string, ...texts: string[]) {
  return {
    info: { role: "assistant", messageId, parentMessageId },
    parts: texts.map((text) => (text ? { type: "text", text } : { type: "tool", tool: "bash" })),
  };
}

function setup(options: {
  connected?: CliAgentId[];
  startNewTask?: NodeOrchestratorHostDeps["worktrees"]["startNewTask"];
  dismiss?: (creationId: string) => Promise<void>;
  sendAck?: (envelope: CommandEnvelope) => CommandAck;
  feeds?: ReadonlyArray<ReadonlyArray<OperationStatus | "lost" | "throw">>;
  prefix?: string;
  agents?: AvailableAgent[];
  refs?: Awaited<ReturnType<NodeOrchestratorHostDeps["worktrees"]["listStartRefs"]>>;
  worktreeCwd?: boolean;
  /** The transcript, given the last command sent and the window asked for. */
  messages?: (commandId: string | undefined, limit: number | undefined) => unknown[];
}) {
  const changes = new Emitter<ManagedWorktreeCreation[]>();
  const settles = new Emitter<ManagedWorktreeCreationSettlement>();
  const added: string[] = [];
  const sent: Array<Record<PropertyKey, unknown> & { envelope: CommandEnvelope }> = [];
  const observed: AppOperationRef[] = [];
  const reads: Array<number | undefined> = [];
  const feeds = [...(options.feeds ?? [])];
  const calls = {
    reserve: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    dismiss: vi.fn(options.dismiss ?? (async () => undefined)),
    askMember: vi.fn(async () => "answer"),
    runDeliberation: vi.fn(async (input: SwarmOptions) => ({ task: input.task }) as never),
    askOpenRouter: vi.fn(async () => "B A"),
    askClaudeAdvisor: vi.fn(async () => "A B"),
    readAccount: vi.fn(() =>
      Promise.resolve({ signedIn: true, windows: [], limits: "none" as const, models: ["opus"] }),
    ),
    git: vi.fn(async () => ({ code: 0, stdout: `${options.prefix ?? ""}\n`, stderr: "" })),
  };
  const connected = options.connected ?? ["claude", "codex"];
  const deps: NodeOrchestratorHostDeps = {
    isLocalHost: true,
    worktrees: {
      startNewTask: options.startNewTask ?? (async () => ({ ok: true, creationId: "c1" })),
      dismissCreation: ({ creationId }) => calls.dismiss(creationId),
      listCreations: async () => [],
      onDidChangeCreations: changes.event,
      onDidSettleCreation: settles.event,
      listStartRefs: async () =>
        options.refs === undefined
          ? { head: { sha: "abc", branchName: "main" }, localBranches: [], remoteBranches: [] }
          : options.refs,
      supportsWorktreeCwd: async () => options.worktreeCwd ?? true,
      isWorktreeAvailable: async () => true,
    },
    agent: {
      sendConversationCommandV4: async (params) => {
        sent.push(params as never);
        return (options.sendAck ?? ((envelope) => ack(envelope.commandId)))(params.envelope);
      },
      readSessionMessages: async (params) => {
        reads.push(params.limit);
        const commandId = sent.at(-1)?.envelope.commandId;
        return (options.messages?.(commandId, params.limit) ?? [
          assistantMessage("a0", "u0", "an earlier turn"),
          userMessage("u1", commandId),
          assistantMessage("a1", "u1", "done,", "", "all green"),
          assistantMessage("a2", "u1", ""),
        ]) as never;
      },
    },
    observe: async (operation) => {
      observed.push(operation);
      const next = feeds.shift() ?? ["completed"];
      if (next[0] === "throw") throw new Error("Observation identity changed");
      return feed(next as ReadonlyArray<OperationStatus | "lost">) as never;
    },
    providerSettings: {
      getView: async () => ({
        providers: connected.map((agent) => ({
          providerId: `provider-${agent}`,
          enabled: true,
          effectiveConfig: { api: { baseUrl: cliAgentEndpoint(agent) } },
          models: [],
        })),
      }),
      createPersonalProvider: async () => ({ providerId: "new" }),
      savePersonalProviderOverlay: async () => undefined,
      addPersonalModel: async (_providerId: string, modelId: string) => {
        added.push(modelId);
      },
      deletePersonalModel: async () => undefined,
    } as never,
    tasks: { reserve: calls.reserve, release: calls.release, rename: calls.rename },
    swarm: {
      listAgents: async () =>
        options.agents ?? [{ agent: "claude", installed: true, ready: true, detail: "" }],
      readAccount: calls.readAccount,
      askMember: calls.askMember,
      runDeliberation: calls.runDeliberation as never,
      askOpenRouter: calls.askOpenRouter,
      askClaudeAdvisor: calls.askClaudeAdvisor,
    },
    git: calls.git,
  };
  return {
    host: createNodeOrchestratorHost(deps),
    changes,
    settles,
    sent,
    observed,
    reads,
    added,
    calls,
  };
}

describe("node orchestrator host: executors", () => {
  it("starts a managed worktree task on the chosen model, in edit mode, and settles", async () => {
    let started: Parameters<NodeOrchestratorHostDeps["worktrees"]["startNewTask"]>[0] | undefined;
    const harness = setup({
      // The service publishes before startNewTask returns: the host must already listen.
      startNewTask: async (params) => {
        started = params;
        harness.changes.fire([creation("c1", "starting-session", "/wt/ab12/repo")]);
        harness.settles.fire({
          creationId: "c1",
          outcome: "session-started",
          workspacePath: "/repo",
          sessionId: "sess_real",
        });
        return { ok: true, creationId: "c1" };
      },
    });
    const result = await harness.host.startExecutor({
      project,
      ref: "abc123",
      title: "api: add the route",
      text: "Do the api step.",
      choice: { agent: "claude", model: "opus", effort: "high" },
    });
    expect(result).toEqual({ conversationId: "sess_real", worktreePath: "/wt/ab12/repo" });
    expect(started).toMatchObject({ workspacePath: "/repo", projectId: "p1", ref: "abc123" });
    const envelope = started!.envelope;
    expect(envelope).toMatchObject({ type: "createSession", sessionId: null });
    const selection = {
      providerId: "provider-claude",
      modelId: "opus+high",
      options: { reasoningLevel: "disabled" },
    };
    const submission = { modelSelection: selection, mode: "guarded", planEnabled: false };
    expect(envelope.payload).toMatchObject({
      workspaceId: "/repo",
      config: submission,
      firstInput: { text: "Do the api step.", ...submission },
    });
    expect((envelope.payload as { sessionId: string }).sessionId).toMatch(/^sess_/);
    expect(harness.added).toEqual(["opus+high"]);
    expect(harness.calls.rename).toHaveBeenCalledWith({
      workspacePath: "/repo",
      taskId: "sess_real",
      title: "api: add the route",
    });
  });

  it("dismisses a failed creation on a later tick and rejects with a plain sentence", async () => {
    // Like the service: a creation is marked failed while its run is still unwinding, and
    // dismissing it before that throws "worktree.creation-not-failed".
    let running = false;
    const harness = setup({
      startNewTask: async () => {
        setImmediate(() => {
          harness.changes.fire([creation("c1", "creating", "/wt/ab12/repo")]);
          running = true;
          harness.changes.fire([
            creation("c1", "failed", null, { code: "git-failed", detail: "fatal: bad" }),
          ]);
          void Promise.resolve()
            .then(() => undefined)
            .then(() => {
              running = false;
            });
        });
        return { ok: true, creationId: "c1" };
      },
      dismiss: async (creationId) => {
        if (running) throw new Error("worktree.creation-not-failed");
        harness.settles.fire({
          creationId,
          outcome: "dismissed",
          workspacePath: "/repo",
          promptText: "x",
        });
      },
    });
    await expect(
      harness.host.startExecutor({
        project,
        ref: null,
        title: "t",
        text: "x",
        choice: { agent: "claude" },
      }),
    ).rejects.toThrow(/^Git couldn't make the step's worktree\. fatal: bad$/);
    expect(harness.calls.dismiss).toHaveBeenCalledWith("c1");
  });

  it("resolves when dismissing shows the conversation had started after all", async () => {
    const harness = setup({
      startNewTask: async () => {
        queueMicrotask(() =>
          harness.changes.fire([
            creation("c1", "failed", "/wt/x/repo", { code: "session-failed" }),
          ]),
        );
        return { ok: true, creationId: "c1" };
      },
      dismiss: async (creationId) =>
        harness.settles.fire({
          creationId,
          outcome: "session-started",
          workspacePath: "/repo",
          sessionId: "sess_late",
        }),
    });
    await expect(
      harness.host.startExecutor({
        project,
        ref: null,
        title: "t",
        text: "x",
        choice: { agent: "claude" },
      }),
    ).resolves.toEqual({ conversationId: "sess_late", worktreePath: "/wt/x/repo" });
  });

  it("says why when the worktree service refuses or the agent isn't connected", async () => {
    const refused = setup({
      startNewTask: async () => ({ ok: false, error: { code: "unsupported-agent" } }),
    });
    await expect(
      refused.host.startExecutor({
        project,
        ref: null,
        title: "t",
        text: "x",
        choice: { agent: "claude" },
      }),
    ).rejects.toThrow("can't run a conversation in a worktree");
    const thrown = setup({
      startNewTask: async () => {
        throw new Error("worktree.not-primary-root");
      },
    });
    await expect(
      thrown.host.startExecutor({
        project,
        ref: null,
        title: "t",
        text: "x",
        choice: { agent: "claude" },
      }),
    ).rejects.toThrow("isn't its main folder");
    const offline = setup({ connected: ["claude"] });
    await expect(
      offline.host.startExecutor({
        project,
        ref: null,
        title: "t",
        text: "x",
        choice: { agent: "codex" },
      }),
    ).rejects.toThrow("Codex isn't connected in the app");
  });
});

describe("node orchestrator host: reviewers", () => {
  it("reserves the task in the worktree and creates a Plan conversation there", async () => {
    const harness = setup({
      prefix: "packages/app/",
      sendAck: (envelope) =>
        ack(envelope.commandId, "accepted", {
          result: { type: "createSession", sessionId: "sess_rev" },
        }),
    });
    const result = await harness.host.startReviewer({
      project,
      worktreePath: "/wt/ab12/repo",
      title: "review: api",
      text: "Review it.",
      choice: { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
    });
    expect(result).toEqual({ conversationId: "sess_rev" });
    const [reserve] = harness.calls.reserve.mock.calls[0] as unknown as [
      { task: { taskId: string }; cwd: string; worktreeRoot: string; projectId: string },
    ];
    expect(reserve).toMatchObject({
      projectId: "p1",
      cwd: "/wt/ab12/repo/packages/app",
      worktreeRoot: "/wt/ab12/repo",
    });
    const [params] = harness.sent;
    expect(params![HOST_WORKTREE_COMMAND]).toBe(true);
    expect(params).toMatchObject({ workspacePath: "/repo", projectId: "p1" });
    const submission = {
      modelSelection: {
        providerId: "provider-codex",
        modelId: "gpt-6.1-sol+max+fast",
        options: { reasoningLevel: "disabled" },
      },
      mode: "build",
      planEnabled: true,
    };
    expect(params!.envelope.payload).toMatchObject({
      sessionId: reserve.task.taskId,
      cwd: "/wt/ab12/repo/packages/app",
      config: submission,
      firstInput: { text: "Review it.", ...submission },
    });
  });

  it("releases the reservation when the conversation is refused", async () => {
    const harness = setup({
      sendAck: (envelope) =>
        ack(envelope.commandId, "rejected", { reasonCode: "proto.invalidPayload" }),
    });
    await expect(
      harness.host.startReviewer({
        project,
        worktreePath: "/wt/ab12/repo",
        title: "r",
        text: "x",
        choice: { agent: "claude" },
      }),
    ).rejects.toThrow("refused (proto.invalidPayload)");
    expect(harness.calls.release).toHaveBeenCalledTimes(1);
  });
});

describe("node orchestrator host: turns", () => {
  it("waits for the turn of the last message sent and reads the assistant's last text", async () => {
    const harness = setup({ feeds: [["accepted", "running", "completed"]] });
    await harness.host.send({ project, conversationId: "sess_1", text: "Fix finding F1." });
    const [sent] = harness.sent;
    expect(sent!.envelope).toMatchObject({
      type: "sendText",
      sessionId: "sess_1",
      payload: { text: "Fix finding F1.", requestedDelivery: "queue" },
    });
    await expect(harness.host.waitForTurn({ project, conversationId: "sess_1" })).resolves.toEqual({
      status: "completed",
      text: "done,\nall green",
    });
    expect(harness.observed[0]).toMatchObject({
      sessionId: "sess_1",
      commandId: sent!.envelope.commandId,
      session: { kind: "app", workspacePath: "/repo", sessionId: "sess_1" },
    });
  });

  it("reports a stop to ask, an interrupted turn, and a lost observation", async () => {
    const asks = setup({ feeds: [["needs_attention"]] });
    await asks.host.send({ project, conversationId: "s", text: "x" });
    expect((await asks.host.waitForTurn({ project, conversationId: "s" })).status).toBe(
      "needs_attention",
    );
    const stopped = setup({ feeds: [["running", "interrupted"]] });
    await stopped.host.send({ project, conversationId: "s", text: "x" });
    expect((await stopped.host.waitForTurn({ project, conversationId: "s" })).status).toBe(
      "failed",
    );
    const lost = setup({ feeds: [["running", "lost"], ["completed"]] });
    await lost.host.send({ project, conversationId: "s", text: "x" });
    expect((await lost.host.waitForTurn({ project, conversationId: "s" })).status).toBe(
      "completed",
    );
    expect(lost.observed).toHaveLength(2);
    const reopened = setup({ feeds: [["throw"], ["completed"]] });
    await reopened.host.send({ project, conversationId: "s", text: "x" });
    expect((await reopened.host.waitForTurn({ project, conversationId: "s" })).status).toBe(
      "completed",
    );
    const gone = setup({
      feeds: [
        ["running", "lost"],
        ["running", "lost"],
        ["running", "lost"],
        ["running", "lost"],
      ],
    });
    await gone.host.send({ project, conversationId: "s", text: "x" });
    await expect(gone.host.waitForTurn({ project, conversationId: "s" })).resolves.toEqual({
      status: "failed",
      text: "The turn's outcome could not be read (Owner restarted).",
    });
  });

  it("returns the answer to its own turn, not to one the person typed after it", async () => {
    const harness = setup({
      messages: (commandId) => [
        userMessage("u1", commandId),
        assistantMessage("a1", "u1", "verdict: pass"),
        userMessage("u2", "person-typed-command"),
        assistantMessage("a2", "u2", "the answer to the person"),
      ],
    });
    await harness.host.send({ project, conversationId: "s", text: "Review it." });
    await expect(harness.host.waitForTurn({ project, conversationId: "s" })).resolves.toEqual({
      status: "completed",
      text: "verdict: pass",
    });
  });

  it("looks further back for its turn, and returns no text when the turn can't be found", async () => {
    const filler = Array.from({ length: 50 }, (_, index) =>
      assistantMessage(`f${index}`, "u2", `later reply ${index}`),
    );
    const further = setup({
      messages: (commandId, limit) =>
        limit === 50
          ? filler
          : [userMessage("u1", commandId), assistantMessage("a1", "u1", "mine"), ...filler],
    });
    await further.host.send({ project, conversationId: "s", text: "x" });
    expect((await further.host.waitForTurn({ project, conversationId: "s" })).text).toBe("mine");
    expect(further.reads).toEqual([50, 500]);
    const missing = setup({
      messages: () => [
        userMessage("u2", "person-typed-command"),
        assistantMessage("a2", "u2", "the answer to the person"),
      ],
    });
    await missing.host.send({ project, conversationId: "s", text: "x" });
    await expect(missing.host.waitForTurn({ project, conversationId: "s" })).resolves.toEqual({
      status: "completed",
      text: "",
    });
  });

  it(
    "treats an unknown outcome as a lost observation and fails once recovery is used up",
    { timeout: 2_000 },
    async () => {
      const recovered = setup({ feeds: [["unknown"], ["completed"]] });
      await recovered.host.send({ project, conversationId: "s", text: "x" });
      expect((await recovered.host.waitForTurn({ project, conversationId: "s" })).status).toBe(
        "completed",
      );
      expect(recovered.observed).toHaveLength(2);
      const unreadable = setup({
        feeds: [
          ["running", "unknown"],
          ["running", "unknown"],
          ["running", "unknown"],
          ["running", "unknown"],
        ],
      });
      await unreadable.host.send({ project, conversationId: "s", text: "x" });
      await expect(
        unreadable.host.waitForTurn({ project, conversationId: "s" }),
      ).resolves.toMatchObject({
        status: "failed",
        text: expect.stringMatching(/^The turn's outcome could not be read/),
      });
      expect(unreadable.observed).toHaveLength(4);
    },
  );

  it("refuses to wait on a conversation it sent nothing, and throws on a refused message", async () => {
    const harness = setup({
      sendAck: (envelope) => ack(envelope.commandId, "rejected", { reasonCode: "guard.busy" }),
    });
    await expect(harness.host.waitForTurn({ project, conversationId: "other" })).rejects.toThrow(
      "can't tell which turn",
    );
    await expect(harness.host.send({ project, conversationId: "s", text: "x" })).rejects.toThrow(
      "didn't take the message (guard.busy)",
    );
  });

  it("interrupts with a stop command and accepts a noop", async () => {
    const harness = setup({ sendAck: (envelope) => ack(envelope.commandId, "noop") });
    await harness.host.interrupt({ project, conversationId: "s" });
    expect(harness.sent[0]!.envelope).toMatchObject({ type: "stop", sessionId: "s", payload: {} });
  });
});

describe("node orchestrator host: parliament and questions", () => {
  it("names members readably and keeps seats' weight, vote and options", () => {
    expect(memberIdOf({ agent: "claude", model: "fable" })).toBe("claude:fable");
    expect(memberIdOf({ agent: "codex" })).toBe("codex");
    expect(
      membersOf([
        { agent: "claude", model: "fable", weight: 2 },
        { agent: "codex", model: "gpt-6.1-sol", effort: "max", fast: true },
        { agent: "claude", model: "opus", votesOnly: true },
        { agent: "claude", model: "fable" },
      ]),
    ).toEqual([
      { id: "claude:fable", agent: "claude", model: "fable", weight: 2 },
      {
        id: "codex:gpt-6.1-sol+max+fast",
        agent: "codex",
        model: "gpt-6.1-sol",
        effort: "max",
        fast: true,
      },
      { id: "claude:opus+vote", agent: "claude", model: "opus", votesOnly: true },
      { id: "claude:fable#2", agent: "claude", model: "fable" },
    ]);
  });

  it("runs the swarm with the advisors only when they are given, in their order", async () => {
    const harness = setup({});
    const seats = [
      { agent: "claude" as const, model: "fable" },
      { agent: "codex" as const, model: "gpt-6-astra" },
    ];
    await harness.host.deliberate({ task: "plan it", cwd: "/repo", seats });
    await harness.host.deliberate({ task: "plan it", cwd: "/repo", seats, advisors: [] });
    for (const [without] of harness.calls.runDeliberation.mock.calls) {
      expect(without.advisors).toBeUndefined();
      expect(without.members.map((member) => member.id)).toEqual([
        "claude:fable",
        "codex:gpt-6-astra",
      ]);
    }

    await harness.host.deliberate({
      task: "plan it",
      cwd: "/repo",
      seats,
      advisors: [
        { via: "claude", model: "opus", effort: "high" },
        { via: "claude", model: "claude-mythos-5-2" },
        { via: "openrouter", model: "google/gemini-4-argon", effort: "high" },
        { via: "claude", model: "opus", effort: "high" },
      ],
    });
    const [withAdvisors] = harness.calls.runDeliberation.mock.calls[2]!;
    const advisors = withAdvisors.advisors ?? [];
    expect(advisors.map((advisor) => advisor.id)).toEqual([
      "claude:opus+high",
      "claude:claude-mythos-5-2",
      "openrouter:google/gemini-4-argon+high",
      "claude:opus+high#2",
    ]);
    const signal = new AbortController().signal;
    expect(await advisors[0]!.ask("rank these", { signal })).toBe("A B");
    await advisors[1]!.ask("rank these", {});
    expect(await advisors[2]!.ask("rank these", {})).toBe("B A");
    // Only the prompt, the model and the effort go in: no folder, and the key is read inside askOpenRouter.
    expect(harness.calls.askClaudeAdvisor.mock.calls).toEqual([
      ["rank these", { model: "opus", effort: "high", signal }],
      ["rank these", { model: "claude-mythos-5-2" }],
    ]);
    expect(harness.calls.askOpenRouter).toHaveBeenCalledWith("rank these", {
      model: "google/gemini-4-argon",
      effort: "high",
    });
  });

  it("asks one member and reports agents from their checks and accounts", async () => {
    const harness = setup({
      agents: [
        { agent: "claude", installed: true, ready: true, detail: "" },
        { agent: "gemini", installed: false, ready: false, detail: "not installed" },
      ],
    });
    await harness.host.ask({ agent: "claude", model: "haiku" }, "route?", { cwd: "/repo" });
    expect(harness.calls.askMember).toHaveBeenCalledWith(
      { id: "claude:haiku", agent: "claude", model: "haiku" },
      "route?",
      { cwd: "/repo" },
    );
    expect(await harness.host.agents()).toEqual([
      { agent: "claude", ready: true, models: ["opus"], limits: "none", windows: [] },
      { agent: "gemini", ready: false, limits: "unknown", windows: [] },
    ]);
    expect(harness.calls.readAccount).toHaveBeenCalledTimes(1);
  });
});

describe("node orchestrator host: where it can run", () => {
  it("answers with one sentence when the route can't run, and nothing when it can", async () => {
    expect(await setup({}).host.cannotOrchestrate(project)).toBeUndefined();
    expect(
      await setup({}).host.cannotOrchestrate({ ...project, workspaceIdentity: "ssh://box/repo" }),
    ).toMatch(/reached remotely/);
    expect(await setup({ refs: null }).host.cannotOrchestrate(project)).toMatch(
      /isn't a Git repository/,
    );
    expect(
      await setup({
        refs: { head: null, localBranches: [], remoteBranches: [] },
      }).host.cannotOrchestrate(project),
    ).toMatch(/no commits yet/);
    expect(await setup({ worktreeCwd: false }).host.cannotOrchestrate(project)).toMatch(
      /can't run a conversation in a worktree/,
    );
  });
});
