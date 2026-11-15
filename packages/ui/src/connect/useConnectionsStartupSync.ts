import { useEffect } from "react";
import type { IConnectionsService } from "@zcode/services";
import { logger } from "@/logger.js";

/** Listing connections keeps the model picker in step with what's signed in since last time. */
export function useConnectionsStartupSync(service: IConnectionsService | undefined) {
  useEffect(() => {
    service?.list().catch((error: unknown) => {
      logger.warn("[Connect] 启动时同步 CLI 连接失败", { error });
    });
  }, [service]);
}
