import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Trophy, XCircle } from "lucide-react";
import type { SwarmEvent, SwarmMember, SwarmResult } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AgentLogo, memberLabel } from "./SwarmSetup.js";

function MessageCard({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-lg border border-border bg-background/50">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-ui-sm text-foreground">
        <Chevron className="size-3.5 shrink-0 text-foreground-subtle" />
        <span className="font-medium">{title}</span>
        {!open ? <span className="min-w-0 flex-1 truncate text-foreground-subtlest">{text.split("\n").find((line) => line.trim())}</span> : null}
      </button>
      {open ? <pre className="max-h-80 overflow-auto px-3 pb-3 font-sans text-ui-sm whitespace-pre-wrap text-foreground-subtle">{text}</pre> : null}
    </div>
  );
}

/** One member's column: its plan letter, status and what it said in each phase. */
function MemberColumn({ member, events, status }: { member: SwarmMember; events: readonly SwarmEvent[]; status: "running" | "done" }) {
  const { intl } = useZCodeIntl();
  const mine = events.filter((event) => "memberId" in event && event.memberId === member.id);
  const letter = mine.find((event) => event.type === "message")?.letter;
  const dropped = mine.find((event) => event.type === "dropped");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
        <AgentLogo agent={member.agent} className="size-4 rounded-[4px]" />
        <span className="truncate">{memberLabel(member)}</span>
        {letter ? <span className="rounded-md bg-hover px-1.5 text-ui-xs text-foreground-subtle">{intl.formatMessage({ id: "swarm.plan" }, { letter })}</span> : null}
        {dropped ? <XCircle className="size-4 text-destructive" /> : status === "running" ? <Loader2 className="size-3.5 animate-spin text-foreground-subtlest" /> : <Check className="size-4 text-foreground-subtle" />}
      </div>
      {dropped && dropped.type === "dropped" ? <p className="text-ui-xs text-destructive">{dropped.error}</p> : null}
      {mine.map((event, index) =>
        event.type === "message" ? (
          <MessageCard
            key={index}
            title={intl.formatMessage({ id: `swarm.phase.${event.phase}` }, { round: event.round })}
            text={event.text}
          />
        ) : null,
      )}
    </div>
  );
}

function Result({ result, members }: { result: SwarmResult; members: readonly SwarmMember[] }) {
  const { intl } = useZCodeIntl();
  const label = (id: string) => {
    const member = members.find((candidate) => candidate.id === id);
    return member ? memberLabel(member) : id;
  };
  const winner = result.winner;
  const plan = winner ? result.plans.find((candidate) => candidate.letter === winner.letter) : undefined;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-background/60 p-4">
      {winner && plan ? (
        <>
          <div className="flex items-center gap-2 text-ui-lg font-semibold text-foreground">
            <Trophy className="size-5 text-foreground-subtle" />
            {intl.formatMessage({ id: "swarm.result.winner" }, { letter: winner.letter, author: label(winner.memberId) })}
          </div>
          <ul className="flex flex-col gap-1 text-ui-sm text-foreground-subtle">
            {result.ballots
              .filter((ballot) => ballot.reasons[winner.letter])
              .map((ballot) => (
                <li key={ballot.voterId}>
                  <span className="font-medium text-foreground">{label(ballot.voterId)}:</span> {ballot.reasons[winner.letter]}
                </li>
              ))}
          </ul>
          <pre className="max-h-96 overflow-auto rounded-lg bg-card p-3 font-sans text-ui-sm whitespace-pre-wrap text-foreground">{plan.plan}</pre>
        </>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">{intl.formatMessage({ id: "swarm.result.noWinner" })}</p>
      )}
      <table className="w-full text-left text-ui-sm tabular-nums">
        <thead className="text-foreground-subtlest">
          <tr>
            <th className="py-1 font-normal">{intl.formatMessage({ id: "swarm.result.plan" })}</th>
            <th className="py-1 font-normal">{intl.formatMessage({ id: "swarm.result.author" })}</th>
            <th className="py-1 font-normal">{intl.formatMessage({ id: "swarm.result.points" })}</th>
            <th className="py-1 font-normal">{intl.formatMessage({ id: "swarm.result.firstPlaces" })}</th>
          </tr>
        </thead>
        <tbody>
          {result.scores.map((score) => (
            <tr key={score.letter} className={cn(score.letter === winner?.letter && "font-medium text-foreground")}>
              <td className="py-1">{score.letter}</td>
              <td className="py-1">{label(score.memberId)}</td>
              <td className="py-1">{score.points}</td>
              <td className="py-1">{score.firstPlaces}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The debate as it happens: one column per member, then the vote and the winner. */
export function SwarmRunView({
  members,
  events,
  status,
  result,
  error,
  hideStatus = false,
}: {
  members: readonly SwarmMember[];
  events: readonly SwarmEvent[];
  status: "running" | "done" | "failed" | "cancelled";
  result?: SwarmResult;
  error?: string;
  /** When the surrounding view shows the status itself. */
  hideStatus?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const phase = [...events].reverse().find((event) => event.type === "phase");
  return (
    <div className="flex flex-col gap-4">
      {!hideStatus || error ? (
        <p className="text-ui-sm text-foreground-subtle">
          {hideStatus
            ? null
            : status === "running" && phase?.type === "phase"
              ? intl.formatMessage({ id: `swarm.status.${phase.phase}` }, { round: phase.round })
              : intl.formatMessage({ id: `swarm.status.${status}` })}
          {error ? ` ${error}` : ""}
        </p>
      ) : null}
      {result ? <Result result={result} members={members} /> : null}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(members.length, 3)}, minmax(0, 1fr))` }}>
        {members.map((member) => (
          <MemberColumn key={member.id} member={member} events={events} status={status === "running" ? "running" : "done"} />
        ))}
      </div>
    </div>
  );
}
