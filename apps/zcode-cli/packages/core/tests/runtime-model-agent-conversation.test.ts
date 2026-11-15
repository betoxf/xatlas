import { describe, expect, it } from "vitest";
import {
  createSessionId,
  getCurrentModelInvocationContext,
  type CollaborationMode,
  type ModelInvocationContext,
} from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const selection = { providerId: "test", modelId: "model" };

async function conversationFor(config: { mode: CollaborationMode; planEnabled?: boolean }) {
  let seen: ModelInvocationContext | undefined;
  const runtime = createTestAgentRuntime(
    createSessionId(`agent-conversation-${config.mode}-${String(config.planEnabled)}`),
    { modelSelection: selection, ...config },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        async generateText() {
          return { text: "", finishReason: "stop" as const };
        },
        async *streamText() {
          seen = getCurrentModelInvocationContext();
          yield { type: "finish", finishReason: "stop" };
        },
      }),
    },
  );
  const model = createRuntimeModel(runtime as never, { selection });
  for await (const _event of model.streamText({ messages: [{ role: "user", content: "Hi" }] })) {
    /* 消费完整流。 */
  }
  return seen?.agentConversation;
}

describe("runtime model agent conversation", () => {
  it("hands over the conversation's mode and the way to ask", async () => {
    const conversation = await conversationFor({ mode: "build" });
    expect(conversation?.mode).toBe("build");
    expect(conversation?.requestToolApproval).toBeTypeOf("function");
  });

  it.each(["build", "guarded", "yolo"] as const)(
    "reports plan while the Plan toggle is on over %s, which would otherwise allow writes",
    async (mode) => {
      const conversation = await conversationFor({ mode, planEnabled: true });
      expect(conversation?.mode).toBe("plan");
    },
  );
});
