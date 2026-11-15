import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerPath, openLedger, openProject } from "../../src/tasks/index.js";
import { deadPid, plantLock } from "./fixtures/locks.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const worker = join(here, "fixtures", "ledgerWorker.ts");
const projectKey = "/work/xatlas";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "xatlas-ledger-concurrency-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

interface Worker {
  readonly ready: Promise<void>;
  go(): void;
  readonly done: Promise<string>;
}

/** A Node process running the worker fixture through tsx, held until `go`. */
function startWorker(args: readonly string[]): Worker {
  const child = spawn(process.execPath, ["--import", "tsx", worker, dataDir, projectKey, ...args], {
    cwd: repoRoot,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const ready = new Promise<void>((resolveReady, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.startsWith("ready\n")) resolveReady();
    });
    child.on("exit", () => reject(new Error(`worker exited before ready: ${stderr}`)));
  });
  const done = new Promise<string>((resolveDone, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolveDone(stdout.slice("ready\n".length).trim());
      else reject(new Error(`worker exited with ${code}: ${stderr}`));
    });
  });
  // Unhandled once the worker is past ready; `done` reports how it ended.
  ready.catch(() => undefined);
  return { ready, go: () => child.stdin.end("go\n"), done };
}

/** Starts every worker, waits until all are loaded, then lets them go at the same moment. */
async function runTogether(workers: readonly Worker[]): Promise<string[]> {
  await Promise.all(workers.map((one) => one.ready));
  for (const one of workers) one.go();
  return Promise.all(workers.map((one) => one.done));
}

function expectGapless(seqs: readonly number[], count: number): void {
  expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
}

describe("ledger concurrency", () => {
  it("gives gapless seq to many appends at once in one process, across two ledger handles", async () => {
    const first = openLedger({ dataDir });
    const second = openLedger({ dataDir });
    const written = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        (index % 2 ? first : second).append(projectKey, {
          kind: "note",
          data: { from: "test", text: `note ${index}` },
        }),
      ),
    );

    expectGapless(
      written.map((entry) => entry.seq),
      60,
    );
    const read = await first.read(projectKey);
    expect(read.map((entry) => entry.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(new Set(read.map((entry) => entry.id)).size).toBe(60);
  });

  it("gives gapless seq to appends from several processes at once", async () => {
    const workers = Array.from({ length: 5 }, (_, index) =>
      startWorker(["notes", "20", `w${index}`]),
    );
    const results = await runTogether(workers);

    const seqs = results.flatMap((line) => JSON.parse(line) as number[]);
    expectGapless(seqs, 100);
    const read = await openLedger({ dataDir }).read(projectKey);
    expect(read.map((entry) => entry.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    // Each worker's own notes stay in its order.
    for (let index = 0; index < 5; index += 1) {
      const texts = read.flatMap((entry) =>
        entry.kind === "note" && entry.data.from === `w${index}` ? [entry.data.text] : [],
      );
      expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => `note ${i}`));
    }
    expect(existsSync(`${ledgerPath(dataDir, projectKey)}.lock`)).toBe(false);
  }, 60_000);

  it("lets several processes take over one dead owner's lock without losing a write", async () => {
    const file = ledgerPath(dataDir, projectKey);
    await plantLock(`${file}.lock`, deadPid(), "crashed-writer");

    const workers = Array.from({ length: 4 }, (_, index) =>
      startWorker(["notes", "15", `w${index}`]),
    );
    const results = await runTogether(workers);

    expectGapless(
      results.flatMap((line) => JSON.parse(line) as number[]),
      60,
    );
    expect(existsSync(`${file}.lock`)).toBe(false);
    // Nothing is left beside the ledger: no lock, no private folders.
    expect(await readdir(dirname(file))).toEqual([basename(file)]);
  }, 60_000);

  it("gives one winner when processes make the same move at once", async () => {
    const project = openProject(openLedger({ dataDir }), projectKey);
    const task = await project.createTask({ title: "Add dark mode", brief: "…", route: "direct" });
    await project.moveTask(task.id, "planned");
    const bytes = (await readFile(ledgerPath(dataDir, projectKey))).length;

    const workers = Array.from({ length: 4 }, () => startWorker(["move", task.id, "working"]));
    const results = await runTogether(workers);

    expect(results.filter((result) => result === "won")).toHaveLength(1);
    expect(results.filter((result) => result === "lost:illegal-move")).toHaveLength(3);
    const entries = await openLedger({ dataDir }).read(projectKey);
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({
      kind: "task.moved",
      data: { from: "planned", to: "working" },
    });
    expect((await readFile(ledgerPath(dataDir, projectKey))).length).toBeGreaterThan(bytes);
    expect((await project.state()).tasks[0]!.state).toBe("working");
  }, 60_000);
});
