import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { HoneycombIcon } from "./HoneycombIcon.js";
import { SwarmSetup } from "./SwarmSetup.js";
import { useSwarmSession } from "./useSwarmSession.js";

/**
 * The composer's swarm switch. While it's on, sending the message makes the chosen
 * models plan it, debate each other's plans and vote, instead of one agent answering.
 */
export function SwarmComposerToggle({ swarmKey, disabled }: { swarmKey: string; disabled?: boolean }) {
  const { intl } = useZCodeIntl();
  const swarm = useSwarmSession(swarmKey);
  if (!swarm.supported) return null;
  const active = swarm.session.active;
  const label = intl.formatMessage({ id: active ? "swarm.toggle.on" : "swarm.toggle.off" }, { count: swarm.members.length });
  return (
    <Popover>
      <ControlHintTooltip title={label} side="top">
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "flex h-7 items-center gap-1 rounded-full px-2 text-ui-sm transition-colors disabled:opacity-50",
              active
                ? "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
                : "text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
          >
            <HoneycombIcon className="size-4" />
            {active ? <span className="tabular-nums">{swarm.members.length}</span> : null}
          </button>
        </PopoverTrigger>
      </ControlHintTooltip>
      <PopoverContent align="start" side="top" className="flex w-[26rem] flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <HoneycombIcon className="mt-0.5 size-5 text-amber-600 dark:text-amber-300" />
          <div className="min-w-0 flex-1">
            <p className="text-ui-md font-medium text-foreground">{intl.formatMessage({ id: "swarm.title" })}</p>
            <p className="text-ui-sm text-foreground-subtle">{intl.formatMessage({ id: "swarm.description" })}</p>
          </div>
          <Switch checked={active} onCheckedChange={swarm.setActive} aria-label={label} />
        </div>
        <SwarmSetup
          agents={swarm.agents}
          members={swarm.members}
          rounds={swarm.session.rounds}
          onMembersChange={swarm.setMembers}
          onRoundsChange={swarm.setRounds}
        />
        {swarm.members.length < 2 ? (
          <p className="text-ui-xs text-warning">{intl.formatMessage({ id: "swarm.needTwo" })}</p>
        ) : null}
        <p className="text-ui-xs text-foreground-subtlest">{intl.formatMessage({ id: "swarm.readOnlyNote" })}</p>
      </PopoverContent>
    </Popover>
  );
}
