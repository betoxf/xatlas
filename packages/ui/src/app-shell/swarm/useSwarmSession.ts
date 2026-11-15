import { useCallback, useEffect, useMemo, useState } from "react";
import type { AvailableAgent, SwarmMember } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { makeMember } from "./SwarmSetup.js";
import { EMPTY_SWARM_SESSION, useSwarmStore, type SwarmSession } from "./swarmStore.js";

const POLL_MS = 1000;
let cachedAgents: Promise<readonly AvailableAgent[]> | null = null;

/** The agent CLIs on this machine, checked once per app session. */
export function useSwarmAgents() {
  // Optional: the composer also renders without a host (tests, the web share view).
  const swarmService = useOptionalServices()?.swarmService;
  const [agents, setAgents] = useState<readonly AvailableAgent[] | null>(null);
  useEffect(() => {
    if (!swarmService) return;
    let cancelled = false;
    cachedAgents ??= swarmService.listAgents().catch(() => {
      cachedAgents = null;
      return [];
    });
    void cachedAgents.then((list) => !cancelled && setAgents(list));
    return () => {
      cancelled = true;
    };
  }, [swarmService]);
  return agents;
}

/** Every signed-in Claude Code and Codex, on their default models. */
export function defaultSwarmMembers(agents: readonly AvailableAgent[] | null): SwarmMember[] {
  return (agents ?? [])
    .filter((agent) => agent.ready && (agent.agent === "claude" || agent.agent === "codex"))
    .map((agent) => makeMember(agent.agent));
}

/** A workspace's swarm state and actions; `poll` follows a running swarm live. */
export function useSwarmSession(key: string, options: { poll?: boolean } = {}) {
  // Optional: the composer also renders without a host (tests, the web share view).
  const swarmService = useOptionalServices()?.swarmService;
  const session: SwarmSession = useSwarmStore((state) => state.sessions[key]) ?? EMPTY_SWARM_SESSION;
  const update = useSwarmStore((state) => state.update);
  const agents = useSwarmAgents();
  const members = useMemo(() => session.members ?? defaultSwarmMembers(agents), [agents, session.members]);

  const runId = session.run?.status === "running" ? session.run.runId : null;
  useEffect(() => {
    if (!options.poll || !swarmService || !runId) return;
    let stopped = false;
    const poll = async () => {
      const since = useSwarmStore.getState().sessions[key]?.run?.events.length ?? 0;
      try {
        const snapshot = await swarmService.getRun({ runId, sinceEvent: since });
        if (stopped) return;
        update(key, (current) =>
          current.run?.runId !== runId
            ? current
            : {
                ...current,
                run: {
                  ...current.run,
                  status: current.run.status === "cancelled" ? "cancelled" : snapshot.status,
                  events: [...current.run.events, ...snapshot.events],
                  ...(snapshot.result ? { result: snapshot.result } : {}),
                  ...(snapshot.error ? { error: snapshot.error } : {}),
                },
              },
        );
      } catch (error) {
        if (!stopped) {
          // A run the service no longer has (the app restarted) is just gone.
          update(key, (current) => {
            if (current.run?.runId !== runId) return current;
            if (current.run.events.length === 0) {
              const { run: _run, ...rest } = current;
              return rest;
            }
            return { ...current, run: { ...current.run, status: "failed", error: String(error) } };
          });
        }
      }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, options.poll, runId, swarmService, update]);

  const start = useCallback(
    async (task: string, workspacePath: string) => {
      if (!swarmService) throw new Error("Swarm needs the desktop app.");
      const { runId: id } = await swarmService.start({ workspacePath, task, members, rounds: session.rounds });
      update(key, (current) => ({ ...current, run: { runId: id, task, members, status: "running", events: [] } }));
    },
    [key, members, session.rounds, swarmService, update],
  );

  const cancel = useCallback(async () => {
    const run = useSwarmStore.getState().sessions[key]?.run;
    if (!swarmService || run?.status !== "running") return;
    await swarmService.cancel({ runId: run.runId });
    update(key, (current) => (current.run ? { ...current, run: { ...current.run, status: "cancelled" } } : current));
  }, [key, swarmService, update]);

  return {
    supported: Boolean(swarmService),
    agents,
    session,
    members,
    /** Two or more members, so sending can start a swarm. */
    ready: Boolean(swarmService) && members.length >= 2,
    setActive: (active: boolean) => update(key, (current) => ({ ...current, active })),
    setMembers: (next: SwarmMember[]) => update(key, (current) => ({ ...current, members: next })),
    setRounds: (rounds: number) => update(key, (current) => ({ ...current, rounds })),
    dismiss: () => update(key, (current) => {
      const { run: _run, ...rest } = current;
      return rest;
    }),
    start,
    cancel,
  };
}
