import { useMemo } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { ReleaseQueuePanel, type ReleaseQueueProject } from "./ReleaseQueuePanel.js";

/** The release queue for the open projects, as a sheet over the Stack. */
export function ReleaseQueueOverlay({
  initialWorkspacePath,
  onClose,
  onFixWithAgent,
}: {
  initialWorkspacePath: string | null;
  onClose: () => void;
  onFixWithAgent: (prompt: string, project: ReleaseQueueProject) => void;
}) {
  const platform = usePlatform();
  const tabs = useTabStore((state) => state.tabs);
  const projects = useMemo(
    () =>
      tabs
        .filter(isWorkspaceTab)
        // Conversation-only workspaces have no repository of their own to release.
        .filter((tab) => tab.workspacePurpose !== "conversation")
        .map(
          (tab): ReleaseQueueProject => ({
            workspacePath: tab.workspacePath,
            ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
            label: tab.label,
          }),
        ),
    [tabs],
  );
  return (
    <ReleaseQueuePanel
      projects={projects}
      initialWorkspacePath={initialWorkspacePath}
      onClose={onClose}
      onOpenUrl={(url) => void platform.openExternal(url)}
      onFixWithAgent={onFixWithAgent}
    />
  );
}
