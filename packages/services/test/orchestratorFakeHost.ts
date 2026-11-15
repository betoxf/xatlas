import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSnapshot, ModelChoice } from "@zcode/orchestrator/types";
import { createGitRunner } from "@zcode/orchestrator/worktrees";
import type { SwarmResult } from "@zcode/swarm/types";
import type { OrchestratorHost } from "../src/orchestrator/host.js";

/**
 * A fake of the orchestrator's host port for tests: it records every call, makes real
 * detached worktrees in a real temporary repository (as the app's worktree service does), and
 * plays each conversation's turns from a script.
 */

export const git = createGitRunner();

export async function gitOk(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one commit. */
export async function makeRepo(files: Record<string, string> = { "README.md": "hello\n" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xatlas-loop-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  await gitOk(["init", "-q", "-b", "main"], repo);
  await gitOk(["config", "user.name", "Test"], repo);
  await gitOk(["config", "user.email", "test@example.com"], repo);
  await gitOk(["config", "commit.gpgsign", "false"], repo);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await gitOk(["add", "-A"], repo);
  await gitOk(["commit", "-q", "-m", "initial"], repo);
  return { root, repo, dataDir: join(root, "data") };
}

export interface FakeTurn {
  readonly status?: "completed" | "failed" | "needs_attention";
  readonly text: string;
}

export interface Conversation {
  readonly id: string;
  readonly kind: "executor" | "reviewer";
  readonly title: string;
  readonly choice: ModelChoice;
  readonly worktreePath: string;
  readonly ref: string | null;
  /** The messages delivered, in order. */
  readonly messages: string[];
  turns: number;
  /** Messages sent while a turn ran or waited on a question, not delivered yet. */
  readonly inbox: Array<{ readonly text: string; readonly done: (turn: FakeTurn) => void }>;
  running: boolean;
  /** The last turn ended asking something: what is sent now waits until it is answered. */
  waiting: boolean;
  /** The turn of the last message sent (or of the answer given in the app). */
  last: Promise<FakeTurn>;
}

export interface TurnContext {
  readonly conversation: Conversation;
  /** The message this turn answers. */
  readonly message: string;
  /** 0 for the first message. */
  readonly index: number;
  /** The trailer lines the executor's brief asked for. */
  readonly trailers: readonly string[];
  /** Writes files and commits them, with the run's trailers unless `trailers` is false. */
  commit(
    files: Record<string, string>,
    options?: { readonly message?: string; readonly trailers?: boolean },
  ): Promise<string>;
  write(files: Record<string, string>): Promise<void>;
}

export type Script = (context: TurnContext) => FakeTurn | Promise<FakeTurn>;

export interface FakeHostOptions {
  readonly repo: string;
  readonly ask?: (choice: ModelChoice, prompt: string) => string | Promise<string>;
  readonly deliberate?: (
    input: Parameters<OrchestratorHost["deliberate"]>[0],
  ) => SwarmResult | Promise<SwarmResult>;
  readonly executor?: Script;
  readonly reviewer?: Script;
  readonly cannotOrchestrate?: string;
  readonly agents?: readonly AgentSnapshot[];
  readonly startExecutor?: (
    input: Parameters<OrchestratorHost["startExecutor"]>[0],
  ) => void | Promise<void>;
  /** A reviewer echoes the token its message asks for, as a model that follows it does (default). */
  readonly echoToken?: boolean;
  /** Like the app after a restart: it can't see turns of conversations it did not start. */
  readonly knows?: (conversationId: string) => boolean;
  /** Runs before each of the host's git commands (not the test's own). */
  readonly gitHook?: (args: readonly string[], cwd: string) => void | Promise<void>;
  /** Runs before a message is taken; throwing refuses it. */
  readonly send?: (input: Parameters<OrchestratorHost["send"]>[0]) => void | Promise<void>;
  readonly startReviewer?: (
    input: Parameters<OrchestratorHost["startReviewer"]>[0],
  ) => void | Promise<void>;
  /** Runs before a stop; throwing refuses it. */
  readonly interrupt?: (
    input: Parameters<OrchestratorHost["interrupt"]>[0],
  ) => void | Promise<void>;
}

export interface Call {
  readonly method: string;
  readonly [key: string]: unknown;
}

export const AGENTS: readonly AgentSnapshot[] = [
  { agent: "claude", ready: true, limits: "none", windows: [] },
  { agent: "codex", ready: true, limits: "none", windows: [] },
];

/** What a prompt asks for, from the engines' own wording. */
export function promptKind(prompt: string): string {
  if (prompt.includes("Decide how this app should handle")) return "triage";
  if (prompt.includes("Write the plan for the job")) return "plan";
  if (prompt.includes("You divide a plan into steps")) return "division";
  if (prompt.includes("Every step has passed its review")) return "final-read";
  if (prompt.includes("You chair a job")) return "chair";
  if (prompt.includes("You watch one coding agent")) return "watcher";
  return "other";
}

/** Resolves when `check` holds, polling (tests only: the loop itself never polls). */
export async function until<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  what = "the condition",
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function createFakeHost(options: FakeHostOptions) {
  const calls: Call[] = [];
  const conversations = new Map<string, Conversation>();
  let counter = 0;
  const pendingForever: Array<(error: Error) => void> = [];

  function trailersOf(conversation: Conversation): string[] {
    const first = conversation.messages[0] ?? "";
    return first.split("\n").filter((line) => /^Xatlas-[A-Za-z]+: /.test(line));
  }

  function context(conversation: Conversation, message: string, index: number): TurnContext {
    const cwd = conversation.worktreePath;
    const write = async (files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), text);
      }
    };
    return {
      conversation,
      message,
      index,
      trailers: trailersOf(conversation),
      write,
      async commit(files, commitOptions = {}) {
        await write(files);
        await gitOk(["add", "-A"], cwd);
        const subject = commitOptions.message ?? `Work on ${conversation.title}`;
        const body =
          commitOptions.trailers === false
            ? subject
            : `${subject}\n\n${trailersOf(conversation).join("\n")}`;
        await gitOk(["commit", "-q", "-m", body], cwd);
        return gitOk(["rev-parse", "HEAD"], cwd);
      },
    };
  }

  async function onBranch(cwd: string): Promise<void> {
    // The app's agent starts working at once; waiting for the branch keeps the test's commits
    // after the loop's adopt, as they are in practice (an agent takes longer than a few git calls).
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await git(["symbolic-ref", "-q", "HEAD"], cwd)).code === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function settle(): { promise: Promise<FakeTurn>; done: (turn: FakeTurn) => void } {
    let done!: (turn: FakeTurn) => void;
    const promise = new Promise<FakeTurn>((resolve) => {
      done = resolve;
    });
    return { promise, done };
  }

  /** Runs one turn for a delivered message; then the next queued one, unless it asks something. */
  function run(conversation: Conversation, text: string, done: (turn: FakeTurn) => void): void {
    conversation.running = true;
    conversation.messages.push(text);
    const index = conversation.messages.length - 1;
    const script = conversation.kind === "executor" ? options.executor : options.reviewer;
    void (async () => {
      if (conversation.kind === "executor" && index === 0) {
        await onBranch(conversation.worktreePath);
      }
      const played = script
        ? await script(context(conversation, text, index))
        : {
            text:
              conversation.kind === "executor" ? "Done." : '{"verdict": "pass", "findings": []}',
          };
      const turn =
        conversation.kind === "reviewer" && options.echoToken !== false
          ? echoToken(played, text)
          : played;
      conversation.turns += 1;
      conversation.running = false;
      conversation.waiting = turn.status === "needs_attention";
      done(turn);
      const next = conversation.waiting ? undefined : conversation.inbox.shift();
      if (next) run(conversation, next.text, next.done);
    })().catch((error: unknown) => {
      conversation.running = false;
      done({ status: "failed", text: String(error) });
    });
  }

  /**
   * As the app's `sendText` with queued delivery: a message waits while a turn runs, and while
   * the last turn waits on a question it stays queued until the question is answered.
   */
  function play(conversation: Conversation, text: string): void {
    const turn = settle();
    conversation.last = turn.promise;
    if (conversation.running || conversation.waiting)
      conversation.inbox.push({ text, done: turn.done });
    else run(conversation, text, turn.done);
  }

  /** The person answers the waiting question in the app: the same turn goes on with the answer. */
  function answer(conversationId: string, text: string): void {
    const conversation = conversations.get(conversationId);
    if (!conversation?.waiting) throw new Error(`${conversationId} is not waiting on a question`);
    conversation.waiting = false;
    const turn = settle();
    conversation.last = turn.promise;
    run(conversation, text, turn.done);
  }

  function newConversation(
    fields: Pick<Conversation, "id" | "kind" | "title" | "choice" | "worktreePath" | "ref">,
  ): Conversation {
    return {
      ...fields,
      messages: [],
      turns: 0,
      inbox: [],
      running: false,
      waiting: false,
      last: Promise.resolve({ text: "" }),
    };
  }

  const hostGit: typeof git = async (args, cwd) => {
    await options.gitHook?.(args, cwd);
    return git(args, cwd);
  };

  const host: OrchestratorHost = {
    async cannotOrchestrate(project) {
      calls.push({ method: "cannotOrchestrate", project });
      return options.cannotOrchestrate;
    },
    async agents() {
      return options.agents ?? AGENTS;
    },
    async ask(choice, prompt, askOptions) {
      calls.push({ method: "ask", choice, prompt, kind: promptKind(prompt), cwd: askOptions.cwd });
      if (!options.ask) throw new Error("no model in this test");
      const signal = askOptions.signal;
      const answer = Promise.resolve(options.ask(choice, prompt));
      if (!signal) return answer;
      return Promise.race([
        answer,
        new Promise<string>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    },
    async deliberate(input) {
      calls.push({ method: "deliberate", ...input });
      if (!options.deliberate) throw new Error("no parliament in this test");
      return options.deliberate(input);
    },
    async startExecutor(input) {
      calls.push({ method: "startExecutor", ...input });
      await options.startExecutor?.(input);
      counter += 1;
      const id = `exec-${counter}`;
      const worktreePath = join(dirname(options.repo), "worktrees", id);
      await mkdir(dirname(worktreePath), { recursive: true });
      await gitOk(
        ["worktree", "add", "-q", "--detach", worktreePath, input.ref ?? "HEAD"],
        options.repo,
      );
      const conversation = newConversation({
        id,
        kind: "executor",
        title: input.title,
        choice: input.choice,
        worktreePath,
        ref: input.ref,
      });
      conversations.set(id, conversation);
      play(conversation, input.text);
      return { conversationId: id, worktreePath };
    },
    async startReviewer(input) {
      calls.push({ method: "startReviewer", ...input });
      counter += 1;
      const id = `review-${counter}`;
      await options.startReviewer?.(input);
      const conversation = newConversation({
        id,
        kind: "reviewer",
        title: input.title,
        choice: input.choice,
        worktreePath: input.worktreePath,
        ref: null,
      });
      conversations.set(id, conversation);
      play(conversation, input.text);
      return { conversationId: id };
    },
    async send(input) {
      await options.send?.(input);
      calls.push({ method: "send", conversationId: input.conversationId, text: input.text });
      const conversation = conversations.get(input.conversationId);
      if (!conversation) throw new Error(`no conversation ${input.conversationId}`);
      play(conversation, input.text);
    },
    async waitForTurn(input) {
      calls.push({ method: "waitForTurn", conversationId: input.conversationId });
      const conversation = conversations.get(input.conversationId);
      if (!conversation || (options.knows && !options.knows(input.conversationId))) {
        // As the real host after a restart: this turn is never seen.
        return new Promise((_, reject) => {
          pendingForever.push(reject);
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
      }
      const turn = await conversation.last;
      return { status: turn.status ?? "completed", text: turn.text };
    },
    async interrupt(input) {
      calls.push({ method: "interrupt", conversationId: input.conversationId });
      await options.interrupt?.(input);
    },
    git: hostGit,
  };

  return {
    host,
    calls,
    conversations,
    answer,
    of: (method: string) => calls.filter((call) => call.method === method),
  };
}

/** Puts the `reply` token the message asked for into a JSON reply. */
function echoToken(turn: FakeTurn, message: string): FakeTurn {
  const token = /"reply": "([^"]+)"/.exec(message)?.[1];
  if (!token) return turn;
  try {
    const value: unknown = JSON.parse(turn.text);
    if (typeof value !== "object" || value === null) return turn;
    return { ...turn, text: JSON.stringify({ ...value, reply: token }) };
  } catch {
    return turn;
  }
}

/** Reviewer reply helpers. */
export const pass = (): FakeTurn => ({ text: '{"verdict": "pass", "findings": []}' });
export const findings = (
  items: ReadonlyArray<{ severity?: string; text: string; file?: string; repeats?: string }>,
): FakeTurn => ({
  text: JSON.stringify({
    verdict: "findings",
    findings: items.map((item) => ({ severity: "blocker", ...item })),
  }),
});

/** The review round a reviewer's message asks for. */
export function roundOf(message: string): number {
  return Number(/review round (\d+) of/.exec(message)?.[1] ?? "0");
}
