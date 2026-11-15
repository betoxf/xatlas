import { useCallback, useMemo } from "react";
import type { OrchestratorProject } from "@zcode/services";
import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useOptionalProjectSelectionDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import type { RoutePreference } from "./orchestratorLabels.js";
import {
  DEFAULT_ROUTE_PREFERENCE,
  selectRouteDeciding,
  selectRouteSession,
  useOrchestratorRouteStore,
} from "./orchestratorRouteStore.js";
import { routeMessage } from "./routeMessage.js";

interface DirectoryProject {
  readonly id: string;
  readonly hostId: string;
  readonly deleted: boolean;
  readonly roots: readonly { readonly rootPath: string }[];
}

/**
 * The project a workspace belongs to, as the orchestrator names it, or null when no project
 * holds this folder. Local projects match by root path; remote ones by the identity the
 * sidebar builds for their roots.
 */
export function resolveOrchestratorProject(
  projects: readonly DirectoryProject[],
  workspacePath: string,
  workspaceIdentity?: string,
): OrchestratorProject | null {
  const identity = workspaceIdentity?.trim();
  const project = projects.find(
    (candidate) =>
      !candidate.deleted &&
      candidate.roots.some((root) =>
        identity
          ? candidate.hostId !== "local" &&
            buildRemoteHostWorkspaceIdentity(candidate.hostId, root.rootPath) === identity
          : candidate.hostId === "local" && root.rootPath === workspacePath,
      ),
  );
  if (!project) return null;
  return {
    projectId: project.id,
    workspacePath,
    ...(identity ? { workspaceIdentity: identity } : {}),
  };
}

export function useOrchestratorProject(
  workspacePath: string,
  workspaceIdentity?: string,
): OrchestratorProject | null {
  const projects = useOptionalProjectSelectionDirectory()?.allProjects;
  return useMemo(
    () => resolveOrchestratorProject(projects ?? [], workspacePath, workspaceIdentity),
    [projects, workspacePath, workspaceIdentity],
  );
}

let nextToken = 1;

/**
 * A workspace's route choice and what the composer asks before sending. Absent a host or a
 * project, `routes` stays false and the composer sends as it always has. The choice and the
 * notice belong to the project (`routeKey`); the wait belongs to one draft (`sendKey`).
 */
export function useOrchestratorRoute(
  routeKey: string,
  project: OrchestratorProject | null,
  sendKey: string = routeKey,
) {
  // Optional: the composer also renders without a host (tests, the web share view).
  const service = useOptionalServices()?.orchestratorService;
  const session = useOrchestratorRouteStore(selectRouteSession(routeKey));
  const deciding = useOrchestratorRouteStore(selectRouteDeciding(sendKey));
  const update = useOrchestratorRouteStore((state) => state.update);
  const setDeciding = useOrchestratorRouteStore((state) => state.setDeciding);
  const preference = session.preference ?? DEFAULT_ROUTE_PREFERENCE;
  const supported = Boolean(service && project);

  const decide = useCallback(
    async (input: { text: string; conversationId?: string }): Promise<"send" | "job"> => {
      if (!service || !project) return "send";
      const token = nextToken++;
      let cancel = () => {};
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      update(routeKey, ({ notice: _notice, ...rest }) => rest);
      setDeciding(sendKey, { token, cancel });
      const outcome = await routeMessage(
        service,
        {
          ...project,
          text: input.text,
          preference,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        },
        cancelled,
      );
      if (useOrchestratorRouteStore.getState().deciding[sendKey]?.token === token) {
        setDeciding(sendKey, undefined);
      }
      if (outcome.notice) {
        const notice = outcome.notice;
        update(routeKey, (current) => ({ ...current, notice }));
      }
      return outcome.kind;
    },
    [preference, project, routeKey, sendKey, service, setDeciding, update],
  );

  return {
    supported,
    preference,
    /** Sending asks the orchestrator first. */
    routes: supported && preference !== "direct",
    deciding: Boolean(deciding),
    notice: session.notice,
    decide,
    /** Stops waiting for the decision; the message goes direct. */
    sendDirect: () => deciding?.cancel(),
    setPreference: (next: RoutePreference) =>
      update(routeKey, (current) => ({ ...current, preference: next })),
    dismissNotice: () => update(routeKey, ({ notice: _notice, ...rest }) => rest),
  };
}
