import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AdvisorChoice, ModelChoice, ParliamentSeat } from "@zcode/orchestrator/types";
import { snapshotOf } from "@zcode/orchestrator/routing";
import { createGitRunner, type GitRunner } from "@zcode/orchestrator/worktrees";
import type {
  AppOperationRef,
  AppSessionRef,
  OperationFeed,
  OperationStatus,
} from "@zcode/session-control/contracts";
import {
  uuidv7,
  type ManagedWorktreeCreationSettlement,
  type ManagedWorktreeError,
  type ModelSelection,
  type ZCodeMessageWithParts,
} from "@zcode/shared";
import { cliAgentModelId } from "@zcode/shared/cli-agents";
import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
  SubmissionMode,
} from "@zcode/shared/zcode-protocol-v4";
import {
  askClaudeAdvisor,
  askMember,
  askOpenRouter,
  listAvailableAgents,
  readAgentAccount,
  runDeliberation,
  type SwarmAdvisor,
  type SwarmMember,
} from "@zcode/swarm";
import {
  ensureCliAgentModel,
  type CliAgentProviderSettings,
} from "../connections/cliAgentProviders.js";
import type { IManagedWorktreeService } from "../managed-worktree-tasks/contract.js";
import { HOST_WORKTREE_COMMAND, type IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { OrchestratorHost } from "./host.js";
import type { OrchestratorProject } from "./orchestrator.js";

/** Commands the orchestrator sends carry this client id, so they read as its own. */
const CLIENT_ID = "xatlas-orchestrator";
/** How often a turn's observation may be lost (owner restarted) and opened again. */
const MAX_REOBSERVE = 3;
/** The tails of the transcript read, widest last, to find the turn's input message. */
const REPLY_WINDOWS = [50, 500] as const;

const AGENT_NAMES: Record<ModelChoice["agent"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

/** The parliament discusses before it plans (`runDeliberation`), for this many rounds. */
const PARLIAMENT_ROUNDS = 2;

/**
 * Autonomous: the executor edits, runs commands and commits without asking, and the CLI
 * adapter confines Claude Code and Codex to the worktree and the repository's git data.
 */
const EXECUTOR_SUBMISSION = { mode: "guarded" as SubmissionMode, planEnabled: false };
/** Plan: the reviewer reads the worktree and its diff, and changes nothing. */
const REVIEWER_SUBMISSION = { mode: "build" as SubmissionMode, planEnabled: true };

type TaskRef = { workspacePath: string; workspaceIdentity?: string; taskId: string };

export interface NodeOrchestratorHostDeps {
  /** False on a host that serves remote workspaces: managed worktrees are local only. */
  readonly isLocalHost: boolean;
  readonly worktrees: Pick<
    IManagedWorktreeService,
    | "startNewTask"
    | "dismissCreation"
    | "listCreations"
    | "onDidChangeCreations"
    | "onDidSettleCreation"
    | "listStartRefs"
    | "supportsWorktreeCwd"
    | "isWorktreeAvailable"
  >;
  readonly agent: Pick<IZCodeAgentService, "sendConversationCommandV4" | "readSessionMessages">;
  /** `observeAppOperation` on the app's agent service. */
  readonly observe: (
    operation: AppOperationRef,
    signal: AbortSignal,
  ) => Promise<OperationFeed<AppSessionRef>>;
  readonly providerSettings: CliAgentProviderSettings;
  /** The task row a conversation in an existing worktree needs before it is created. */
  readonly tasks: {
    reserve(input: {
      task: TaskRef;
      projectId: string;
      cwd: string;
      worktreeRoot: string;
    }): Promise<void>;
    release(task: TaskRef): Promise<void>;
    rename(task: TaskRef & { title: string }): Promise<unknown>;
  };
  /** Tests pass their own; the swarm's runners otherwise. */
  readonly swarm?: {
    readonly listAgents?: typeof listAvailableAgents;
    readonly readAccount?: typeof readAgentAccount;
    readonly askMember?: typeof askMember;
    readonly runDeliberation?: typeof runDeliberation;
    readonly askOpenRouter?: typeof askOpenRouter;
    readonly askClaudeAdvisor?: typeof askClaudeAdvisor;
  };
  readonly git?: GitRunner;
}

/** A seat's member id: `agent[:model][+effort][+fast][+vote]`, as `parseMember` reads it. */
export function memberIdOf(seat: ParliamentSeat): string {
  return [
    seat.model ? `${seat.agent}:${seat.model}` : seat.agent,
    ...(seat.effort ? [seat.effort] : []),
    ...(seat.fast ? ["fast"] : []),
    ...(seat.votesOnly ? ["vote"] : []),
  ].join("+");
}

/** The seats as swarm members. Two identical seats get `#2`, `#3` so ids stay unique. */
export function membersOf(seats: readonly ParliamentSeat[]): SwarmMember[] {
  const seen = new Map<string, number>();
  return seats.map((seat) => {
    const base = memberIdOf(seat);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return {
      ...memberOf(seat, count === 1 ? base : `${base}#${count}`),
      ...(seat.weight !== undefined ? { weight: seat.weight } : {}),
      ...(seat.votesOnly ? { votesOnly: true } : {}),
    };
  });
}

function memberOf(choice: ModelChoice, id = memberIdOf(choice)): SwarmMember {
  return {
    id,
    agent: choice.agent,
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
    ...(choice.fast ? { fast: true } : {}),
  };
}

/**
 * The outside advisors, in their order, each named `via:model[+effort]` as `parseAdvisor` reads
 * it; two identical choices get `#2`, `#3`. OpenRouter's key is read inside `askOpenRouter`,
 * never here, and Claude Code runs with no tools in an empty folder (`askClaudeAdvisor`).
 * Neither is given the project: only the prompt, the model and the effort.
 */
export function advisorsOf(
  choices: readonly AdvisorChoice[],
  ask: { readonly openRouter: typeof askOpenRouter; readonly claude: typeof askClaudeAdvisor },
): SwarmAdvisor[] {
  const seen = new Map<string, number>();
  return choices.map((choice) => {
    const base = `${choice.via}:${choice.model}${choice.effort ? `+${choice.effort}` : ""}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const askVia = choice.via === "claude" ? ask.claude : ask.openRouter;
    return {
      id: count === 1 ? base : `${base}#${count}`,
      ask: (prompt, { signal }) =>
        askVia(prompt, {
          model: choice.model,
          ...(choice.effort ? { effort: choice.effort } : {}),
          ...(signal ? { signal } : {}),
        }),
    };
  });
}

/** The port's turn end, or undefined while the turn is still going. */
export function turnEndOf(
  status: OperationStatus,
): "completed" | "failed" | "needs_attention" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    // The port has no "interrupted": a stopped turn did not finish its work.
    case "interrupted":
    case "failed":
      return "failed";
    case "needs_attention":
      return "needs_attention";
    default:
      return undefined;
  }
}

const WORKTREE_ERRORS: Partial<Record<ManagedWorktreeError["code"], string>> = {
  "not-repository": "The project isn't a Git repository, so the step can't have a worktree.",
  "invalid-start-ref": "The commit the step should start from doesn't exist in the repository.",
  "start-ref-missing-subdir":
    "The commit the step should start from doesn't have the project's folder.",
  "bucket-exhausted": "The app has no free folder left for another worktree; remove old ones.",
  "local-only": "Worktrees can only be made for projects on this computer.",
  "git-failed": "Git couldn't make the step's worktree.",
  "copy-failed":
    "The files listed in .worktreeinclude couldn't be copied into the step's worktree.",
  "unsupported-agent": "The app's agent runtime can't run a conversation in a worktree; update it.",
  "session-failed": "The worktree was made, but its conversation didn't start.",
};

function worktreeErrorSentence(error: ManagedWorktreeError): string {
  const sentence = WORKTREE_ERRORS[error.code] ?? `The step's worktree failed (${error.code}).`;
  return error.detail ? `${sentence} ${error.detail}` : sentence;
}

function startErrorSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "worktree.not-primary-root")
    return "The project's folder isn't its main folder, and worktrees are made only from that one.";
  if (message === "project.not-found") return "The project couldn't be found; reopen it.";
  if (message === "worktree.local-only") return WORKTREE_ERRORS["local-only"]!;
  return `The step's worktree couldn't be started: ${message}`;
}

const accepted = (ack: CommandAck) => ack.status === "accepted" || ack.status === "duplicate";

function workspaceOf(project: OrchestratorProject) {
  return {
    workspacePath: project.workspacePath,
    ...(project.workspaceIdentity?.trim() ? { workspaceIdentity: project.workspaceIdentity } : {}),
  };
}

function envelopeOf(
  type: CommandEnvelope["type"],
  sessionId: string | null,
  payload: unknown,
): CommandEnvelope {
  return {
    commandId: uuidv7(),
    clientId: CLIENT_ID,
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
  };
}

/** The command that sent a user message: the CLI keeps it in the message's input intent. */
export function inputCommandOf(message: ZCodeMessageWithParts): string | undefined {
  if (message.info.role !== "user") return undefined;
  for (const key of ["conversationInputIntent", "inputIntent"]) {
    const intent = message.info.metadata?.[key];
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) continue;
    const id = (intent as Record<string, unknown>)["sourceCommandId"];
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * The assistant's last text in the turn that `commandId` started; undefined when that turn's
 * input message isn't among `messages`. Every assistant message of a turn names the turn's input
 * message as its parent, so the answer to anything sent after it is never taken.
 */
export function replyOfTurn(
  messages: readonly ZCodeMessageWithParts[],
  commandId: string,
): string | undefined {
  const input = messages.findLast((message) => inputCommandOf(message) === commandId);
  if (!input) return undefined;
  let reply = "";
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.parentMessageId !== input.info.messageId)
      continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (text) reply = text;
  }
  return reply;
}

/** A macrotask: the worktree service marks a creation failed before it may be dismissed. */
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createNodeOrchestratorHost(deps: NodeOrchestratorHostDeps): OrchestratorHost {
  const git = deps.git ?? createGitRunner();
  const swarm = {
    listAgents: deps.swarm?.listAgents ?? listAvailableAgents,
    readAccount: deps.swarm?.readAccount ?? readAgentAccount,
    askMember: deps.swarm?.askMember ?? askMember,
    runDeliberation: deps.swarm?.runDeliberation ?? runDeliberation,
    askOpenRouter: deps.swarm?.askOpenRouter ?? askOpenRouter,
    askClaudeAdvisor: deps.swarm?.askClaudeAdvisor ?? askClaudeAdvisor,
  };
  /** The last command this host sent each conversation; its turn is the one waited for. */
  const lastCommand = new Map<string, string>();

  async function selectionOf(choice: ModelChoice): Promise<ModelSelection> {
    const found = await ensureCliAgentModel(
      deps.providerSettings,
      choice.agent,
      cliAgentModelId(choice.model, {
        ...(choice.effort ? { effort: choice.effort } : {}),
        ...(choice.fast ? { fast: true } : {}),
      }),
    );
    if (!found)
      throw new Error(
        `${AGENT_NAMES[choice.agent]} isn't connected in the app; sign in to it under Connections.`,
      );
    return { ...found, options: { reasoningLevel: "disabled" } };
  }

  function createPayload(
    project: OrchestratorProject,
    sessionId: string,
    text: string,
    submission: { modelSelection: ModelSelection; mode: SubmissionMode; planEnabled: boolean },
    cwd?: string,
  ): CommandPayloadMap["createSession"] {
    return {
      sessionId,
      workspaceId: project.workspaceIdentity?.trim() || project.workspacePath,
      ...(cwd ? { cwd } : {}),
      config: submission,
      firstInput: { text, ...submission },
    };
  }

  async function rename(project: OrchestratorProject, taskId: string, title: string) {
    // A title is a nicety: a failed rename leaves the one the app gave it.
    await deps.tasks.rename({ ...workspaceOf(project), taskId, title }).catch(() => undefined);
  }

  /** Starts the creation and resolves once the worktree service settled it. */
  async function startInNewWorktree(
    project: OrchestratorProject,
    ref: string | null,
    envelope: CommandEnvelope,
  ): Promise<{ sessionId: string; worktreePath: string }> {
    const paths = new Map<string, string>();
    const failures = new Map<string, ManagedWorktreeError>();
    const settled = new Map<string, ManagedWorktreeCreationSettlement>();
    let wake: (() => void) | undefined;
    const notice = () => {
      wake?.();
      wake = undefined;
    };
    // Listen before starting: the service may publish before startNewTask returns.
    const subscriptions = [
      deps.worktrees.onDidChangeCreations((creations) => {
        for (const creation of creations) {
          if (creation.worktreePath) paths.set(creation.id, creation.worktreePath);
          if (creation.phase === "failed" && creation.error)
            failures.set(creation.id, creation.error);
          else failures.delete(creation.id);
        }
        notice();
      }),
      deps.worktrees.onDidSettleCreation((settlement) => {
        settled.set(settlement.creationId, settlement);
        notice();
      }),
    ];
    try {
      let started: Awaited<ReturnType<IManagedWorktreeService["startNewTask"]>>;
      try {
        started = await deps.worktrees.startNewTask({
          ...workspaceOf(project),
          projectId: project.projectId,
          ref,
          envelope,
        });
      } catch (error) {
        throw new Error(startErrorSentence(error));
      }
      if (!started.ok) throw new Error(worktreeErrorSentence(started.error));
      const creationId = started.creationId;
      let failure: ManagedWorktreeError | undefined;
      for (;;) {
        const settlement = settled.get(creationId);
        if (settlement?.outcome === "session-started") {
          const worktreePath = paths.get(creationId);
          if (!worktreePath)
            throw new Error(
              "The step's conversation started, but the app didn't say where its worktree is.",
            );
          return { sessionId: settlement.sessionId, worktreePath };
        }
        if (settlement)
          throw new Error(worktreeErrorSentence(failure ?? { code: "session-failed" }));
        const failed = failures.get(creationId);
        if (failed && !failure) {
          failure = failed;
          // Leaving it failed would let "continue without worktree" start the step in the
          // project's own checkout. Dismissing removes what was made; its settlement decides.
          await nextTick();
          try {
            await deps.worktrees.dismissCreation({ creationId });
          } catch {
            throw new Error(
              `${worktreeErrorSentence(failed)} The failed creation was left in the app to retry or dismiss.`,
            );
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
    }
  }

  /** The answer to the turn `commandId` started, read from the end of the transcript. */
  async function replyText(project: OrchestratorProject, sessionId: string, commandId: string) {
    for (const limit of REPLY_WINDOWS) {
      const messages = await deps.agent.readSessionMessages({
        ...workspaceOf(project),
        sessionId,
        limit,
      });
      const reply = replyOfTurn(messages, commandId);
      if (reply !== undefined) return reply;
      if (messages.length < limit) break;
    }
    // The turn's input message is out of reach (an older CLI that keeps no input intent, or a
    // turn further back than the widest window). Without it the reply can't be told apart from
    // the answer to something the person typed later, so no text is better than theirs.
    return "";
  }

  return {
    async cannotOrchestrate(project) {
      if (!deps.isLocalHost || project.workspaceIdentity?.trim())
        return "This project is reached remotely, and orchestration runs only on Git projects on this computer; send the message directly.";
      let refs: Awaited<ReturnType<IManagedWorktreeService["listStartRefs"]>>;
      try {
        refs = await deps.worktrees.listStartRefs({ projectId: project.projectId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return message === "project.not-found"
          ? "The project couldn't be found; reopen it."
          : `The project's repository couldn't be read, so orchestration can't start here: ${message}`;
      }
      if (!refs)
        return "This folder isn't a Git repository, and orchestration gives each step its own worktree; run `git init` and commit, or send the message directly.";
      if (!refs.head)
        return "The repository has no commits yet; make a first commit so each step's worktree has a place to start.";
      if (!(await deps.worktrees.supportsWorktreeCwd(workspaceOf(project))))
        return WORKTREE_ERRORS["unsupported-agent"]!;
      return undefined;
    },

    async agents() {
      const agents = await swarm.listAgents();
      return Promise.all(
        agents.map(async (agent) =>
          snapshotOf(
            agent,
            agent.ready ? await swarm.readAccount(agent.agent)?.catch(() => undefined) : undefined,
          ),
        ),
      );
    },

    ask: (choice, prompt, { cwd, signal }) =>
      swarm.askMember(memberOf(choice), prompt, { cwd, ...(signal ? { signal } : {}) }),

    deliberate: ({ task, cwd, seats, advisors, signal }) =>
      swarm.runDeliberation(
        {
          task,
          cwd,
          members: membersOf(seats),
          // Two rounds, so a merged approach offered in the first can be backed in the second.
          rounds: PARLIAMENT_ROUNDS,
          ...(signal ? { signal } : {}),
          ...(advisors && advisors.length > 0
            ? {
                advisors: advisorsOf(advisors, {
                  openRouter: swarm.askOpenRouter,
                  claude: swarm.askClaudeAdvisor,
                }),
              }
            : {}),
        },
        swarm.askMember,
      ),

    async startExecutor({ project, ref, title, text, choice }) {
      const submission = { modelSelection: await selectionOf(choice), ...EXECUTOR_SUBMISSION };
      const sessionId = `sess_${randomUUID()}`;
      const envelope = envelopeOf(
        "createSession",
        null,
        createPayload(project, sessionId, text, submission),
      );
      const started = await startInNewWorktree(project, ref, envelope);
      lastCommand.set(started.sessionId, envelope.commandId);
      await rename(project, started.sessionId, title);
      return { conversationId: started.sessionId, worktreePath: started.worktreePath };
    },

    async startReviewer({ project, worktreePath, title, text, choice }) {
      if (!deps.isLocalHost || project.workspaceIdentity?.trim())
        throw new Error(WORKTREE_ERRORS["local-only"]);
      if (!(await deps.worktrees.isWorktreeAvailable({ worktreeRoot: worktreePath })))
        throw new Error("The step's worktree is gone, so there is nothing to review.");
      const submission = { modelSelection: await selectionOf(choice), ...REVIEWER_SUBMISSION };
      // The executor works in the project's folder inside the worktree; so does its reviewer.
      const prefix = await git(["rev-parse", "--show-prefix"], project.workspacePath);
      const cwd =
        prefix.code === 0 && prefix.stdout.trim()
          ? resolve(worktreePath, prefix.stdout.trim())
          : worktreePath;
      const task = { ...workspaceOf(project), taskId: `sess_${randomUUID()}` };
      // As the worktree service does: the row with its cwd first, then the host-only command.
      await deps.tasks.reserve({
        task,
        projectId: project.projectId,
        cwd,
        worktreeRoot: worktreePath,
      });
      const envelope = envelopeOf(
        "createSession",
        null,
        createPayload(project, task.taskId, text, submission, cwd),
      );
      let ack: CommandAck;
      try {
        ack = await deps.agent.sendConversationCommandV4({
          ...workspaceOf(project),
          projectId: project.projectId,
          envelope,
          [HOST_WORKTREE_COMMAND]: true,
        });
      } catch (error) {
        throw new Error(
          `The reviewer's conversation couldn't be started: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!accepted(ack)) {
        await deps.tasks.release(task).catch(() => undefined);
        throw new Error(
          `The reviewer's conversation was refused${ack.reasonCode ? ` (${ack.reasonCode})` : ""}.`,
        );
      }
      const conversationId =
        ack.result?.type === "createSession" ? ack.result.sessionId : task.taskId;
      lastCommand.set(conversationId, envelope.commandId);
      await rename(project, conversationId, title);
      return { conversationId };
    },

    async send({ project, conversationId, text }) {
      const envelope = envelopeOf("sendText", conversationId, {
        text,
        requestedDelivery: "queue",
      } satisfies CommandPayloadMap["sendText"]);
      const ack = await deps.agent.sendConversationCommandV4({ ...workspaceOf(project), envelope });
      if (!accepted(ack))
        throw new Error(
          `The conversation didn't take the message${ack.reasonCode ? ` (${ack.reasonCode})` : ""}.`,
        );
      lastCommand.set(conversationId, envelope.commandId);
    },

    async waitForTurn({ project, conversationId, signal }) {
      const commandId = lastCommand.get(conversationId);
      if (!commandId)
        throw new Error(
          "The orchestrator sent this conversation nothing since the app started, so it can't tell which turn to wait for.",
        );
      const session: AppSessionRef = {
        kind: "app",
        ...workspaceOf(project),
        sessionId: conversationId,
      };
      const operation: AppOperationRef = { session, sessionId: conversationId, commandId };
      let lost = "";
      for (let attempt = 0; attempt <= MAX_REOBSERVE; attempt += 1) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const stop = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", stop, { once: true });
        let status: ReturnType<typeof turnEndOf> = undefined;
        try {
          let feed: Awaited<ReturnType<NodeOrchestratorHostDeps["observe"]>>;
          try {
            feed = await deps.observe(operation, controller.signal);
          } catch (error) {
            // Opening fails the same way an open feed is invalidated (the owner restarted).
            signal?.throwIfAborted();
            lost = error instanceof Error ? error.message : String(error);
            continue;
          }
          try {
            // As session-control's waiter does, "unknown" means the observation couldn't
            // recover what happened, not that nothing happened yet: it ends this observation.
            const read = (snapshot: { status: OperationStatus; reason?: string }) => {
              if (snapshot.status === "unknown") {
                lost = snapshot.reason ?? "its outcome is unknown";
                return "lost" as const;
              }
              status = turnEndOf(snapshot.status);
              return status;
            };
            if (!read(feed.initial)) {
              lost = "the observation ended before the turn did";
              for await (const update of feed.updates) {
                if (update.type === "invalidated") {
                  lost = update.reason;
                  break;
                }
                if (read(update.snapshot)) break;
              }
            }
          } finally {
            await feed.close();
          }
        } finally {
          signal?.removeEventListener("abort", stop);
          controller.abort();
        }
        signal?.throwIfAborted();
        if (status) return { status, text: await replyText(project, conversationId, commandId) };
      }
      // Recovery is used up: the turn's outcome can't be read, so it can't count as done.
      return { status: "failed", text: `The turn's outcome could not be read (${lost}).` };
    },

    async interrupt({ project, conversationId }) {
      const envelope = envelopeOf("stop", conversationId, {} satisfies CommandPayloadMap["stop"]);
      const ack = await deps.agent.sendConversationCommandV4({ ...workspaceOf(project), envelope });
      if (ack.status === "failed" || ack.status === "rejected" || ack.status === "stale")
        throw new Error(
          `The conversation couldn't be stopped${ack.reasonCode ? ` (${ack.reasonCode})` : ""}.`,
        );
    },

    git,
  };
}
