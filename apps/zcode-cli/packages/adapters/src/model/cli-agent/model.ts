import {
  getCurrentModelInvocationContext,
  ModelApiOperation,
  modelMessageContentToText,
  type Model,
  type ModelAgentConversation,
  type ModelEvent,
  type ModelId,
  type ModelInputMessage,
  type ModelOptions,
  type ModelOptionSpecs,
  type ModelProperties,
  type ModelProviderId,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
} from "@zcode/contracts";
import { CLI_AGENT_DEFAULT_MODEL, type CliAgentId } from "@zcode/shared/cli-agents";
import { createClaudeDialogue } from "./claude-dialogue.js";
import { createCodexDialogue } from "./codex-dialogue.js";
import {
  buildCliAgentCommand,
  cliAgentAccessForMode,
  cliAgentCanAsk,
  parseCliAgentModelId,
  type CliAgentRun,
} from "./commands.js";
import type { CliAgentDialogue } from "./dialogue.js";
import { decodeCliAgentLine, describeToolUse, toolSubject } from "./events.js";
import { CLAUDE_STAGING_EXCLUDE, excludeFromGit, readCliAgentGitDirs } from "./git.js";
import { runCliAgentProcess, type CliAgentSpawn, type CliAgentStdin } from "./process.js";
import { createCliAgentSessionStore, type CliAgentSessionStore } from "./sessions.js";

/** Earlier turns sent to a CLI that hasn't seen this conversation, newest kept. */
const TRANSCRIPT_MAX_CHARS = 40_000;

/**
 * Side calls that replay the conversation. Their system message is the runtime's own prompt, and
 * what they ask of the CLI is in the last message.
 */
const CONVERSATION_REPLAYS: ReadonlySet<ModelApiOperation | undefined> = new Set([
  ModelApiOperation.ContextCompaction,
  ModelApiOperation.GoalVerification,
  ModelApiOperation.ProjectMemoryDream,
  ModelApiOperation.ProjectMemoryExtract,
]);

export interface CliAgentModelOptions {
  readonly agent: CliAgentId;
  readonly providerId: string;
  readonly modelId: string;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options?: ModelOptions;
  readonly sessions?: CliAgentSessionStore;
  readonly spawn?: CliAgentSpawn;
  readonly env?: NodeJS.ProcessEnv;
}

let defaultSessions: CliAgentSessionStore | undefined;

/** A path inside the project shown from the project's folder, as the person knows it. */
function projectRelative(subject: string | undefined, cwd: string): string | undefined {
  if (!subject) return undefined;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return subject.split(root).join("");
}

/** How each CLI is named on the cards of the calls it makes. */
const CLI_AGENT_NAMES: Record<CliAgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

function conversationTurns(messages: readonly ModelInputMessage[]): ModelInputMessage[] {
  return messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      modelMessageContentToText(message.content).trim().length > 0,
  );
}

function systemContent(messages: readonly ModelInputMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => modelMessageContentToText(message.content).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * The new message, with the transcript when the CLI hasn't seen what came before. A CLI takes
 * one prompt, so `includeSystem` puts the system content at the top of it.
 */
export function buildCliAgentPrompt(
  messages: readonly ModelInputMessage[],
  options: { readonly resuming: boolean; readonly includeSystem?: boolean },
): string {
  const turns = conversationTurns(messages);
  const latest = turns.at(-1);
  if (!latest) throw new Error("There is no message to send to the CLI.");
  const prompt = modelMessageContentToText(latest.content);
  const system = options.includeSystem ? systemContent(messages) : "";
  const earlier = options.resuming ? [] : turns.slice(0, -1);
  if (!system && earlier.length === 0) return prompt;
  const transcript = earlier
    .map((turn) => `${turn.role}: ${modelMessageContentToText(turn.content)}`)
    .join("\n\n")
    .slice(-TRANSCRIPT_MAX_CHARS);
  return [
    ...(system ? [system] : []),
    ...(transcript ? [`Earlier in this conversation:\n\n${transcript}`] : []),
    `The new message:\n\n${prompt}`,
  ].join("\n\n");
}

/** The dialogue for a run that asks; every other run just reads the CLI's output. */
function createDialogue(
  run: CliAgentRun,
  cwd: string,
  conversation: ModelAgentConversation | undefined,
  signal: AbortSignal | undefined,
): CliAgentDialogue | undefined {
  const approve = conversation?.requestToolApproval;
  if (run.access !== "ask" || !approve) return undefined;
  const options = {
    prompt: run.prompt,
    cwd,
    approve,
    ...(run.model ? { model: run.model } : {}),
    ...(run.effort ? { effort: run.effort } : {}),
    ...(run.fast ? { fast: true } : {}),
    ...(run.resumeId ? { resumeId: run.resumeId } : {}),
    ...(signal ? { signal } : {}),
  };
  return run.agent === "claude" ? createClaudeDialogue(options) : createCodexDialogue(options);
}

/** Runs one call in the CLI and turns its events into the runtime's stream. */
async function* streamCliAgent(
  options: CliAgentModelOptions,
  sessions: CliAgentSessionStore,
  request: ModelRequest,
): AsyncGenerator<ModelEvent> {
  const invocation = getCurrentModelInvocationContext();
  const conversation = invocation?.agentConversation;
  // Only the conversation's own turns belong in its CLI session. Titles, commit messages and
  // other side calls run once, read-only, and leave nothing behind.
  const isTurn = invocation?.modelCall?.operation === "agent_step" && conversation !== undefined;
  const sessionKey = isTurn ? `${conversation.sessionId}:${options.agent}` : undefined;
  const resumeId = sessionKey ? await sessions.get(sessionKey) : undefined;
  const canAsk = cliAgentCanAsk(options.agent) && conversation?.requestToolApproval !== undefined;
  // 根因：CLI 只收到一段 prompt，标题等旁路调用的指令在 system 消息里，被滤掉后 CLI 把素材当任务执行。
  // 对话轮次和回放会话的旁路调用不带 system：那是 runtime 自己的提示词，而 CLI 有自己的。
  const includeSystem = !isTurn && !CONVERSATION_REPLAYS.has(invocation?.modelCall?.operation);
  // Effort and fast mode are for the conversation's turns. Side calls (a title, a commit
  // message) share the model id but run at the CLI's own setting: they are small and frequent.
  const choice = parseCliAgentModelId(options.modelId);
  const access = isTurn ? cliAgentAccessForMode(conversation?.mode, { canAsk }) : "read-only";
  const cwd = conversation?.workingDirectory ?? process.cwd();
  // Only an autonomous turn writes to the git directory, so no other run waits on git.
  const git = access === "autonomous" ? await readCliAgentGitDirs(cwd, options.env) : undefined;
  if (git && options.agent === "claude")
    await excludeFromGit(git.commonDir, CLAUDE_STAGING_EXCLUDE);
  const run: CliAgentRun = {
    agent: options.agent,
    ...(choice.model === CLI_AGENT_DEFAULT_MODEL ? {} : { model: choice.model }),
    ...(isTurn && choice.effort ? { effort: choice.effort } : {}),
    ...(isTurn && choice.fast ? { fast: true } : {}),
    access,
    ...(git ? { git } : {}),
    prompt: buildCliAgentPrompt(request.messages, {
      resuming: resumeId !== undefined,
      includeSystem,
    }),
    ...(resumeId ? { resumeId } : {}),
    ...(isTurn ? {} : { ephemeral: true }),
  };
  const dialogue = createDialogue(run, cwd, conversation, request.abortSignal);

  let usage: ModelUsage = {};
  let block: { readonly kind: "text" | "reasoning"; readonly id: string } | undefined;
  let blocks = 0;
  const closeBlock = (): ModelEvent[] => {
    if (!block) return [];
    const event: ModelEvent = {
      type: block.kind === "text" ? "text_end" : "reasoning_end",
      id: block.id,
    };
    block = undefined;
    return [event];
  };
  const switchBlock = (kind: "text" | "reasoning"): ModelEvent[] => {
    if (block?.kind === kind) return [];
    const events = closeBlock();
    block = { kind, id: `cli-${kind}-${(blocks += 1)}` };
    events.push({ type: kind === "text" ? "text_start" : "reasoning_start", id: block.id });
    return events;
  };

  yield { type: "start" };
  let wroteText = false;
  // Calls shown as cards, by id: a result is only sent for a card that was opened.
  const cards = new Map<string, string>();
  let sawCards = false;
  const lines = runCliAgentProcess(
    buildCliAgentCommand(run),
    {
      cwd,
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(dialogue ? { onStdin: (stdin: CliAgentStdin) => dialogue.begin(stdin) } : {}),
    },
    options.spawn,
  );
  try {
    for await (const line of lines) {
      for (const event of dialogue?.read(line) ?? decodeCliAgentLine(options.agent, line)) {
        switch (event.type) {
          case "session":
            if (sessionKey) await sessions.set(sessionKey, event.id);
            break;
          case "usage":
            usage = event.usage;
            break;
          case "error":
            throw new Error(event.message);
          case "tool_call":
            // Only a conversation's turn shows cards; side calls stream nothing the person sees.
            if (!isTurn) {
              yield* switchBlock("reasoning");
              yield {
                type: "reasoning_delta",
                id: block!.id,
                text: `${describeToolUse(event.name, event.input)}\n`,
              };
              break;
            }
            if (cards.has(event.id)) break;
            cards.set(event.id, event.name);
            sawCards = true;
            // The text or thinking before the call is its own round.
            yield* closeBlock();
            yield {
              type: "tool_call",
              toolCall: {
                id: event.id,
                name: event.name,
                input: event.input,
                providerExecuted: true,
                executor: { name: CLI_AGENT_NAMES[options.agent], subject: projectRelative(toolSubject(event.input), cwd) },
              },
            };
            break;
          case "tool_result": {
            const name = cards.get(event.id);
            if (name === undefined) break;
            cards.delete(event.id);
            yield {
              type: "provider_tool_result",
              toolCallId: event.id,
              toolName: name,
              output: event.output,
              isError: event.isError,
            };
            break;
          }
          case "thinking":
          case "activity":
            yield* switchBlock("reasoning");
            yield {
              type: "reasoning_delta",
              id: block!.id,
              text: event.type === "activity" ? `${event.text}\n` : event.text,
            };
            break;
          case "reply":
            if (wroteText) break;
          // falls through
          case "message":
          case "text":
            yield* switchBlock("text");
            yield {
              type: "text_delta",
              id: block!.id,
              // Whole messages arrive one after another, with nothing to separate them.
              text: event.type === "message" && wroteText ? `\n\n${event.text}` : event.text,
            };
            wroteText = true;
            break;
        }
      }
    }
  } finally {
    // An approval still open has to close before the turn ends, whatever ended it.
    await dialogue?.end();
  }
  yield* closeBlock();
  // A turn that ended on its tool calls has said what it did through them.
  if (!wroteText && !sawCards)
    throw new Error("The CLI finished without a reply.");
  yield { type: "finish", finishReason: "stop", usage };
}

/**
 * A conversation model that is really a coding CLI: the CLI runs its own agent loop and
 * tools, and the runtime sees one assistant reply for each turn.
 */
export function createCliAgentModel(options: CliAgentModelOptions): Model {
  const sessions = options.sessions ?? (defaultSessions ??= createCliAgentSessionStore());
  const model: Model = {
    providerId: options.providerId as ModelProviderId,
    modelId: options.modelId as ModelId,
    properties: options.properties,
    optionSpecs: options.optionSpecs,
    options: options.options ?? {},
    bind(next) {
      return createCliAgentModel({ ...options, options: { ...options.options, ...next } });
    },
    streamText(request) {
      return streamCliAgent(options, sessions, request);
    },
    async generateText(request): Promise<ModelResult> {
      let text = "";
      let usage: ModelUsage = {};
      for await (const event of streamCliAgent(options, sessions, request)) {
        if (event.type === "text_delta") text += event.text;
        if (event.type === "finish") usage = event.usage;
      }
      return { text, finishReason: "stop", usage };
    },
  };
  return Object.freeze(model);
}
