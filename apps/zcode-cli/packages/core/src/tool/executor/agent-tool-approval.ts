import {
  runWithContextAsync,
  traceContextToLogContext,
  type ModelAgentToolApproval,
  type ModelAgentToolApprovalRequest,
  type PermissionBrokerResult,
  type TraceContext,
} from "@zcode/contracts";
import type { PermissionDecisionResult } from "../../permission/service.js";
import { emitPermissionResolved } from "./events.js";
import { requestPermissionResponse } from "./permission-request.js";
import type { ToolExecutorDeps } from "./types.js";

const AGENT_TOOL_RULE_ID = "agent-tool";
/** 与内置工具的通用原因相同：确认窗据此隐藏它，不把诊断文案展示给用户。 */
const DEFAULT_REASON = "Tool has side effects and requires approval";

/**
 * CLI agent 自己执行工具：这里只走审批生命周期。CLI 已判定需要询问，因此没有 PermissionService
 * 判定、schema 校验和规则落盘；选项去掉 Always allow，那条规则在 CLI 一侧没有读者。
 */
export function requestAgentToolApproval(
  deps: ToolExecutorDeps,
  request: ModelAgentToolApprovalRequest,
  traceContext: TraceContext,
): Promise<ModelAgentToolApproval> {
  // 根因：应答链由 adapter 的行读取发起，emitEvent 读取的 trace 不在该异步链上。
  return runWithContextAsync(traceContext, () => settleApproval(deps, request, traceContext));
}

async function settleApproval(
  deps: ToolExecutorDeps,
  request: ModelAgentToolApprovalRequest,
  traceContext: TraceContext,
): Promise<ModelAgentToolApproval> {
  const toolCall = { id: request.toolCallId, name: request.toolName, input: request.input };
  const mode = deps.getMode();
  const requestId = "perm_" + crypto.randomUUID();
  const reason = request.reason ?? DEFAULT_REASON;
  const decision: PermissionDecisionResult = {
    allowed: false,
    decision: "ask",
    escalated: false,
    mode,
    reason,
    riskLevel: "high",
    ruleId: AGENT_TOOL_RULE_ID,
  };
  let resolved: PermissionBrokerResult;
  try {
    const { result } = await requestPermissionResponse({
      deps,
      toolCall,
      input: request.input,
      decision,
      mode,
      requestId,
      traceContext,
      suggestedPermissionUpdates: [],
      approval: { optionsPolicy: "no-always-allow" },
      runHooks: false,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    resolved = { ...result, resolvedAt: result.resolvedAt ?? new Date() };
  } catch (error) {
    // 取消、超时与 broker 故障都不能放行；终态事件仍发出，确认窗才会消失。
    const message = error instanceof Error ? error.message : "Permission request failed";
    resolved = { decision: "deny", reason: message, resolvedAt: new Date() };
  }
  await emitPermissionResolved(deps, toolCall, requestId, resolved, traceContext);
  deps.logger?.info("Agent tool permission resolved", {
    ...traceContextToLogContext(traceContext),
    decision: resolved.decision,
    event: "tool.permission.resolved",
    mode,
    module: "core.tool.executor",
    requestId,
    ruleId: AGENT_TOOL_RULE_ID,
    status:
      resolved.decision === "allow" || resolved.decision === "modify" ? "completed" : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
  if (resolved.decision === "allow") return { allowed: true, input: request.input };
  if (resolved.decision === "modify") {
    return { allowed: true, input: resolved.modifiedInput ?? request.input };
  }
  return { allowed: false, reason: resolved.reason ?? `Permission denied for ${request.toolName}` };
}
