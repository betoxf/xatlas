import { randomUUID } from "node:crypto";
import { askMember, listAvailableAgents, MAX_ROUNDS, runDeliberation, runSwarm, withAccountModels, type AskMember, type SwarmEvent, type SwarmResult } from "@zcode/swarm";
import type { ISwarmService, SwarmRunSnapshot } from "./swarm.js";

interface Run {
  status: SwarmRunSnapshot["status"];
  readonly events: SwarmEvent[];
  result?: SwarmResult;
  error?: string;
  readonly controller: AbortController;
  finishedAt?: number;
}

/** Finished runs are kept this long for the UI to read, then dropped. */
const KEEP_FINISHED_MS = 60 * 60_000;

export function createSwarmService(dependencies: { ask?: AskMember; listAgents?: typeof listAvailableAgents } = {}): ISwarmService {
  const runs = new Map<string, Run>();
  const ask = dependencies.ask ?? askMember;

  function prune() {
    const now = Date.now();
    for (const [id, run] of runs) if (run.finishedAt && now - run.finishedAt > KEEP_FINISHED_MS) runs.delete(id);
  }

  return {
    listAgents: async () => withAccountModels(await (dependencies.listAgents ?? listAvailableAgents)()),
    async start({ workspacePath, task, members, rounds, mode }) {
      prune();
      const runId = randomUUID();
      const run: Run = { status: "running", events: [], controller: new AbortController() };
      runs.set(runId, run);
      void (mode === "deliberate" ? runDeliberation : runSwarm)(
        { task, cwd: workspacePath, members, rounds: Math.max(0, Math.min(MAX_ROUNDS, Math.round(rounds))), signal: run.controller.signal },
        ask,
        (event) => run.events.push(event),
      )
        .then((result) => {
          if (run.status === "running") run.status = "done";
          run.result = result;
        })
        .catch((error: unknown) => {
          if (run.status === "running") run.status = "failed";
          run.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          run.finishedAt = Date.now();
        });
      return { runId };
    },
    async getRun({ runId, sinceEvent = 0 }) {
      const run = runs.get(runId);
      if (!run) throw new Error("This swarm run is no longer available.");
      return {
        runId,
        status: run.status,
        events: run.events.slice(sinceEvent),
        eventCount: run.events.length,
        ...(run.result ? { result: run.result } : {}),
        ...(run.error ? { error: run.error } : {}),
      };
    },
    async cancel({ runId }) {
      const run = runs.get(runId);
      if (!run || run.status !== "running") return;
      run.status = "cancelled";
      run.controller.abort();
    },
  };
}
