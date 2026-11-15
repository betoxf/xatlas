// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type {
  IOrchestratorService,
  OrchestratorRouteRequest,
  OrchestratorRouteResult,
} from "@zcode/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** jsdom here has no localStorage, so the saved choices get a plain one. */
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

let service: IOrchestratorService | undefined;
let directoryProjects: unknown[] = [];

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => (service ? { orchestratorService: service } : {}),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectSelectionDirectory: () => ({ allProjects: directoryProjects }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
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

const { routeMessage } = await import("@/app-shell/orchestrator/routeMessage.js");
const { resolveOrchestratorProject, useOrchestratorRoute } =
  await import("@/app-shell/orchestrator/useOrchestratorRoute.js");
const { DEFAULT_ROUTE_PREFERENCE, useOrchestratorRouteStore } =
  await import("@/app-shell/orchestrator/orchestratorRouteStore.js");
const { OrchestratorRouteTray } = await import("@/app-shell/orchestrator/OrchestratorRouteTray.js");
const { OrchestratorRouteControl } =
  await import("@/app-shell/orchestrator/OrchestratorRouteControl.js");

const project = { projectId: "p1", workspacePath: "/work/app" };
const request: OrchestratorRouteRequest = {
  ...project,
  text: "Make the settings page searchable",
  preference: "auto",
  conversationId: "conv-1",
};

function result(
  route: OrchestratorRouteResult["decision"]["route"],
  extra: Partial<OrchestratorRouteResult> = {},
): OrchestratorRouteResult {
  return { decision: { route, reason: `It reads as ${route}.`, confident: true }, ...extra };
}

function fakeService(route: IOrchestratorService["route"]): IOrchestratorService {
  return {
    route: vi.fn(route),
    listJobs: vi.fn(async () => ({ seq: 0, jobs: [] })),
    decide: vi.fn(async () => {}),
    postNote: vi.fn(async () => {}),
    stopJob: vi.fn(async () => {}),
    getRoles: vi.fn(),
    setRoles: vi.fn(async () => {}),
  } as unknown as IOrchestratorService;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = new Promise<void>(() => {});

beforeEach(() => {
  stored.clear();
  useOrchestratorRouteStore.setState({ sessions: {}, deciding: {} });
  directoryProjects = [
    { id: "p1", hostId: "local", deleted: false, roots: [{ rootPath: "/work/app" }] },
  ];
  service = undefined;
});
afterEach(() => cleanup());

describe("routeMessage", () => {
  it("sends chat and direct as typed, with nothing to say", async () => {
    for (const route of ["chat", "direct"] as const) {
      const svc = fakeService(async () => result(route));
      await expect(routeMessage(svc, request, never)).resolves.toEqual({ kind: "send" });
      expect(svc.route).toHaveBeenCalledWith(request);
    }
  });

  it("holds the message back when it became a job", async () => {
    const svc = fakeService(async () => result("orchestrated", { jobId: "job-7" }));
    await expect(routeMessage(svc, request, never)).resolves.toEqual({
      kind: "job",
      notice: { kind: "job", jobId: "job-7", reason: "It reads as orchestrated." },
    });
  });

  it("sends direct and passes on why the full route can't run here", async () => {
    const svc = fakeService(async () =>
      result("direct", { note: "This folder is not a Git repository." }),
    );
    await expect(routeMessage(svc, request, never)).resolves.toEqual({
      kind: "send",
      notice: { kind: "note", text: "This folder is not a Git repository." },
    });
  });

  it("sends direct and says so when asking fails, thrown or rejected", async () => {
    const rejected = fakeService(async () => {
      throw new Error("The orchestrator's loop is not built yet.");
    });
    await expect(routeMessage(rejected, request, never)).resolves.toEqual({
      kind: "send",
      notice: { kind: "failed", detail: "The orchestrator's loop is not built yet." },
    });
    const thrown = fakeService((() => {
      throw new Error("boom");
    }) as unknown as IOrchestratorService["route"]);
    await expect(routeMessage(thrown, request, never)).resolves.toMatchObject({
      kind: "send",
      notice: { kind: "failed" },
    });
  });

  it("sends an orchestrated answer without a job, rather than lose it", async () => {
    const svc = fakeService(async () => result("orchestrated"));
    await expect(routeMessage(svc, request, never)).resolves.toEqual({
      kind: "send",
      notice: { kind: "failed" },
    });
  });

  it("sends direct at once on cancel, and stops a job made anyway", async () => {
    const late = deferred<OrchestratorRouteResult>();
    const svc = fakeService(() => late.promise);
    const cancel = deferred<void>();
    const outcome = routeMessage(svc, request, cancel.promise);
    cancel.resolve();
    await expect(outcome).resolves.toEqual({ kind: "send" });
    late.resolve(result("orchestrated", { jobId: "job-late" }));
    await vi.waitFor(() =>
      expect(svc.stopJob).toHaveBeenCalledWith({ ...project, jobId: "job-late" }),
    );
  });

  it("leaves a late chat answer alone after cancel", async () => {
    const late = deferred<OrchestratorRouteResult>();
    const svc = fakeService(() => late.promise);
    const outcome = routeMessage(svc, request, Promise.resolve());
    await expect(outcome).resolves.toEqual({ kind: "send" });
    late.resolve(result("chat"));
    await Promise.resolve();
    expect(svc.stopJob).not.toHaveBeenCalled();
  });
});

describe("resolveOrchestratorProject", () => {
  const projects = [
    { id: "gone", hostId: "local", deleted: true, roots: [{ rootPath: "/work/app" }] },
    { id: "local", hostId: "local", deleted: false, roots: [{ rootPath: "/work/app" }] },
    { id: "remote", hostId: "host-9", deleted: false, roots: [{ rootPath: "/work/app" }] },
  ];

  it("matches a local workspace by its root, skipping deleted projects", () => {
    expect(resolveOrchestratorProject(projects, "/work/app")).toEqual({
      projectId: "local",
      workspacePath: "/work/app",
    });
  });

  it("finds nothing for a folder no project holds", () => {
    expect(resolveOrchestratorProject(projects, "/elsewhere")).toBeNull();
  });
});

describe("useOrchestratorRoute", () => {
  it("routes nothing without a host or a project, and defaults to Direct", () => {
    expect(DEFAULT_ROUTE_PREFERENCE).toBe("direct");
    const { result: noHost } = renderHook(() => useOrchestratorRoute("/work/app", project));
    expect(noHost.current).toMatchObject({ supported: false, routes: false });

    service = fakeService(async () => result("chat"));
    const { result: noProject } = renderHook(() => useOrchestratorRoute("/work/app", null));
    expect(noProject.current.supported).toBe(false);

    const { result: hook } = renderHook(() => useOrchestratorRoute("/work/app", project));
    expect(hook.current).toMatchObject({ supported: true, preference: "direct", routes: false });
    act(() => hook.current.setPreference("auto"));
    expect(hook.current.routes).toBe(true);
    expect(JSON.parse(stored.get("xatlas.orchestrator.route")!)).toEqual({ "/work/app": "auto" });
  });

  it("shows it is deciding, then what became of the message", async () => {
    const answer = deferred<OrchestratorRouteResult>();
    service = fakeService(() => answer.promise);
    const { result: hook } = renderHook(() => useOrchestratorRoute("/work/app", project));
    act(() => hook.current.setPreference("orchestrated"));

    let decided!: Promise<"send" | "job">;
    act(() => {
      decided = hook.current.decide({ text: "Build it", conversationId: "conv-1" });
    });
    expect(hook.current.deciding).toBe(true);
    expect(service.route).toHaveBeenCalledWith({
      ...project,
      text: "Build it",
      preference: "orchestrated",
      conversationId: "conv-1",
    });

    await act(async () => answer.resolve(result("orchestrated", { jobId: "job-1" })));
    await expect(decided).resolves.toBe("job");
    expect(hook.current.deciding).toBe(false);
    expect(hook.current.notice).toEqual({
      kind: "job",
      jobId: "job-1",
      reason: "It reads as orchestrated.",
    });
  });

  it("keeps a wait to its own draft, and the notice to the project", async () => {
    const answer = deferred<OrchestratorRouteResult>();
    service = fakeService(() => answer.promise);
    const { result: first } = renderHook(() =>
      useOrchestratorRoute("/work/app", project, "/work/app\0conv-1"),
    );
    const { result: second } = renderHook(() =>
      useOrchestratorRoute("/work/app", project, "/work/app\0conv-2"),
    );
    act(() => first.current.setPreference("auto"));
    expect(second.current.routes).toBe(true);
    let decided!: Promise<"send" | "job">;
    act(() => {
      decided = first.current.decide({ text: "Hi" });
    });
    expect(first.current.deciding).toBe(true);
    expect(second.current.deciding).toBe(false);
    act(() => second.current.sendDirect());
    expect(first.current.deciding).toBe(true);
    await act(async () => answer.resolve(result("direct", { note: "Not a Git repository." })));
    await expect(decided).resolves.toBe("send");
    expect(second.current.notice).toEqual({ kind: "note", text: "Not a Git repository." });
  });

  it("sends direct when the person cancels while it decides", async () => {
    service = fakeService(() => new Promise(() => {}));
    const { result: hook } = renderHook(() => useOrchestratorRoute("/work/app", project));
    act(() => hook.current.setPreference("auto"));
    let decided!: Promise<"send" | "job">;
    act(() => {
      decided = hook.current.decide({ text: "Hi" });
    });
    await act(async () => hook.current.sendDirect());
    await expect(decided).resolves.toBe("send");
    expect(hook.current.deciding).toBe(false);
    expect(hook.current.notice).toBeUndefined();
  });
});

describe("OrchestratorRouteTray", () => {
  it("shows the decision pending, with Send direct", () => {
    const cancel = vi.fn();
    useOrchestratorRouteStore.setState({ deciding: { "k\0draft": { token: 1, cancel } } });
    render(<OrchestratorRouteTray routeKey="k" sendKey={"k\0draft"} />);
    expect(screen.getByText("orchestrator.route.deciding")).toBeTruthy();
    fireEvent.click(screen.getByText("orchestrator.route.sendDirect"));
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    [
      { kind: "job", jobId: "j", reason: "A big change." },
      ["orchestrator.route.becameJob", "A big change."],
    ],
    [
      { kind: "note", text: "Not a Git repository." },
      ["orchestrator.route.note:Not a Git repository."],
    ],
    [{ kind: "failed", detail: "boom" }, ["orchestrator.route.failed", "boom"]],
  ] as const)("says what became of the message (%o)", (notice, texts) => {
    useOrchestratorRouteStore.setState({ sessions: { k: { notice } } });
    render(<OrchestratorRouteTray routeKey="k" sendKey={"k\0draft"} />);
    for (const text of texts) expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("orchestrator.route.dismiss"));
    expect(useOrchestratorRouteStore.getState().sessions.k?.notice).toBeUndefined();
  });

  it("shows nothing when there is nothing to say", () => {
    const { container } = render(<OrchestratorRouteTray routeKey="k" sendKey={"k\0draft"} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("OrchestratorRouteControl", () => {
  it("is absent without a host", () => {
    const { container } = render(
      <OrchestratorRouteControl routeKey="/work/app" workspacePath="/work/app" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("is absent for a folder no project holds", () => {
    service = fakeService(async () => result("chat"));
    const { container } = render(
      <OrchestratorRouteControl routeKey="/elsewhere" workspacePath="/elsewhere" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("offers the three choices and remembers the pick", async () => {
    service = fakeService(async () => result("chat"));
    render(<OrchestratorRouteControl routeKey="/work/app" workspacePath="/work/app" />);
    const trigger = screen.getByLabelText("orchestrator.route.trigger:orchestrator.route.direct");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByText("orchestrator.route.label")).toBeTruthy();
    expect(screen.getByText("orchestrator.route.autoHint")).toBeTruthy();
    expect(screen.getByText("orchestrator.route.directHint")).toBeTruthy();
    fireEvent.click(screen.getByText("orchestrator.route.orchestrated"));
    expect(useOrchestratorRouteStore.getState().sessions["/work/app"]?.preference).toBe(
      "orchestrated",
    );
    expect(
      screen.getByLabelText("orchestrator.route.trigger:orchestrator.route.orchestrated"),
    ).toBeTruthy();
  });
});
