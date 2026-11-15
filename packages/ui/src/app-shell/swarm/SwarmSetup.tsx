import { Plus, X } from "lucide-react";
import type { AvailableAgent, SwarmMember } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";

type SwarmAgentId = SwarmMember["agent"];

export const SWARM_AGENTS: Readonly<Record<SwarmAgentId, { name: string; logo: string }>> = {
  claude: { name: "Claude Code", logo: "anthropic" },
  codex: { name: "Codex", logo: "openai" },
  opencode: { name: "OpenCode", logo: "opencode" },
  gemini: { name: "Gemini CLI", logo: "gemini" },
};

export function AgentLogo({ agent, className }: { agent: SwarmAgentId; className?: string }) {
  return <ProviderLogo logo={{ type: "builtin", key: SWARM_AGENTS[agent].logo }} className={className} />;
}

export function memberLabel(member: SwarmMember): string {
  return `${SWARM_AGENTS[member.agent].name} · ${member.model ?? "default"}`;
}

export function makeMember(agent: SwarmAgentId, model?: string): SwarmMember {
  return { id: model ? `${agent}:${model}` : agent, agent, ...(model ? { model } : {}) };
}

/** Pick the members (any agent, any of its models) and how many debate rounds. */
export function SwarmSetup({
  agents,
  members,
  rounds,
  onMembersChange,
  onRoundsChange,
}: {
  agents: readonly AvailableAgent[] | null;
  members: readonly SwarmMember[];
  rounds: number;
  onMembersChange: (members: SwarmMember[]) => void;
  onRoundsChange: (rounds: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const add = (member: SwarmMember) => {
    if (!members.some((existing) => existing.id === member.id)) onMembersChange([...members, member]);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {members.map((member) => (
          <span
            key={member.id}
            className="flex h-8 items-center gap-2 rounded-full border border-border bg-background/60 pr-1 pl-2 text-ui-sm text-foreground"
          >
            <AgentLogo agent={member.agent} className="size-4 rounded-[4px]" />
            {memberLabel(member)}
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "swarm.member.remove" }, { name: memberLabel(member) })}
              onClick={() => onMembersChange(members.filter((existing) => existing.id !== member.id))}
              className="flex size-6 items-center justify-center rounded-full text-foreground-subtle hover:bg-hover"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="gap-1.5" disabled={!agents}>
              <Plus className="size-4" />
              {intl.formatMessage({ id: "swarm.member.add" })}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-96 min-w-64 overflow-y-auto">
            {(agents ?? []).map((agent, index) => (
              <div key={agent.agent}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="flex items-center gap-2">
                  <AgentLogo agent={agent.agent} className="size-4 rounded-[4px]" />
                  {SWARM_AGENTS[agent.agent].name}
                  <span className="truncate font-normal text-foreground-subtlest">{agent.detail}</span>
                </DropdownMenuLabel>
                {agent.ready
                  ? [undefined, ...(agent.models ?? []).slice(0, 12)].map((model) => (
                      <DropdownMenuItem key={model ?? "default"} onSelect={() => add(makeMember(agent.agent, model))}>
                        {model ?? intl.formatMessage({ id: "swarm.member.defaultModel" })}
                      </DropdownMenuItem>
                    ))
                  : null}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "swarm.rounds" })}
        {[0, 1, 2, 3].map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onRoundsChange(value)}
            className={`h-7 min-w-7 rounded-md px-2 tabular-nums ${value === rounds ? "bg-foreground text-background" : "text-foreground-subtle hover:bg-hover"}`}
          >
            {value}
          </button>
        ))}
        <span className="text-foreground-subtlest">{intl.formatMessage({ id: "swarm.rounds.hint" })}</span>
      </div>
    </div>
  );
}
