import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/memoryServer.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "xatlas-memory-"));
  dirs.push(dir);
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, XATLAS_MEMORY_DIR: dir } });
  const pending = new Map<number, (message: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let id = 0;
  const call = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await call("tools/call", { name, arguments: args })).result;
  return { dir, call, tool, stop: () => child.kill() };
}

describe("shared memory MCP server", () => {
  it("writes, lists, searches, reads and deletes memories", async () => {
    const server = await startServer();
    try {
      const init = await server.call("initialize", { protocolVersion: "2025-06-18" });
      expect(init.result.serverInfo.name).toBe("xatlas-memory");
      expect((await server.call("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toContain("memory_write");

      const saved = await server.tool("memory_write", {
        name: "prefers-small-prs",
        description: "Keep pull requests small",
        type: "feedback",
        content: "One concern per PR.\n**Why:** easier review.",
      });
      expect(saved.content[0].text).toBe("Saved prefers-small-prs.");
      expect((await server.tool("memory_list")).content[0].text).toContain("[prefers-small-prs](prefers-small-prs.md) — Keep pull requests small");
      expect((await server.tool("memory_search", { query: "EASIER" })).content[0].text).toContain("prefers-small-prs.md");
      expect((await server.tool("memory_read", { name: "prefers-small-prs" })).content[0].text).toContain("type: feedback");
      expect((await server.tool("memory_write", { name: "../escape", description: "x", type: "user", content: "x" })).isError).toBe(true);

      await server.tool("memory_delete", { name: "prefers-small-prs" });
      expect(await readFile(join(server.dir, "MEMORY.md"), "utf8")).toBe("");
    } finally {
      server.stop();
    }
  });
});
