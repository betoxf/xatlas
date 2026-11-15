import { useCallback, useEffect, useRef, useState } from "react";
import type { ReleaseQueueResult, ReleaseTrainOutcome } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";

type QueueState =
  | { readonly status: "loading" }
  | { readonly status: "unsupported" }
  | ReleaseQueueResult;

type TrainState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | ReleaseTrainOutcome;

/** A workspace's release queue, plus the merge train check on demand. */
export function useReleaseQueue(workspacePath: string | null) {
  const { releaseQueueService } = useServices();
  const [queue, setQueue] = useState<QueueState>({ status: "loading" });
  const [train, setTrain] = useState<TrainState>({ status: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!releaseQueueService) {
      setQueue({ status: "unsupported" });
      return;
    }
    if (!workspacePath) {
      return;
    }
    const current = ++generation.current;
    setRefreshing(true);
    try {
      const result = await releaseQueueService.getQueue({ workspacePath });
      if (current === generation.current) {
        setQueue(result);
      }
    } catch (error) {
      if (current === generation.current) {
        setQueue({ status: "unavailable", reason: "failed", message: String(error) });
      }
    } finally {
      if (current === generation.current) {
        setRefreshing(false);
      }
    }
  }, [releaseQueueService, workspacePath]);

  useEffect(() => {
    setQueue({ status: "loading" });
    setTrain({ status: "idle" });
    void load();
  }, [load]);

  const checkTrain = useCallback(async () => {
    if (!releaseQueueService || !workspacePath || queue.status !== "ok") {
      return;
    }
    setTrain({ status: "running" });
    try {
      setTrain(
        await releaseQueueService.checkMergeTrain({
          workspacePath,
          baseBranch: queue.snapshot.baseBranch,
          order: queue.analysis.plan.order,
        }),
      );
    } catch (error) {
      setTrain({ status: "unavailable", message: String(error) });
    }
  }, [queue, releaseQueueService, workspacePath]);

  const refresh = useCallback(() => {
    setTrain({ status: "idle" });
    void load();
  }, [load]);

  return { queue, train, refreshing, refresh, checkTrain };
}
