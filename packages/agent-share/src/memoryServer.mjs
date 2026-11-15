#!/usr/bin/env node
// Shared memory for every coding agent on this machine, as a stdio MCP server.
// Storage: one Markdown file per memory plus a MEMORY.md index, in ~/.agents/memory
// (XATLAS_MEMORY_DIR overrides). Same layout as Claude Code's auto memory.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MEMORY_DIR = process.env.XATLAS_MEMORY_DIR || join(homedir(), ".agents", "memory");
const INDEX = join(MEMORY_DIR, "MEMORY.md");
const NAME = /^[a-z0-9][a-z0-9-]{0,80}$/;
const TYPES = ["user", "feedback", "project", "reference"];

const tools = [
  {
    name: "memory_list",
    description: "List every shared memory (the MEMORY.md index: one line per memory with its file and a summary).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_read",
    description: "Read one memory by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "kebab-case name from memory_list" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "Find memories whose text contains the query (case-insensitive).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_write",
    description:
      "Create or replace a memory. One fact per memory; for feedback and project memories, follow the fact with **Why:** and **How to apply:** lines.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case, e.g. prefers-small-prs" },
        description: { type: "string", description: "one line, used to decide relevance later" },
        type: { type: "string", enum: TYPES },
        content: { type: "string" },
      },
      required: ["name", "description", "type", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory that turned out to be wrong or obsolete.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

function checkName(name) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("name must be kebab-case (a-z, 0-9, -)");
  return name;
}

async function readIndex() {
  try {
    return await readFile(INDEX, "utf8");
  } catch {
    return "";
  }
}

async function setIndexLine(name, line) {
  const lines = (await readIndex()).split("\n").filter((existing) => existing.trim() && !existing.includes(`](${name}.md)`));
  if (line) lines.push(line);
  await writeFile(INDEX, lines.length ? `${lines.join("\n")}\n` : "");
}

const handlers = {
  async memory_list() {
    const index = await readIndex();
    return index.trim() || "No shared memories yet.";
  },
  async memory_read({ name }) {
    return readFile(join(MEMORY_DIR, `${checkName(name)}.md`), "utf8");
  },
  async memory_search({ query }) {
    const needle = String(query ?? "").toLowerCase();
    if (!needle) throw new Error("query is empty");
    const matches = [];
    for (const file of (await readdir(MEMORY_DIR)).filter((entry) => entry.endsWith(".md")).sort()) {
      const lines = (await readFile(join(MEMORY_DIR, file), "utf8")).split("\n");
      for (const line of lines) {
        if (line.toLowerCase().includes(needle)) matches.push(`${file}: ${line.trim()}`);
        if (matches.length >= 50) break;
      }
    }
    return matches.length ? matches.join("\n") : `Nothing matches "${query}".`;
  },
  async memory_write({ name, description, type, content }) {
    checkName(name);
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
    const summary = String(description ?? "").replace(/\s+/g, " ").trim();
    if (!summary) throw new Error("description is empty");
    const body = `---\nname: ${name}\ndescription: ${JSON.stringify(summary)}\nmetadata:\n  type: ${type}\n  modified: ${new Date().toISOString()}\n---\n\n${String(content ?? "").trim()}\n`;
    await writeFile(join(MEMORY_DIR, `${name}.md`), body);
    await setIndexLine(name, `- [${name}](${name}.md) — ${summary}`);
    return `Saved ${name}.`;
  },
  async memory_delete({ name }) {
    await rm(join(MEMORY_DIR, `${checkName(name)}.md`), { force: true });
    await setIndexLine(name, undefined);
    return `Deleted ${name}.`;
  },
};

function respond(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result })}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notifications
  switch (method) {
    case "initialize":
      return respond(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "xatlas-memory", version: "0.1.0" },
      });
    case "ping":
      return respond(id, {});
    case "tools/list":
      return respond(id, { tools });
    case "tools/call": {
      const handler = handlers[params?.name];
      if (!handler) return respond(id, undefined, { code: -32602, message: `Unknown tool ${params?.name}` });
      try {
        const text = await handler(params?.arguments ?? {});
        return respond(id, { content: [{ type: "text", text }] });
      } catch (error) {
        return respond(id, { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true });
      }
    }
    default:
      return respond(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}

await mkdir(MEMORY_DIR, { recursive: true });
// Handle requests one at a time, in order.
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return respond(null, undefined, { code: -32700, message: "Parse error" });
  }
  queue = queue.then(() => handle(message)).catch(() => {});
});
