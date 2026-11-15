import { create } from "zustand";
import type { RoutePreference } from "./orchestratorLabels.js";

/**
 * The route a project starts on. Direct for now: triage takes about 7 seconds through a CLI,
 * too slow to put in front of every message. Flip it to "auto" once triage is fast.
 */
export const DEFAULT_ROUTE_PREFERENCE: RoutePreference = "direct";

/** What the composer tells the person after it asked where a message goes. */
export type RouteNotice =
  | { readonly kind: "job"; readonly jobId: string; readonly reason?: string }
  /** The full route can't run here, so the message went direct. */
  | { readonly kind: "note"; readonly text: string }
  /** Asking failed, so the message went direct. */
  | { readonly kind: "failed"; readonly detail?: string };

/** A project's route: the person's choice and what became of its last routed message. */
export interface RouteSession {
  /** Absent until the person picks: then `DEFAULT_ROUTE_PREFERENCE`. */
  readonly preference?: RoutePreference;
  readonly notice?: RouteNotice;
}

/** One message being decided; `cancel` sends it direct instead. */
export interface RouteDeciding {
  readonly token: number;
  readonly cancel: () => void;
}

const EMPTY_ROUTE_SESSION: RouteSession = {};

interface RouteStoreState {
  /** By project (the workspace key). */
  readonly sessions: Readonly<Record<string, RouteSession>>;
  /**
   * By composer draft (workspace key and draft scope), so another conversation of the same
   * project neither shows this wait nor can cancel it.
   */
  readonly deciding: Readonly<Record<string, RouteDeciding>>;
  update: (key: string, change: (session: RouteSession) => RouteSession) => void;
  setDeciding: (sendKey: string, deciding: RouteDeciding | undefined) => void;
}

const STORAGE_KEY = "xatlas.orchestrator.route";

/** Only the choice is kept; a decision in flight or a notice belongs to this window. */
function loadSessions(): Record<string, RouteSession> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
      string,
      RoutePreference
    >;
    return Object.fromEntries(
      Object.entries(saved)
        .filter(([, preference]) => ["auto", "direct", "orchestrated"].includes(preference))
        .map(([key, preference]) => [key, { preference }]),
    );
  } catch {
    return {};
  }
}

function savePreferences(sessions: Readonly<Record<string, RouteSession>>) {
  try {
    const preferences = Object.fromEntries(
      Object.entries(sessions).flatMap(([key, session]) =>
        session.preference ? [[key, session.preference]] : [],
      ),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage is a convenience.
  }
}

export const useOrchestratorRouteStore = create<RouteStoreState>((set, get) => ({
  sessions: typeof window === "undefined" ? {} : loadSessions(),
  deciding: {},
  setDeciding: (sendKey, deciding) =>
    set((state) => {
      const { [sendKey]: _current, ...rest } = state.deciding;
      return { deciding: deciding ? { ...rest, [sendKey]: deciding } : rest };
    }),
  update: (key, change) => {
    const before = get().sessions[key];
    set((state) => ({
      sessions: { ...state.sessions, [key]: change(state.sessions[key] ?? EMPTY_ROUTE_SESSION) },
    }));
    if (typeof window !== "undefined" && before?.preference !== get().sessions[key]?.preference) {
      savePreferences(get().sessions);
    }
  },
}));

export function selectRouteSession(key: string) {
  return (state: RouteStoreState): RouteSession => state.sessions[key] ?? EMPTY_ROUTE_SESSION;
}

export function selectRouteDeciding(sendKey: string) {
  return (state: RouteStoreState): RouteDeciding | undefined => state.deciding[sendKey];
}
