import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Which CLI session continues which conversation. */
export interface CliAgentSessionStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, id: string): Promise<void>;
}

function defaultStorePath(): string {
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(base, ".zcode", "v2", "cli-agent-sessions.json");
}

export function createCliAgentSessionStore(
  filePath: string = defaultStorePath(),
): CliAgentSessionStore {
  let sessions: Promise<Record<string, string>> | undefined;
  let writes: Promise<void> = Promise.resolve();

  const load = () =>
    (sessions ??= readFile(filePath, "utf8")
      .then((text) => JSON.parse(text) as Record<string, string>)
      // None yet, or unreadable: conversations start fresh in the CLI.
      .catch((): Record<string, string> => ({})));

  return {
    async get(key) {
      return (await load())[key];
    },
    async set(key, id) {
      const current = await load();
      if (current[key] === id) return;
      current[key] = id;
      const write = writes.then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
        await rename(temporary, filePath);
      });
      writes = write.catch(() => {});
      await write;
    },
  };
}
