import type {
  IOrchestratorService,
  OrchestratorProject,
  OrchestratorRouteRequest,
  OrchestratorRouteResult,
} from "@zcode/services";
import { logger } from "@/logger.js";
import type { RouteNotice } from "./orchestratorRouteStore.js";

/**
 * What the composer does with the message: "send" it into the conversation as it always has,
 * or nothing more, because it became a "job".
 */
export type RouteOutcome =
  | { readonly kind: "send"; readonly notice?: RouteNotice }
  | { readonly kind: "job"; readonly notice: RouteNotice };

type Settled =
  | { readonly status: "routed"; readonly result: OrchestratorRouteResult }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled" };

function projectOf(request: OrchestratorRouteRequest): OrchestratorProject {
  return {
    projectId: request.projectId,
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
  };
}

/**
 * Asks the orchestrator where a message goes. It never loses the message: anything but a job
 * comes back as "send". `cancelled` settling means the person chose to send it direct; the
 * service can't take a question back, so a job it makes anyway is stopped.
 */
export async function routeMessage(
  service: Pick<IOrchestratorService, "route" | "stopJob">,
  request: OrchestratorRouteRequest,
  cancelled: Promise<void>,
): Promise<RouteOutcome> {
  let asked: Promise<OrchestratorRouteResult>;
  try {
    asked = service.route(request);
  } catch (error) {
    asked = Promise.reject(error);
  }
  const settled = await Promise.race<Settled>([
    asked.then(
      (result) => ({ status: "routed", result }),
      (error: unknown) => ({ status: "failed", error }),
    ),
    cancelled.then(() => ({ status: "cancelled" })),
  ]);

  if (settled.status === "cancelled") {
    void asked
      .then(async (result) => {
        if (result.decision.route === "orchestrated" && result.jobId) {
          await service.stopJob({ ...projectOf(request), jobId: result.jobId });
        }
      })
      .catch((error: unknown) =>
        logger.warn("[orchestrator-route] a cancelled route did not settle cleanly", { error }),
      );
    return { kind: "send" };
  }
  if (settled.status === "failed") {
    logger.warn("[orchestrator-route] route failed; sending direct", { error: settled.error });
    const detail = settled.error instanceof Error ? settled.error.message : undefined;
    return { kind: "send", notice: { kind: "failed", ...(detail ? { detail } : {}) } };
  }

  const { result } = settled;
  if (result.decision.route === "orchestrated" && result.jobId) {
    return {
      kind: "job",
      notice: {
        kind: "job",
        jobId: result.jobId,
        ...(result.decision.reason ? { reason: result.decision.reason } : {}),
      },
    };
  }
  if (result.note) {
    return { kind: "send", notice: { kind: "note", text: result.note } };
  }
  if (result.decision.route === "orchestrated") {
    // "Orchestrated" without a job: nothing holds the message, so it goes on as typed.
    logger.warn("[orchestrator-route] orchestrated without a job id; sending direct");
    return { kind: "send", notice: { kind: "failed" } };
  }
  return { kind: "send" };
}
