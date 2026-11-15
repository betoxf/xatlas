/**
 * What `runSwarm` and `runDeliberation` share: checking the members, reporting options a CLI
 * can't take, asking members in parallel and dropping the ones that fail, and the ranked vote
 * with its level-vote advisors, who also settle a deliberation's split.
 */
import { unsupportedOptions } from "./commands.js";
import { advisorPrompt, freshVotePrompt, votePrompt } from "./prompts.js";
import {
  advisorsSettled,
  checkWeight,
  combineAdvice,
  parseAdvice,
  parseBallot,
  tallyBallots,
  tiedAtTop,
} from "./vote.js";
import type {
  AskMember,
  SwarmAdvice,
  SwarmAdvisor,
  SwarmBallot,
  SwarmEvent,
  SwarmMember,
  SwarmMemberOption,
  SwarmOptions,
  SwarmPhase,
  SwarmResult,
  SwarmStep,
} from "./types.js";

/** The most debate or discussion rounds a run may ask for. */
export const MAX_ROUNDS = 3;

/** Someone who votes: a plan's author ranks the plans but its own, anyone else (no letter) ranks them all. */
export interface Voter {
  readonly member: SwarmMember;
  readonly letter?: string;
}

export interface SwarmRun {
  readonly options: SwarmOptions;
  readonly onEvent: (event: SwarmEvent) => void;
  readonly dropped: Array<{ memberId: string; phase: SwarmPhase; error: string }>;
  readonly unsupported: Array<{ memberId: string; option: SwarmMemberOption; detail: string }>;
  /** Asks every seat in parallel; drops the ones that fail. */
  askAll<T extends { readonly member: SwarmMember }>(
    seats: readonly T[],
    phase: SwarmPhase,
    prompt: (seat: T) => string,
  ): Promise<Array<{ seat: T; reply: string }>>;
  /** The seats not dropped; throws when fewer than two are left. */
  remaining<T extends { readonly member: SwarmMember }>(seats: readonly T[]): T[];
  /** Whether the member has not been dropped. */
  isLive(memberId: string): boolean;
}

/**
 * Checks the members (two that propose, unique ids, valid weights) and the rounds (a whole
 * number from 0 to `MAX_ROUNDS`, so a run can't make calls without end), reports every option a
 * member's CLI can't take, and returns the run's shared state.
 */
export function startRun(
  options: SwarmOptions,
  ask: AskMember,
  onEvent: (event: SwarmEvent) => void,
): SwarmRun {
  const proposers = options.members.filter((member) => !member.votesOnly);
  const freshVoters = options.members.filter((member) => member.votesOnly);
  if (proposers.length < 2) {
    throw new Error(
      freshVoters.length > 0
        ? "A swarm needs at least two members that propose; fresh voters don't count."
        : "A swarm needs at least two members.",
    );
  }
  const rounds = options.rounds;
  if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= 0 && rounds <= MAX_ROUNDS)) {
    throw new Error(
      `Rounds must be a whole number from 0 to ${MAX_ROUNDS} (got ${String(rounds)}).`,
    );
  }
  const ids = new Set(options.members.map((member) => member.id));
  if (ids.size !== options.members.length) throw new Error("Swarm members need unique ids.");
  for (const member of options.members)
    if (member.weight !== undefined) checkWeight(member.weight, member.id);

  const dropped: SwarmRun["dropped"] = [];
  const context = { cwd: options.cwd, ...(options.signal ? { signal: options.signal } : {}) };
  const isLive = (memberId: string) => !dropped.some((entry) => entry.memberId === memberId);

  const unsupported: SwarmRun["unsupported"] = [];
  for (const member of options.members) {
    for (const { option, detail } of unsupportedOptions(member)) {
      unsupported.push({ memberId: member.id, option, detail });
      onEvent({ type: "unsupported", memberId: member.id, option, detail });
    }
  }

  return {
    options,
    onEvent,
    dropped,
    unsupported,
    isLive,
    async askAll(seats, phase, prompt) {
      const replies = await Promise.all(
        seats.map(async (seat) => {
          try {
            return { seat, reply: await ask(seat.member, prompt(seat), context) };
          } catch (error) {
            if (options.signal?.aborted) throw error;
            const message = error instanceof Error ? error.message : String(error);
            dropped.push({ memberId: seat.member.id, phase, error: message });
            onEvent({ type: "dropped", phase, memberId: seat.member.id, error: message });
            return undefined;
          }
        }),
      );
      return replies.filter((reply) => reply !== undefined);
    },
    remaining(seats) {
      const live = seats.filter((seat) => isLive(seat.member.id));
      if (live.length < 2) {
        throw new Error(
          `Only ${live.length} member${live.length === 1 ? "" : "s"} left; a swarm needs two. ${dropped.map((entry) => `${entry.memberId}: ${entry.error}`).join("; ")}`,
        );
      }
      return live;
    },
  };
}

/**
 * The ranked vote. Each voter ranks the plans (an author never its own), a weighted Borda
 * count orders them (`tallyBallots`), and when the top ends level with at least two readable
 * ballots, `options.advisors` are asked in turn to order the level plans (`askAdvisors`). A
 * voter that gives no readable ranking abstains and is listed in `dropped`.
 */
export async function voteOnPlans(
  run: SwarmRun,
  plans: ReadonlyArray<{ letter: string; memberId: string; plan: string }>,
  voters: readonly Voter[],
  step?: SwarmStep,
): Promise<
  Pick<
    SwarmResult,
    "ballots" | "scores" | "winner" | "tied" | "advisors" | "advisorOrder" | "advisorsNotNeeded"
  >
> {
  const { options, onEvent, dropped } = run;
  const stepField = step ? { step } : {};
  onEvent({ type: "phase", phase: "vote", round: 0, ...stepField });
  const shown = plans.map(({ letter, plan }) => ({ letter, plan }));
  const letters = shown.map(({ letter }) => letter);
  const ballots: SwarmBallot[] = [];
  for (const { seat, reply } of await run.askAll(voters, "vote", (seat) =>
    seat.letter === undefined
      ? freshVotePrompt({ task: options.task, plans: shown })
      : votePrompt({ task: options.task, ownLetter: seat.letter, plans: shown }),
  )) {
    const letter = seat.letter === undefined ? {} : { letter: seat.letter };
    onEvent({
      type: "message",
      phase: "vote",
      round: 0,
      memberId: seat.member.id,
      ...letter,
      text: reply.trim(),
      ...stepField,
    });
    const ballot = parseBallot(reply, {
      voterId: seat.member.id,
      ...(seat.letter === undefined ? {} : { ownLetter: seat.letter }),
      letters,
    });
    if (ballot)
      ballots.push(
        seat.member.weight === undefined ? ballot : { ...ballot, weight: seat.member.weight },
      );
    else {
      dropped.push({
        memberId: seat.member.id,
        phase: "vote",
        error: "gave no readable ranking (abstained)",
      });
      onEvent({
        type: "dropped",
        phase: "vote",
        memberId: seat.member.id,
        error: "gave no readable ranking (abstained)",
      });
    }
  }

  let scores = tallyBallots(
    plans.map(({ letter, memberId }) => ({ letter, memberId })),
    ballots,
  );
  const tied = ballots.length > 0 ? tiedAtTop(scores) : [];
  let advice: AdvisorsAnswer | undefined;
  if (tied.length > 1 && ballots.length >= 2 && options.advisors && options.advisors.length > 0) {
    const prompt = advisorPrompt({
      task: options.task,
      plans: shown.filter(({ letter }) => tied.includes(letter)),
      ballots,
    });
    advice = await askAdvisors(options.advisors, prompt, tied, options.signal, (answer) =>
      onEvent({
        type: "advisor",
        memberId: answer.id,
        tied,
        ...(answer.ranking ? { ranking: answer.ranking } : {}),
        ...(answer.reason ? { reason: answer.reason } : {}),
        ...(answer.error ? { error: answer.error } : {}),
      }),
    );
    if (advice.order) {
      // The advisors' order comes first among the level plans; points are untouched.
      const order = advice.order;
      const level = scores
        .filter((score) => tied.includes(score.letter))
        .sort((a, b) => order.indexOf(a.letter) - order.indexOf(b.letter));
      scores = [...level, ...scores.filter((score) => !tied.includes(score.letter))];
    }
  }
  return {
    ballots,
    scores,
    ...(ballots.length > 0 && scores[0] ? { winner: scores[0] } : {}),
    ...(tied.length > 1 ? { tied } : {}),
    ...(advice ? { advisors: advice.answers } : {}),
    ...(advice?.order ? { advisorOrder: advice.order } : {}),
    ...(advice && advice.notNeeded.length > 0 ? { advisorsNotNeeded: advice.notNeeded } : {}),
  };
}

export interface AdvisorsAnswer {
  readonly answers: SwarmAdvice[];
  /** The level plans in the advisors' order, when they settled it. */
  readonly order?: string[];
  readonly notNeeded: string[];
}

/**
 * Asks the advisors about a level vote, or a deliberation's split (`tied` is then its two
 * positions), in their order: the first two together (a single
 * advisor alone), then one more at a time while `advisorsSettled` says they have not settled it
 * and advisors remain. An advisor that fails or gives no readable ranking is recorded with its
 * error, and the next is asked in its place. When they are done, `combineAdvice` orders the
 * level plans; if that leaves the top level there is no order and the choice is the person's.
 * `onAnswer` hears each answer in the advisors' order. Only an abort is thrown.
 */
export async function askAdvisors(
  advisors: readonly SwarmAdvisor[],
  prompt: string,
  tied: readonly string[],
  signal: AbortSignal | undefined,
  onAnswer: (answer: SwarmAdvice) => void,
): Promise<AdvisorsAnswer> {
  const askOne = async ({ id, ask }: SwarmAdvisor): Promise<SwarmAdvice> => {
    try {
      const advice = parseAdvice(await ask(prompt, signal ? { signal } : {}), tied);
      return advice ? { id, ...advice } : { id, error: "gave no readable ranking" };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { id, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const answers: SwarmAdvice[] = [];
  const rankings = () => answers.flatMap((answer) => (answer.ranking ? [answer.ranking] : []));
  let next = Math.min(2, advisors.length);
  for (const answer of await Promise.all(advisors.slice(0, next).map(askOne))) {
    answers.push(answer);
    onAnswer(answer);
  }
  while (next < advisors.length && !advisorsSettled(rankings(), advisors.length - next)) {
    const answer = await askOne(advisors[next]!);
    next += 1;
    answers.push(answer);
    onAnswer(answer);
  }
  const order = combineAdvice(rankings(), tied);
  return {
    answers,
    ...(order ? { order } : {}),
    notNeeded: advisors.slice(next).map(({ id }) => id),
  };
}
