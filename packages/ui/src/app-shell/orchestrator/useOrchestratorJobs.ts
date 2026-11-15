import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IOrchestratorService,
  OrchestratorJobView,
  OrchestratorProject,
} from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const POLL_MS = 2000;

/** A project as the Stack groups it, with what the orchestrator needs to name it. */
export interface OrchestratorStackProject extends OrchestratorProject {
  /** The Stack's group key: the project's root path, as its conversations are grouped. */
  readonly key: string;
  readonly name: string;
}

export interface OrchestratorStackJob {
  readonly view: OrchestratorJobView;
  readonly project: OrchestratorStackProject;
}

interface DirectoryProject {
  readonly id: string;
  readonly hostId: string;
  readonly name: string;
  readonly deleted: boolean;
  readonly roots: readonly { readonly rootPath: string; readonly isPrimary: boolean }[];
}

/**
 * The projects whose jobs the Stack shows. Only local ones: a job needs the host's Git
 * worktrees, and a remote workspace always goes direct.
 */
export function orchestratorStackProjects(
  projects: readonly DirectoryProject[],
): OrchestratorStackProject[] {
  return projects.flatMap((project) => {
    const root = project.roots.find((candidate) => candidate.isPrimary) ?? project.roots[0];
    if (project.deleted || !root || project.hostId !== "local") return [];
    return [
      {
        key: root.rootPath,
        name: project.name,
        projectId: project.id,
        workspacePath: root.rootPath,
      },
    ];
  });
}

function projectParams(project: OrchestratorStackProject): OrchestratorProject {
  return {
    projectId: project.projectId,
    workspacePath: project.workspacePath,
    ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
  };
}

function mergeJobs(
  previous: readonly OrchestratorJobView[],
  incoming: readonly OrchestratorJobView[],
): OrchestratorJobView[] {
  const byId = new Map(previous.map((job) => [job.jobId, job]));
  for (const job of incoming) byId.set(job.jobId, job);
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

/**
 * Every job of the given projects, kept current by polling `listJobs` with the last ledger
 * position, so a project where nothing happened answers with nothing.
 */
export function useOrchestratorJobs(projects: readonly OrchestratorStackProject[]) {
  // Optional: the Stack also renders without a host.
  const service: IOrchestratorService | undefined = useOptionalServices()?.orchestratorService;
  const [jobsByProject, setJobsByProject] = useState<
    Readonly<Record<string, readonly OrchestratorJobView[]>>
  >({});
  const seqRef = useRef(new Map<string, number>());
  const inFlightRef = useRef(new Set<string>());
  const againRef = useRef(new Set<string>());
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  // The project list is rebuilt whenever any task moves; poll again only when it really changes.
  const signature = projects
    .map((project) =>
      [project.key, project.projectId, project.workspacePath, project.workspaceIdentity ?? ""].join(
        "\0",
      ),
    )
    .join("\n");

  const poll = useCallback(
    async (key: string) => {
      const project = projectsRef.current.find((candidate) => candidate.key === key);
      if (!service || !project) return;
      if (inFlightRef.current.has(key)) {
        againRef.current.add(key);
        return;
      }
      inFlightRef.current.add(key);
      try {
        const since = seqRef.current.get(key);
        const snapshot = await service.listJobs({
          ...projectParams(project),
          ...(since === undefined ? {} : { sinceSeq: since }),
        });
        // The same position means nothing happened: the empty list is not "no jobs".
        if (since !== undefined && snapshot.seq === since) return;
        seqRef.current.set(key, snapshot.seq);
        setJobsByProject((current) => ({
          ...current,
          [key]: mergeJobs(current[key] ?? [], snapshot.jobs),
        }));
      } catch (error) {
        logger.warn("[orchestrator-jobs] listJobs failed", { error });
      } finally {
        inFlightRef.current.delete(key);
        if (againRef.current.delete(key)) void poll(key);
      }
    },
    [service],
  );

  useEffect(() => {
    if (!service) return;
    const keys = signature ? signature.split("\n").map((line) => line.split("\0")[0]!) : [];
    if (keys.length === 0) return;
    const tick = () => keys.forEach((key) => void poll(key));
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [poll, service, signature]);

  const jobs = useMemo(
    () =>
      projects
        .flatMap((project) => (jobsByProject[project.key] ?? []).map((view) => ({ view, project })))
        .sort((left, right) => Date.parse(right.view.updatedAt) - Date.parse(left.view.updatedAt)),
    [jobsByProject, projects],
  );

  const act = useCallback(
    async (
      project: OrchestratorStackProject,
      run: (service: IOrchestratorService, params: OrchestratorProject) => Promise<void>,
    ) => {
      if (!service) throw new Error("The orchestrator needs the desktop app.");
      try {
        await run(service, projectParams(project));
      } finally {
        void poll(project.key);
      }
    },
    [poll, service],
  );

  return {
    supported: Boolean(service),
    jobs,
    decide: (job: OrchestratorStackJob, decisionId: string, optionId: string) =>
      act(job.project, (svc, params) =>
        svc.decide({ ...params, jobId: job.view.jobId, decisionId, optionId }),
      ),
    postNote: (job: OrchestratorStackJob, text: string, to?: string) =>
      act(job.project, (svc, params) =>
        svc.postNote({ ...params, jobId: job.view.jobId, text, ...(to ? { to } : {}) }),
      ),
    stopJob: (job: OrchestratorStackJob) =>
      act(job.project, (svc, params) => svc.stopJob({ ...params, jobId: job.view.jobId })),
  };
}

export type OrchestratorJobActions = Pick<
  ReturnType<typeof useOrchestratorJobs>,
  "decide" | "postNote" | "stopJob"
>;
