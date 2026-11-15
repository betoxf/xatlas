import { Info, Loader2, TriangleAlert, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RouteNotice } from "./orchestratorRouteStore.js";
import {
  selectRouteDeciding,
  selectRouteSession,
  useOrchestratorRouteStore,
} from "./orchestratorRouteStore.js";

function noticeText(
  notice: RouteNotice,
  formatMessage: (id: string, values?: Record<string, string>) => string,
) {
  switch (notice.kind) {
    case "job":
      return { text: formatMessage("orchestrator.route.becameJob"), detail: notice.reason };
    case "note":
      return { text: formatMessage("orchestrator.route.note", { note: notice.text }) };
    case "failed":
      return { text: formatMessage("orchestrator.route.failed"), detail: notice.detail };
  }
}

/**
 * Above the composer: the orchestrator deciding where a message goes (with a way to send it
 * direct instead), then what became of it.
 */
export function OrchestratorRouteTray({
  routeKey,
  sendKey,
}: {
  routeKey: string;
  sendKey: string;
}) {
  const { intl } = useZCodeIntl();
  const session = useOrchestratorRouteStore(selectRouteSession(routeKey));
  const deciding = useOrchestratorRouteStore(selectRouteDeciding(sendKey));
  const update = useOrchestratorRouteStore((state) => state.update);
  const format = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id }, values);

  if (deciding) {
    const { cancel } = deciding;
    return (
      <div
        role="status"
        className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin text-foreground-subtlest" />
        <span className="min-w-0 flex-1">{format("orchestrator.route.deciding")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>
          {format("orchestrator.route.sendDirect")}
        </Button>
      </div>
    );
  }
  if (!session.notice) return null;
  const { text, detail } = noticeText(session.notice, format);
  const Icon =
    session.notice.kind === "job"
      ? Workflow
      : session.notice.kind === "note"
        ? Info
        : TriangleAlert;
  return (
    <div
      role="status"
      className="mb-2 flex w-full items-start gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
    >
      <Icon
        className={
          session.notice.kind === "failed"
            ? "mt-0.5 size-3.5 shrink-0 text-warning"
            : "mt-0.5 size-3.5 shrink-0 text-foreground-subtle"
        }
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground">{text}</span>
        {detail ? <span className="text-ui-sm text-foreground-subtlest">{detail}</span> : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={format("orchestrator.route.dismiss")}
        onClick={() => update(routeKey, ({ notice: _notice, ...rest }) => rest)}
      >
        <X />
      </Button>
    </div>
  );
}
