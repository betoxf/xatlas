// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ConnectionAccount, ConnectionStatus, IConnectionsService } from "@zcode/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectPanel } from "@/connect/ConnectPanel.js";

const row = (
  overrides: Partial<ConnectionStatus> & Pick<ConnectionStatus, "id">,
): ConnectionStatus => ({
  installed: true,
  connected: false,
  detail: "",
  command: `${overrides.id} login`,
  downloadUrl: `https://example.com/${overrides.id}`,
  ...overrides,
});

/** jsdom here has no localStorage, so the saved rows get a plain one. */
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
  },
});

const openExternal = vi.fn();
let service: IConnectionsService;

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ connectionsService: service }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openExternal }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values ? `${id}:${Object.values(values).join()}` : id,
    },
  }),
}));
vi.mock("@/settings/model-provider-section/ProviderLogo.js", () => ({
  ProviderLogo: () => null,
}));

function connectionsService(
  connections: ConnectionStatus[],
  accounts: Partial<Record<ConnectionStatus["id"], ConnectionAccount>> = {},
): IConnectionsService {
  return {
    list: vi.fn(async () => connections),
    account: vi.fn(async ({ id }) => accounts[id] ?? null),
    check: vi.fn(async ({ id }) => connections.find((connection) => connection.id === id)!),
    signIn: vi.fn(async () => ({ opened: true })),
    setUcuEverywhere: vi.fn(async ({ enabled }) =>
      row({ id: "ucu", connected: true, everywhere: enabled }),
    ),
  };
}

async function renderPanel(props: Parameters<typeof ConnectPanel>[0] = {}) {
  render(<ConnectPanel {...props} />);
  await act(async () => {});
}

describe("ConnectPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("offers Later until something is connected", async () => {
    service = connectionsService([row({ id: "claude" })]);
    await renderPanel();
    expect(screen.getByText("connect.title")).toBeTruthy();
    expect(screen.getByText("connect.signIn")).toBeTruthy();
    expect(screen.getByText("connect.later")).toBeTruthy();
  });

  it("says you're set once a tool is connected", async () => {
    service = connectionsService([row({ id: "claude", connected: true }), row({ id: "codex" })]);
    await renderPanel();
    expect(screen.getByText("connect.title.ready")).toBeTruthy();
    expect(screen.getByText("connect.connected")).toBeTruthy();
    expect(screen.getByText("connect.done")).toBeTruthy();
  });

  it("sends a missing tool to its download page instead of Terminal", async () => {
    service = connectionsService([row({ id: "gemini", installed: false })]);
    await renderPanel();
    fireEvent.click(screen.getByText("connect.get:Gemini CLI"));
    await act(async () => {});
    expect(openExternal).toHaveBeenCalledWith("https://example.com/gemini");
    expect(service.signIn).not.toHaveBeenCalled();
    expect(screen.getByText("connect.waiting.install")).toBeTruthy();
  });

  it("turns a row to Connected on its own after signing in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signedOut = row({ id: "codex" });
    service = connectionsService([signedOut]);
    await renderPanel();

    fireEvent.click(screen.getByText("connect.signIn"));
    await act(async () => {});
    expect(service.signIn).toHaveBeenCalledWith({ id: "codex" });
    expect(screen.getByText("connect.waiting.signIn")).toBeTruthy();

    vi.mocked(service.check).mockResolvedValue({
      ...signedOut,
      connected: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByText("connect.connected")).toBeTruthy();
    expect(screen.queryByText("connect.waiting.signIn")).toBeNull();
  });

  it("shows the command where Terminal can't be opened", async () => {
    service = connectionsService([row({ id: "codex" })]);
    vi.mocked(service.signIn).mockResolvedValue({ opened: false });
    await renderPanel();
    fireEvent.click(screen.getByText("connect.signIn"));
    await act(async () => {});
    expect(screen.getByText("codex login")).toBeTruthy();
  });

  it("explains UCU before anyone sets it up, and leaves it off", async () => {
    service = connectionsService([row({ id: "ucu", installed: false })]);
    await renderPanel();
    expect(screen.getByText("connect.ucu.badge")).toBeTruthy();
    expect(screen.getByText(/connect\.ucu\.disclosure/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(service.setUcuEverywhere).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("connect.ucu.setUp"));
    await act(async () => {});
    expect(service.signIn).toHaveBeenCalledWith({ id: "ucu" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("turns UCU on for every agent only when asked", async () => {
    service = connectionsService([row({ id: "ucu", connected: true, everywhere: false })]);
    await renderPanel();
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    await act(async () => {});
    expect(service.setUcuEverywhere).toHaveBeenCalledWith({ enabled: true });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("shows the plan and what's left of each limit on a connected agent", async () => {
    service = connectionsService([row({ id: "claude", connected: true }), row({ id: "codex" })], {
      claude: {
        signedIn: true,
        plan: "Max",
        windows: [
          { usedPercent: 80, minutes: 300, resetsAt: "2026-11-14T18:00:00Z" },
          {
            usedPercent: 49,
            minutes: 10_080,
            resetsAt: "2026-11-17T18:00:00Z",
          },
        ],
        checkedAt: "2026-11-14T14:00:00Z",
      },
    });
    await renderPanel();
    expect(screen.getByText("Max")).toBeTruthy();
    const meters = screen.getAllByRole("meter");
    expect(meters.map((meter) => meter.getAttribute("aria-valuenow"))).toEqual(["20", "51"]);
    expect(screen.getByText("connect.usage.fiveHour")).toBeTruthy();
    expect(screen.getByText("connect.usage.weekly")).toBeTruthy();
    expect(service.account).toHaveBeenCalledWith({
      id: "claude",
      refresh: false,
    });
    expect(service.account).not.toHaveBeenCalledWith(expect.objectContaining({ id: "codex" }));
  });

  it("asks the agents again when someone checks again", async () => {
    service = connectionsService([row({ id: "codex", connected: true })]);
    await renderPanel();
    fireEvent.click(screen.getByText("connect.refresh"));
    await act(async () => {});
    expect(service.account).toHaveBeenLastCalledWith({
      id: "codex",
      refresh: true,
    });
  });

  it("signs in through the browser when the tool offers it", async () => {
    service = connectionsService([row({ id: "codex" })]);
    vi.mocked(service.signIn).mockResolvedValue({
      opened: true,
      url: "https://auth.example.com",
    });
    await renderPanel();
    fireEvent.click(screen.getByText("connect.signIn"));
    await act(async () => {});
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.com");
    expect(screen.getByText("connect.waiting.browser")).toBeTruthy();
  });

  it("shows the rows from last time while they're checked again", async () => {
    window.localStorage.setItem(
      "xatlas.connect.lastSeen.v1",
      JSON.stringify({
        connections: [row({ id: "claude", connected: true })],
        accounts: {
          claude: { signedIn: true, plan: "Max", windows: [], checkedAt: "x" },
        },
      }),
    );
    service = connectionsService([row({ id: "claude", connected: true })]);
    vi.mocked(service.list).mockReturnValue(new Promise(() => {}));
    render(<ConnectPanel />);
    expect(screen.getByText("Max")).toBeTruthy();
    expect(screen.getByText("connect.connected")).toBeTruthy();
  });
});
