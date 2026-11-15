import { debatePrompt, extractCritique, extractRevisedPlan, proposePrompt } from "./prompts.js";
import { startRun, voteOnPlans, type Voter } from "./run.js";
import type { AskMember, SwarmEvent, SwarmMember, SwarmOptions, SwarmResult } from "./types.js";

interface Seat {
  readonly member: SwarmMember;
  readonly letter: string;
  plan: string;
}

/**
 * Runs a swarm: every member plans the task on its own, then in each debate round reads
 * all plans (and the last round's critiques), critiques them and revises its own, and
 * finally ranks the others' plans. Fresh voters (`votesOnly`) skip all that and rank every
 * plan at the end. A weighted Borda count picks the winner (see `tallyBallots`). Plans are
 * shown by letter only. A member that fails a step is dropped; at least two that propose
 * must remain, and fresh voters don't count towards them. Options a member's CLI can't
 * take are reported once, before the run starts.
 *
 * When the vote ends level at the top and `options.advisors` are set, they are asked in order
 * to rank the level plans: the first two together, then the next while they have not settled
 * it (see `voteOnPlans`). Their combined order replaces the order by first places and letter.
 * They never change points, and nobody is asked when the vote decided or when fewer than two
 * members gave a readable ballot (that is no vote to break: the choice goes to the person). If
 * they don't settle it the vote stays level: `result.tied` says so either way.
 */
export async function runSwarm(
  options: SwarmOptions,
  ask: AskMember,
  onEvent: (event: SwarmEvent) => void = () => {},
): Promise<SwarmResult> {
  const run = startRun(options, ask, onEvent);
  const { askAll, remaining, dropped, unsupported } = run;
  const proposers = options.members.filter((member) => !member.votesOnly);
  const freshVoters = options.members.filter((member) => member.votesOnly);
  const debate: Array<{ round: number; memberId: string; critique: string }> = [];

  let seats: Seat[] = proposers.map((member, index) => ({
    member,
    letter: String.fromCharCode(65 + index),
    plan: "",
  }));

  onEvent({ type: "phase", phase: "propose", round: 0 });
  for (const { seat, reply } of await askAll(seats, "propose", () => proposePrompt(options.task, seats.length))) {
    seat.plan = reply.trim();
    onEvent({ type: "message", phase: "propose", round: 0, memberId: seat.member.id, letter: seat.letter, text: seat.plan });
  }
  seats = remaining(seats);

  let previousCritiques: Array<{ letter: string; critique: string }> = [];
  for (let round = 1; round <= (options.rounds ?? 1); round += 1) {
    onEvent({ type: "phase", phase: "debate", round });
    const plans = seats.map(({ letter, plan }) => ({ letter, plan }));
    const replies = await askAll(seats, "debate", (seat) =>
      debatePrompt({ task: options.task, ownLetter: seat.letter, plans, previousCritiques }),
    );
    previousCritiques = [];
    for (const { seat, reply } of replies) {
      const critique = extractCritique(reply);
      seat.plan = extractRevisedPlan(reply) ?? seat.plan;
      previousCritiques.push({ letter: seat.letter, critique });
      debate.push({ round, memberId: seat.member.id, critique });
      onEvent({ type: "message", phase: "debate", round, memberId: seat.member.id, letter: seat.letter, text: reply.trim() });
    }
    seats = remaining(seats);
  }

  const plans = seats.map(({ letter, member, plan }) => ({ letter, memberId: member.id, plan }));
  const voters: Voter[] = [...seats, ...freshVoters.map((member) => ({ member }))];
  const { ballots, scores, winner, tied, advisors, advisorOrder, advisorsNotNeeded } = await voteOnPlans(run, plans, voters);
  return {
    task: options.task,
    plans,
    debate,
    ballots,
    scores,
    ...(winner ? { winner } : {}),
    dropped,
    members: options.members,
    unsupported,
    ...(tied ? { tied } : {}),
    ...(advisors ? { advisors } : {}),
    ...(advisorOrder ? { advisorOrder } : {}),
    ...(advisorsNotNeeded ? { advisorsNotNeeded } : {}),
  };
}
