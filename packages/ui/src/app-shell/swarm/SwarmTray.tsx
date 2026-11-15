import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { HoneycombIcon } from "./HoneycombIcon.js";
import { buildSwarmContinuePrompt } from "./swarmContinuePrompt.js";
import { SwarmRunView } from "./SwarmRunView.js";
import { useSwarmSession } from "./useSwarmSession.js";

/** The swarm's run above the composer: live debate, then the winner to continue with. */
export function SwarmTray({ swarmKey, onUsePlan }: { swarmKey: string; onUsePlan: (prompt: string) => void }) {
  const { intl } = useZCodeIntl();
  const swarm = useSwarmSession(swarmKey, { poll: true });
  const [expanded, setExpanded] = useState(true);
  const run = swarm.session.run;
  if (!run) return null;
  const phase = [...run.events].reverse().find((event) => event.type === "phase");
  const status =
    run.status === "running" && phase?.type === "phase"
      ? intl.formatMessage({ id: `swarm.status.${phase.phase}` }, { round: phase.round })
      : intl.formatMessage({ id: `swarm.status.${run.status}` });
  const Chevron = expanded ? ChevronDown : ChevronUp;
  return (
    <section className="mb-2 flex max-h-[min(60vh,40rem)] flex-col overflow-hidden rounded-2xl border border-amber-500/30 bg-card shadow-xl/5">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <HoneycombIcon className="size-4 text-amber-600 dark:text-amber-300" />
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
          <span className="font-medium">{intl.formatMessage({ id: "swarm.title" })}</span>
          <span className="text-foreground-subtle"> · {status}</span>
        </span>
        {run.status === "running" ? <Loader2 className="size-3.5 animate-spin text-foreground-subtlest" /> : null}
        {run.status === "running" ? (
          <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={() => void swarm.cancel()}>
            <Square className="size-3" />
            {intl.formatMessage({ id: "swarm.stop" })}
          </Button>
        ) : null}
        {run.result?.winner ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onUsePlan(buildSwarmContinuePrompt(run.result!));
              setExpanded(false);
            }}
          >
            {intl.formatMessage({ id: "swarm.continue" }, { letter: run.result.winner.letter })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label={intl.formatMessage({ id: expanded ? "swarm.collapse" : "swarm.expand" })}
          onClick={() => setExpanded((value) => !value)}
        >
          <Chevron className="size-4" />
        </Button>
        {run.status !== "running" ? (
          <Button type="button" variant="ghost" size="icon-md" aria-label={intl.formatMessage({ id: "common.close" })} onClick={swarm.dismiss}>
            <X className="size-4" />
          </Button>
        ) : null}
      </header>
      {expanded ? (
        <div className="min-h-0 overflow-y-auto p-3">
          <p className="mb-3 line-clamp-2 text-ui-sm text-foreground-subtle">{run.task}</p>
          <SwarmRunView
            members={run.members}
            events={run.events}
            status={run.status}
            hideStatus
            {...(run.result ? { result: run.result } : {})}
            {...(run.error ? { error: run.error } : {})}
          />
        </div>
      ) : null}
    </section>
  );
}
