import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Effort } from "./types.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** The Keychain item the user's other tools already keep the key in. */
const KEYCHAIN_ITEM = "openrouter-api-key";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * OpenRouter's key: `OPENROUTER_API_KEY`, or on a Mac the Keychain item "openrouter-api-key".
 * It is read into memory only: never an argument, a log line or part of an error.
 */
export async function readOpenRouterKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnv = env["OPENROUTER_API_KEY"]?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await promisify(execFile)(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_ITEM, "-w"],
      { timeout: 10_000, env },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface OpenRouterAsk {
  /** OpenRouter's model id, e.g. "google/gemini-4-argon". */
  readonly model: string;
  readonly effort?: Effort;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Tests pass their own. */
  readonly fetch?: typeof fetch;
  readonly readKey?: () => Promise<string | undefined>;
}

/** OpenRouter's reasoning levels stop at "high". */
const REASONING: Record<Effort, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/**
 * Asks one model through OpenRouter and returns its answer. The model gets the prompt and
 * nothing else: no repository, no tools, and no header naming the app or the project.
 */
export async function askOpenRouter(prompt: string, options: OpenRouterAsk): Promise<string> {
  const key = await (options.readKey ?? readOpenRouterKey)();
  if (!key) {
    throw new Error(
      `No OpenRouter key: set OPENROUTER_API_KEY or add the Keychain item "${KEYCHAIN_ITEM}".`,
    );
  }
  /** An error's text with the key taken out, in case a server or proxy echoes it. */
  const clean = (text: string) => text.split(key).join("…").slice(0, 300);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: prompt }],
        ...(options.effort ? { reasoning: { effort: REASONING[options.effort] } } : {}),
      }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(
      `OpenRouter could not be reached: ${clean(error instanceof Error ? error.message : String(error))}`,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The body is read after the headers arrive and can fail on its own; its error gets the same cleaning.
    if (options.signal?.aborted) throw error;
    throw new Error(
      `OpenRouter's answer could not be read: ${clean(error instanceof Error ? error.message : String(error))}`,
    );
  }
  let body: {
    error?: { message?: unknown };
    choices?: Array<{ message?: { content?: unknown } }>;
  } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // Not JSON: the status line below says what happened.
  }
  if (!response.ok || body.error) {
    const said = typeof body.error?.message === "string" ? body.error.message : text;
    throw new Error(`OpenRouter answered ${response.status} for ${options.model}: ${clean(said)}`);
  }
  const content = body.choices?.[0]?.message?.content;
  const answer =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
        : "";
  if (!answer.trim()) throw new Error(`OpenRouter gave no answer from ${options.model}.`);
  return answer.trim();
}
