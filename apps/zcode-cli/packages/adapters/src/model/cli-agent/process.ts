import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { terminateMcpStdioProcessTree } from "../../mcp/process-tree.js";
import type { CliAgentCommand } from "./commands.js";

const STDERR_TAIL_CHARS = 2_000;
const LOGIN_PATH_TIMEOUT_MS = 10_000;

export interface CliAgentProcessOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  /** Keeps stdin open and hands it over, for a run that answers the CLI as it goes. */
  readonly onStdin?: (stdin: CliAgentStdin) => void;
}

/** A write after the CLI has gone is the exit status's to report. */
export interface CliAgentStdin {
  writeLine(message: unknown): void;
  end(): void;
}

export type CliAgentSpawn = (
  command: CliAgentCommand,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

let loginPath: Promise<string | undefined> | undefined;

/**
 * The PATH of the user's login shell. An app started from the Dock gets a minimal PATH, and
 * CLIs that are Node scripts need the `node` the terminal finds.
 */
function resolveLoginPath(home: string | undefined): Promise<string | undefined> {
  loginPath ??= new Promise((resolve) => {
    execFile(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", "printf '%s' \"$PATH\""],
      {
        timeout: LOGIN_PATH_TIMEOUT_MS,
        env: home ? { ...process.env, HOME: home } : process.env,
      },
      (error, stdout) =>
        resolve(error ? undefined : stdout.trim().split("\n").pop()?.trim() || undefined),
    );
  });
  return loginPath;
}

/** The environment the user's terminal would give the CLI. */
async function cliAgentEnv(): Promise<NodeJS.ProcessEnv> {
  // The sign-ins live under the real home; the sandboxed dev app moves HOME.
  const home = process.env.XATLAS_GH_HOME?.trim() || undefined;
  const path = await resolveLoginPath(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(home ? { HOME: home } : {}),
    ...(path ? { PATH: path } : {}),
  };
  // Claude Code refuses to nest inside itself when xatlas was started from it.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

const defaultSpawn: CliAgentSpawn = (command, options) =>
  spawn(command.command, [...command.args], { ...options, stdio: ["pipe", "pipe", "pipe"] });

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Runs a CLI and yields its JSON lines; a failed exit throws with what it printed. */
export async function* runCliAgentProcess(
  command: CliAgentCommand,
  options: CliAgentProcessOptions,
  spawnProcess: CliAgentSpawn = defaultSpawn,
): AsyncGenerator<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const env = options.env ?? (await cliAgentEnv());
  const child = spawnProcess(command, { cwd: options.cwd, env });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // A broken pipe here is the exit status's to report.
  child.stdin.on("error", () => {});
  if (options.onStdin) {
    options.onStdin({
      writeLine(message) {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      end: () => child.stdin.end(),
    });
  } else {
    child.stdin.end(command.stdin ?? "");
  }

  const lines = createInterface({ input: child.stdout });
  const stop = () => {
    // The commands the CLI started go too, or a stopped turn leaves them running.
    if (child.pid) void terminateMcpStdioProcessTree(child.pid).catch(() => child.kill("SIGKILL"));
    lines.close();
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  try {
    for await (const text of lines) {
      const line = parseLine(text);
      if (line) yield line;
    }
    const code = await exited;
    options.signal?.throwIfAborted();
    if (code !== 0) {
      const detail = stderr.trim();
      throw new Error(
        `${command.command} exited with ${code ?? "a signal"}${detail ? `: ${detail}` : ""}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${command.command} isn't installed, or isn't on your PATH.`);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stop);
    // Leaving the stream early (a reported error) must not leave the CLI running.
    if (child.exitCode === null && child.signalCode === null) stop();
    lines.close();
  }
}
