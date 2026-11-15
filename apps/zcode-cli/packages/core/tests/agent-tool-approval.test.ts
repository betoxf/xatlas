import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createTurnId,
  SessionEventType,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";

const sessionId = createSessionId("ses_agent_tool");
const turnId = createTurnId("turn_agent_tool");
const traceContext = createRootTraceContext({ sessionId, turnId });
const REQUEST = {
  toolCallId: "toolu_1",
  toolName: "Write",
  input: { file_path: "/project/note.txt", content: "hello" },
};

function setup(answer: PermissionBrokerPort["requestPermission"]) {
  const events: SessionEvent[] = [];
  const requests: PermissionBrokerRequest[] = [];
  const hookRunner = { run: vi.fn() };
  const executor = createToolExecutor({
    registry: createToolRegistry(),
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission(request, options) {
        requests.push(request);
        return answer(request, options);
      },
    },
    emitEvent: async (event) => {
      events.push(event);
    },
    hookRunner: hookRunner as never,
    sessionId,
    getMode: () => "build",
  });
  return { events, executor, hookRunner, requests };
}

const answeredWith = (result: PermissionBrokerResult) => () => Promise.resolve(result);

describe("requestAgentToolApproval", () => {
  it("goes through the broker and the normal approval events, in order", async () => {
    const { events, executor, hookRunner, requests } = setup(answeredWith({ decision: "allow" }));
    await expect(executor.requestAgentToolApproval?.(REQUEST, traceContext)).resolves.toEqual({
      allowed: true,
      input: REQUEST.input,
    });
    expect(requests[0]).toMatchObject({
      input: REQUEST.input,
      mode: "build",
      optionsPolicy: "no-always-allow",
      sessionId,
      toolCallId: "toolu_1",
      toolName: "Write",
      turnId,
    });
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
    ]);
    expect(events[0]).toMatchObject({
      turnId,
      traceId: traceContext.traceId,
      payload: { toolCallId: "toolu_1", toolName: "Write", input: REQUEST.input },
    });
    expect(hookRunner.run).not.toHaveBeenCalled();
  });

  it("passes on a reason from the CLI", async () => {
    const { events, executor, requests } = setup(answeredWith({ decision: "allow" }));
    const reason = "Path is outside allowed working directories";
    await executor.requestAgentToolApproval?.({ ...REQUEST, reason }, traceContext);
    expect(requests[0]?.reason).toBe(reason);
    expect(events[0]).toMatchObject({ payload: { reason } });
  });

  it("returns the replacement when the answer changes the input", async () => {
    const modifiedInput = { questions: [], answers: { "Which color?": "Blue" } };
    const { executor } = setup(answeredWith({ decision: "modify", modifiedInput }));
    await expect(executor.requestAgentToolApproval?.(REQUEST, traceContext)).resolves.toEqual({
      allowed: true,
      input: modifiedInput,
    });
  });

  it("refuses with the person's reason", async () => {
    const { events, executor } = setup(answeredWith({ decision: "deny", reason: "Not that file" }));
    await expect(executor.requestAgentToolApproval?.(REQUEST, traceContext)).resolves.toEqual({
      allowed: false,
      reason: "Not that file",
    });
    expect(events.at(-1)).toMatchObject({ payload: { decision: "deny", toolCallId: "toolu_1" } });
  });

  it("treats escalate as a refusal, since there's nothing to escalate to", async () => {
    const { executor } = setup(answeredWith({ decision: "escalate" }));
    await expect(executor.requestAgentToolApproval?.(REQUEST, traceContext)).resolves.toEqual({
      allowed: false,
      reason: "Permission denied for Write",
    });
  });

  it("refuses and closes the approval when the broker fails", async () => {
    const { events, executor } = setup(() => Promise.reject(new Error("No client attached")));
    await expect(executor.requestAgentToolApproval?.(REQUEST, traceContext)).resolves.toEqual({
      allowed: false,
      reason: "No client attached",
    });
    expect(events.at(-1)).toMatchObject({
      type: SessionEventType.PermissionResolved,
      payload: { decision: "deny" },
    });
  });

  it("refuses and closes the approval when it's cancelled", async () => {
    const { events, executor, requests } = setup(
      (_request, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const controller = new AbortController();
    const asked = executor.requestAgentToolApproval?.(
      { ...REQUEST, signal: controller.signal },
      traceContext,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort();
    await expect(asked).resolves.toMatchObject({ allowed: false });
    expect(
      events.filter((event) => event.type === SessionEventType.PermissionResolved),
    ).toHaveLength(1);
  });

  it("doesn't ask at all when the turn was already stopped", async () => {
    const { events, executor } = setup(answeredWith({ decision: "allow" }));
    await expect(
      executor.requestAgentToolApproval?.(
        { ...REQUEST, signal: AbortSignal.abort() },
        traceContext,
      ),
    ).resolves.toMatchObject({ allowed: false });
    expect(events.map((event) => event.type)).toEqual([SessionEventType.PermissionResolved]);
  });
});
