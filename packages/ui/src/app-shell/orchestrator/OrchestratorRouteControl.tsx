import { Workflow } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ROUTE_HINT,
  ROUTE_LABEL,
  ROUTE_PREFERENCES,
  type RoutePreference,
} from "./orchestratorLabels.js";
import { useOrchestratorProject, useOrchestratorRoute } from "./useOrchestratorRoute.js";

/**
 * The composer's route choice, beside the swarm button: Auto lets a quick read decide, Direct
 * sends to this conversation as always, Orchestrate makes the message a job.
 */
export function OrchestratorRouteControl({
  routeKey,
  workspacePath,
  workspaceIdentity,
  disabled,
}: {
  routeKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const project = useOrchestratorProject(workspacePath, workspaceIdentity);
  const route = useOrchestratorRoute(routeKey, project);
  if (!route.supported) return null;
  const choice = intl.formatMessage({ id: ROUTE_LABEL[route.preference] });
  const label = intl.formatMessage({ id: "orchestrator.route.trigger" }, { choice });
  const active = route.preference !== "direct";
  return (
    <DropdownMenu>
      <ControlHintTooltip title={label} side="top">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={label}
            className={cn(
              "flex h-7 items-center gap-1 rounded-full px-2 text-ui-sm transition-colors disabled:opacity-50",
              active
                ? "bg-selected text-foreground hover:bg-hover"
                : "text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
          >
            <Workflow className="size-4" />
            {active ? <span>{choice}</span> : null}
          </button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="start" side="top" className="w-80">
        <DropdownMenuLabel>
          {intl.formatMessage({ id: "orchestrator.route.label" })}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={route.preference}
          onValueChange={(value) => route.setPreference(value as RoutePreference)}
        >
          {ROUTE_PREFERENCES.map((preference) => (
            <DropdownMenuRadioItem key={preference} value={preference}>
              <span className="flex min-w-0 flex-col">
                <span>{intl.formatMessage({ id: ROUTE_LABEL[preference] })}</span>
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: ROUTE_HINT[preference] })}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
