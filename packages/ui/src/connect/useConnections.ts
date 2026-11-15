import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionAccount, ConnectionId, ConnectionStatus } from "@zcode/services";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/** Rows waiting on a sign-in are checked this often, for this long after the click. */
const CHECK_INTERVAL_MS = 3_000;
const CONNECTING_WINDOW_MS = 10 * 60_000;
/** While the window is in view, rows and plans are checked again this often. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/** The last rows seen, shown at once next time while they're checked again. */
const SAVED_KEY = "xatlas.connect.lastSeen.v1";

type Accounts = Partial<Record<ConnectionId, ConnectionAccount>>;

interface Saved {
  readonly connections: readonly ConnectionStatus[];
  readonly accounts: Accounts;
}

function readSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Saved>) : null;
    return Array.isArray(saved?.connections)
      ? { connections: saved.connections, accounts: saved.accounts ?? {} }
      : null;
  } catch {
    return null;
  }
}

function writeSaved(saved: Saved) {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {
    // Storage can be off in a private window; the rows are checked again anyway.
  }
}

function replaceConnection(
  connections: readonly ConnectionStatus[] | null,
  next: ConnectionStatus,
): readonly ConnectionStatus[] | null {
  return connections?.map((connection) => (connection.id === next.id ? next : connection)) ?? null;
}

/** The Connect window's rows, which turn to Connected on their own as sign-ins finish. */
export function useConnections() {
  // Optional: the phone remote and the web app have no host to run CLIs on.
  const service = useOptionalServices()?.connectionsService;
  const platform = usePlatform();
  const [saved] = useState(readSaved);
  const [connections, setConnections] = useState<readonly ConnectionStatus[] | null>(
    saved?.connections ?? null,
  );
  /** True until the first check of this window finishes, while saved rows are shown. */
  const [stale, setStale] = useState(saved !== null);
  const [accounts, setAccounts] = useState<Accounts>(saved?.accounts ?? {});
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState<Partial<Record<ConnectionId, number>>>({});
  /** Rows whose command has to be run by hand, because Terminal couldn't be opened. */
  const [manual, setManual] = useState<ReadonlySet<ConnectionId>>(new Set());
  /** Rows signing in through the browser rather than Terminal. */
  const [inBrowser, setInBrowser] = useState<ReadonlySet<ConnectionId>>(new Set());
  const [ucuError, setUcuError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadAccount = useCallback(
    async (id: ConnectionId, refresh = false) => {
      if (!service) return;
      try {
        const account = await service.account({ id, refresh });
        if (!mounted.current) return;
        setAccounts((current) => {
          if (account) return { ...current, [id]: account };
          const { [id]: _gone, ...rest } = current;
          return rest;
        });
      } catch (error) {
        logger.warn("[Connect] 读取账户用量失败", { id, error });
      }
    },
    [service],
  );

  const refreshAll = useCallback(
    async (refresh = false) => {
      if (!service) return;
      setRefreshing(true);
      try {
        const list = await service.list();
        if (!mounted.current) return;
        setConnections(list);
        setStale(false);
        // Signed-out tools keep no plan.
        setAccounts((current) => {
          const next: Accounts = {};
          for (const connection of list) {
            const account = current[connection.id];
            if (connection.connected && account) next[connection.id] = account;
          }
          return next;
        });
        await Promise.all(
          list
            .filter((connection) => connection.connected)
            .map((connection) => loadAccount(connection.id, refresh)),
        );
      } catch (error) {
        logger.warn("[Connect] 读取连接状态失败", { error });
      } finally {
        if (mounted.current) setRefreshing(false);
      }
    },
    [loadAccount, service],
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Checked again now and then, but only while someone can see the window.
  useEffect(() => {
    if (!service) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    const timer = setInterval(refreshIfVisible, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshAll, service]);

  useEffect(() => {
    if (connections && !stale) writeSaved({ connections, accounts });
  }, [accounts, connections, stale]);

  const waitingIds = Object.keys(connecting).join();
  useEffect(() => {
    if (!service || !waitingIds) return;
    const timer = setInterval(() => {
      for (const id of waitingIds.split(",") as ConnectionId[]) {
        void service
          .check({ id })
          .then((status) => {
            setConnections((current) => replaceConnection(current, status));
            if (status.connected) void loadAccount(id, true);
            setConnecting((current) => {
              const startedAt = current[id];
              const expired =
                startedAt !== undefined && Date.now() - startedAt > CONNECTING_WINDOW_MS;
              if (!status.connected && !expired) return current;
              const { [id]: _finished, ...rest } = current;
              return rest;
            });
          })
          .catch((error: unknown) => logger.warn("[Connect] 检查连接失败", { id, error }));
      }
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadAccount, service, waitingIds]);

  const connect = useCallback(
    async (connection: ConnectionStatus) => {
      if (!service) return;
      const startWaiting = () =>
        setConnecting((current) => ({
          ...current,
          [connection.id]: Date.now(),
        }));
      // UCU is installed by its own command; a missing CLI needs its download page first.
      if (!connection.installed && connection.id !== "ucu") {
        platform.openExternal(connection.downloadUrl);
        startWaiting();
        return;
      }
      const { opened, url } = await service.signIn({ id: connection.id });
      if (url) {
        platform.openExternal(url);
        setInBrowser((current) => new Set(current).add(connection.id));
      } else if (!opened) {
        setManual((current) => new Set(current).add(connection.id));
      }
      startWaiting();
    },
    [platform, service],
  );

  const setUcuEverywhere = useCallback(
    async (enabled: boolean) => {
      if (!service) return;
      setUcuError(null);
      try {
        const status = await service.setUcuEverywhere({ enabled });
        setConnections((current) => replaceConnection(current, status));
      } catch (error) {
        setUcuError(error instanceof Error ? error.message : String(error));
      }
    },
    [service],
  );

  return {
    available: Boolean(service),
    connections,
    accounts,
    stale,
    refreshing,
    connecting,
    manual,
    inBrowser,
    ucuError,
    connect,
    refresh: () => refreshAll(true),
    setUcuEverywhere,
    openDownload: (connection: ConnectionStatus) => platform.openExternal(connection.downloadUrl),
  };
}
