import { create } from "zustand";
import type { SwarmEvent, SwarmMember, SwarmResult, SwarmRunSnapshot } from "@zcode/services";

export interface SwarmRunInfo {
  readonly runId: string;
  readonly task: string;
  readonly members: readonly SwarmMember[];
  readonly status: SwarmRunSnapshot["status"];
  readonly events: readonly SwarmEvent[];
  readonly result?: SwarmResult;
  readonly error?: string;
}

/** A workspace's swarm: whether sending runs it, who takes part, and the latest run. */
export interface SwarmSession {
  readonly active: boolean;
  /** `null` until the user picks: then every signed-in agent's default model takes part. */
  readonly members: readonly SwarmMember[] | null;
  readonly rounds: number;
  readonly run?: SwarmRunInfo;
}

export const EMPTY_SWARM_SESSION: SwarmSession = { active: false, members: null, rounds: 1 };

interface SwarmStoreState {
  readonly sessions: Readonly<Record<string, SwarmSession>>;
  update: (key: string, change: (session: SwarmSession) => SwarmSession) => void;
}

const STORAGE_KEY = "xatlas.swarm.sessions";

/** Settings and the latest run's id survive a window reload; the run's events are fetched again. */
function loadSessions(): Record<string, SwarmSession> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, SwarmSession>;
    return Object.fromEntries(
      Object.entries(saved).map(([key, session]) => [
        key,
        session.run ? { ...session, run: { ...session.run, status: "running" as const, events: [] } } : session,
      ]),
    );
  } catch {
    return {};
  }
}

function saveSessions(sessions: Readonly<Record<string, SwarmSession>>) {
  try {
    const slim = Object.fromEntries(
      Object.entries(sessions).map(([key, session]) => {
        const { run, ...rest } = session;
        // Only a run still going needs reattaching; finished ones are re-read from the service.
        return [key, run ? { ...rest, run: { runId: run.runId, task: run.task, members: run.members } } : rest];
      }),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    // Storage is a convenience.
  }
}

export const useSwarmStore = create<SwarmStoreState>((set, get) => ({
  sessions: typeof window === "undefined" ? {} : loadSessions(),
  update: (key, change) => {
    set((state) => ({
      sessions: { ...state.sessions, [key]: change(state.sessions[key] ?? EMPTY_SWARM_SESSION) },
    }));
    if (typeof window !== "undefined") saveSessions(get().sessions);
  },
}));
