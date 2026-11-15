import {
  amendPrompt,
  counterPrompt,
  discussPrompt,
  openingBlock,
  openingPrompt,
  parseAmendment,
  parseOpening,
  parseRecheck,
  parseTurn,
  positionPrompt,
  readPlan,
  recheckPrompt,
  revisePrompt,
  splitRevision,
  turnBlock,
  writePrompt,
  type LabelledIdea,
} from "./deliberatePrompts.js";
import { cutTo, quoted, splitAdvisorPrompt } from "./prompts.js";
import { askAdvisors, startRun, type AdvisorsAnswer } from "./run.js";
import { isMajority } from "./vote.js";
import type {
  AskMember,
  SwarmApproach,
  SwarmDeliberation,
  SwarmEvent,
  SwarmMember,
  SwarmOptions,
  SwarmPhase,
  SwarmResult,
  SwarmScore,
  SwarmStep,
} from "./types.js";

/** The most of a reply an event carries, for the live view. */
const EVENT_CHARS = 20_000;

type Turn = SwarmDeliberation["turns"][number];
type Answer = SwarmDeliberation["amendments"][number];
type Recheck = SwarmDeliberation["rechecks"][number];

interface Seat {
  readonly member: SwarmMember;
}

const weightOf = (member: SwarmMember) => member.weight ?? 1;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const round6 = (value: number) => Number(value.toFixed(6));

/** A, B, …, Z, then A2, B2, …: one letter per member for the whole run. */
export function letterAt(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26 ? letter : `${letter}${Math.floor(index / 26) + 1}`;
}

/**
 * Runs a deliberation: the members discuss the request and reach one plan. Nobody votes.
 *
 * Each member keeps one letter (A, B, …; proposers first, then fresh readers) and every prompt
 * shows letters, never names, and carries the request word for word with its anchor: improve
 * how it is built, not what was asked; ideas beyond it are kept apart for the person.
 *
 * 1. Opening. Each proposer alone: what it found with sources, up to three approaches with
 *    their trade-offs, questions for the others, and its pick. Approaches are pooled as
 *    Approach 1, 2, … with their proposer's letter.
 * 2. Discussion (`rounds`, 0 to 3, default 1). Each reads the discussion so far (newest first
 *    within `TRANSCRIPT_CHARS`), answers the others by letter, adds what it knows, may offer a
 *    merge (not in the last round, where only its offerer could back it), and gives one
 *    `stand`: the approach it backs. With 0 rounds the opening picks count.
 * 3. Agreement. When more than half of the proposers' weight stands on one approach (a member
 *    whose answer can't be read backs nothing but still counts in the whole), its heaviest
 *    backer writes the plan in fixed sections (the earliest on a tie; the next if it fails).
 * 4. Amendments. Every other proposer and every fresh reader answers: does it still do what
 *    was asked (no blocks), amendments, and at most one blocking concern. An unreadable answer
 *    is no block. If there is any amendment or block, the writer revises once, its answers kept
 *    apart from the plan; then each member that blocked is asked once whether it still does (an
 *    unreadable answer leaves its block standing). A writer that fails to revise keeps the plan
 *    as it was, and nobody is asked again.
 * 5. The plan stands when more than half of the weight of the writer and the members who
 *    answered has no block left. Exactly half is not enough. Remaining blocks are kept as dissent.
 * 6. A split (no majority in 3, no backer wrote a plan, or a plan that does not stand in 5) is
 *    not voted on. Two positions are written: the two leading approaches by their heaviest
 *    backers, or the revised plan and a counter-plan by the heaviest member still blocking.
 *    They go to `options.advisors` with what each member said about them; if the advisors
 *    settle it, their choice is the `winner`, otherwise the choice is the person's. `tied`
 *    names both positions.
 *
 * A member that fails a step is dropped, and its weight leaves the count; fewer than two
 * proposers left is an error.
 */
export async function runDeliberation(
  options: SwarmOptions,
  ask: AskMember,
  onEvent: (event: SwarmEvent) => void = () => {},
): Promise<SwarmResult> {
  const run = startRun(options, ask, onEvent);
  const { askAll, remaining, isLive, dropped, unsupported } = run;
  const rounds = options.rounds ?? 1;
  const place = new Map(options.members.map((member, index) => [member.id, index]));
  /** Heaviest first, then in the order the members were given. */
  const byWeight = (a: Seat, b: Seat) =>
    weightOf(b.member) - weightOf(a.member) || place.get(a.member.id)! - place.get(b.member.id)!;
  const proposers = options.members.filter((member) => !member.votesOnly);
  const readers = options.members.filter((member) => member.votesOnly);
  const voices = [...proposers, ...readers].map((member, index) => ({
    memberId: member.id,
    letter: letterAt(index),
  }));
  const letterOf = new Map(voices.map((entry) => [entry.memberId, entry.letter]));
  const letter = (seat: Seat) => letterOf.get(seat.member.id)!;
  /** The proposers' letters, which every prompt lists. */
  const letters = proposers.map((member) => letterOf.get(member.id)!);
  const fresh = (seat: Seat) => Boolean(seat.member.votesOnly);
  let seats: Seat[] = proposers.map((member) => ({ member }));
  const freshSeats: Seat[] = readers.map((member) => ({ member }));
  const approaches: SwarmApproach[] = [];
  const turns: Turn[] = [];
  /** What was said, turn by turn, as the members read it. */
  const transcript: string[] = [];
  const shown = (list: readonly SwarmApproach[]): LabelledIdea[] =>
    list.map(({ label, memberId, name, idea, tradeoff }) => ({
      label,
      from: letterOf.get(memberId) ?? "?",
      name,
      idea,
      tradeoff,
    }));
  const phase = (kind: SwarmPhase, round: number, step: SwarmStep) =>
    onEvent({ type: "phase", phase: kind, round, step });
  const message = (seat: Seat, kind: SwarmPhase, round: number, step: SwarmStep, reply: string) =>
    onEvent({
      type: "message",
      phase: kind,
      round,
      memberId: seat.member.id,
      letter: letter(seat),
      text: cutTo(reply.trim(), EVENT_CHARS),
      step,
    });

  // 1. Opening.
  phase("propose", 0, "opening");
  for (const { seat, reply } of await askAll(seats, "propose", (seat) =>
    openingPrompt({ task: options.task, letter: letter(seat), letters }),
  )) {
    message(seat, "propose", 0, "opening", reply);
    const opening = parseOpening(reply);
    if (!opening) {
      turns.push({ round: 0, memberId: seat.member.id });
      continue;
    }
    const labels = opening.approaches.map((idea) => {
      const label = String(approaches.length + 1);
      approaches.push({ label, memberId: seat.member.id, ...idea });
      return label;
    });
    const pick = opening.pick === undefined ? undefined : labels[opening.pick];
    turns.push({
      round: 0,
      memberId: seat.member.id,
      ...(pick ? { stand: pick } : {}),
      ...(opening.findings.length > 0 ? { findings: opening.findings } : {}),
      ...(opening.questions.length > 0 ? { questions: opening.questions } : {}),
      ...(opening.beyond ? { beyond: opening.beyond } : {}),
    });
    transcript.push(openingBlock(letter(seat), opening, labels));
  }
  seats = remaining(seats);
  if (approaches.length === 0) {
    throw new Error("No member suggested a readable approach, so there is nothing to discuss.");
  }

  // 2. Discussion.
  let stands = new Map(
    turns.flatMap((turn) => (turn.stand ? [[turn.memberId, turn.stand] as const] : [])),
  );
  /** Where each member stood in the last round, in its words, for the advisors. */
  const lastWord = new Map<string, string>();
  for (let round = 1; round <= rounds; round += 1) {
    phase("debate", round, "discuss");
    const pool = shown(approaches);
    const labels = pool.map(({ label }) => label);
    const said = [...transcript];
    const replies = await askAll(seats, "debate", (seat) =>
      discussPrompt({
        task: options.task,
        letter: letter(seat),
        letters,
        round,
        last: round === rounds,
        approaches: pool,
        transcript: said,
      }),
    );
    stands = new Map();
    lastWord.clear();
    for (const { seat, reply } of replies) {
      message(seat, "debate", round, "discuss", reply);
      const turn = parseTurn(
        reply,
        labels,
        letters.filter((entry) => entry !== letter(seat)),
      );
      if (!turn) {
        turns.push({ round, memberId: seat.member.id });
        continue;
      }
      let merged: string | undefined;
      // The last round takes no new merge, so a stand on "merged" there backs nothing.
      if (turn.merged && round < rounds) {
        merged = String(approaches.length + 1);
        approaches.push({ label: merged, memberId: seat.member.id, ...turn.merged, round });
      }
      const stand = turn.stand === "merged" ? merged : turn.stand;
      if (stand) stands.set(seat.member.id, stand);
      turns.push({
        round,
        memberId: seat.member.id,
        ...(stand ? { stand } : {}),
        ...(turn.why ? { why: turn.why } : {}),
        ...(turn.research.length > 0 ? { findings: turn.research } : {}),
        ...(turn.replies.length > 0 ? { replies: turn.replies } : {}),
        ...(merged ? { merged } : {}),
        ...(turn.beyond ? { beyond: turn.beyond } : {}),
      });
      transcript.push(turnBlock(letter(seat), round, turn, stand, merged));
      if (stand)
        lastWord.set(
          seat.member.id,
          `stands on Approach ${stand}.${turn.why ? ` Why: ${quoted(turn.why)}` : ""}`,
        );
    }
    seats = remaining(seats);
  }
  if (rounds === 0) {
    for (const [memberId, stand] of stands) lastWord.set(memberId, `would pick Approach ${stand}.`);
  }

  // 3. Agreement.
  const backersOf = (label: string) =>
    seats.filter((seat) => stands.get(seat.member.id) === label).sort(byWeight);
  const backing = (label: string) => sum(backersOf(label).map((seat) => weightOf(seat.member)));
  const whole = sum(seats.map((seat) => weightOf(seat.member)));
  const majority = approaches.find((approach) => isMajority(backing(approach.label), whole));
  const answers: Answer[] = [];
  const rechecks: Recheck[] = [];
  const blocks = new Map<string, string>();
  let revision: SwarmDeliberation["revision"];
  let writer: Seat | undefined;
  let plan = "";
  let split: SwarmDeliberation["split"] = majority ? undefined : "no-majority";
  const deliberation = (agreed: boolean): SwarmDeliberation => ({
    voices,
    approaches,
    turns,
    ...(majority ? { majority: majority.label } : {}),
    ...(writer ? { writer: writer.member.id } : {}),
    amendments: answers,
    ...(revision ? { revision } : {}),
    rechecks,
    dissent: [...blocks].map(([memberId, block]) => ({ memberId, block })),
    agreed,
    ...(split ? { split } : {}),
  });
  const base = {
    task: options.task,
    debate: [],
    ballots: [],
    dropped,
    members: options.members,
    unsupported,
  };

  if (majority) {
    phase("propose", 0, "write");
    const others = shown(approaches.filter((approach) => approach !== majority));
    for (const candidate of backersOf(majority.label)) {
      const [answer] = await askAll([candidate], "propose", () =>
        writePrompt({
          task: options.task,
          letter: letter(candidate),
          letters,
          agreed: shown([majority])[0]!,
          others,
          transcript,
        }),
      );
      if (!answer) {
        seats = remaining(seats);
        continue;
      }
      message(candidate, "propose", 0, "write", answer.reply);
      // Anything but a plan with its sections (a refusal, a note) counts as no plan.
      const written = readPlan(answer.reply);
      if (written) {
        writer = candidate;
        plan = written;
        break;
      }
    }
    if (!writer) split = "no-plan";
  }

  if (writer) {
    const author = writer;
    // 4. Amendments.
    phase("debate", rounds + 1, "amend");
    const judges = [
      ...seats.filter((seat) => seat !== author),
      ...freshSeats.filter((seat) => isLive(seat.member.id)),
    ];
    const amended: Array<{ from: string; text: string }> = [];
    for (const { seat, reply } of await askAll(judges, "debate", (seat) =>
      amendPrompt({ task: options.task, letter: letter(seat), letters, fresh: fresh(seat), plan }),
    )) {
      message(seat, "debate", rounds + 1, "amend", reply);
      const answer = parseAmendment(reply);
      if (!answer) {
        answers.push({ memberId: seat.member.id, read: false });
        continue;
      }
      const concern = [
        ...(answer.onRequest
          ? []
          : [`It no longer does what was asked${answer.drift ? `: ${answer.drift}` : "."}`]),
        ...(answer.block ? [answer.block] : []),
      ].join(" Also: ");
      if (concern) blocks.set(seat.member.id, concern);
      for (const text of answer.amendments) amended.push({ from: letter(seat), text });
      answers.push({
        memberId: seat.member.id,
        read: true,
        onRequest: answer.onRequest,
        ...(answer.drift ? { drift: answer.drift } : {}),
        ...(answer.amendments.length > 0 ? { amendments: answer.amendments } : {}),
        ...(concern ? { block: concern } : {}),
      });
    }
    // A judge that failed is dropped and its weight leaves the count: with two proposers the
    // writer would then carry its own plan alone, so the usual two-member rule applies here too.
    seats = remaining(seats);

    // The revision, once, and the one "do you still block" round.
    if (amended.length > 0 || blocks.size > 0) {
      phase("propose", 0, "revise");
      const blockList = [...blocks].map(([memberId, text]) => ({
        from: letterOf.get(memberId)!,
        text,
      }));
      const [answer] = await askAll([author], "propose", () =>
        revisePrompt({
          task: options.task,
          letter: letter(author),
          letters,
          plan,
          amendments: amended,
          blocks: blockList,
        }),
      );
      if (answer) message(author, "propose", 0, "revise", answer.reply);
      const revised = answer ? splitRevision(answer.reply) : undefined;
      // A revision counts only when it is a plan; otherwise it is a blank one.
      const revisedPlan = revised ? readPlan(revised.plan) : "";
      if (revised && revisedPlan) {
        plan = revisedPlan;
        revision = { answers: revised.answers };
        const blockers = [...seats, ...freshSeats].filter(
          (seat) => blocks.has(seat.member.id) && isLive(seat.member.id),
        );
        if (blockers.length > 0) {
          phase("debate", rounds + 2, "recheck");
          for (const { seat, reply } of await askAll(blockers, "debate", (seat) =>
            recheckPrompt({
              task: options.task,
              letter: letter(seat),
              letters,
              fresh: fresh(seat),
              plan,
              concern: blocks.get(seat.member.id)!,
              answers: revised.answers,
            }),
          )) {
            message(seat, "debate", rounds + 2, "recheck", reply);
            const recheck = parseRecheck(reply);
            if (!recheck) {
              rechecks.push({ memberId: seat.member.id, read: false, stillBlocks: true });
              continue;
            }
            if (recheck.stillBlocks) {
              if (recheck.block) blocks.set(seat.member.id, recheck.block);
            } else blocks.delete(seat.member.id);
            rechecks.push({
              memberId: seat.member.id,
              read: true,
              stillBlocks: recheck.stillBlocks,
              ...(recheck.block ? { block: recheck.block } : {}),
            });
          }
        }
      }
      seats = remaining(seats);
    }

    // 5. Does it stand? Members dropped on the way leave both the whole and the blocks.
    // Deleting the entry being visited is safe while iterating a Map.
    for (const memberId of blocks.keys()) if (!isLive(memberId)) blocks.delete(memberId);
    const counted = [author, ...judges].filter((seat) => isLive(seat.member.id));
    const total = sum(counted.map((seat) => weightOf(seat.member)));
    const blocking = sum(
      counted.filter((seat) => blocks.has(seat.member.id)).map((seat) => weightOf(seat.member)),
    );
    const plans = [{ letter: letter(author), memberId: author.member.id, plan }];
    if (isMajority(total - blocking, total)) {
      const supporters = counted.filter((seat) => !blocks.has(seat.member.id)).length;
      const score: SwarmScore = {
        letter: letter(author),
        memberId: author.member.id,
        points: round6(total - blocking),
        firstPlaces: supporters,
        weightedFirstPlaces: round6(total - blocking),
      };
      return { ...base, plans, scores: [score], winner: score, deliberation: deliberation(true) };
    }

    // 6. Split after the revision: the plan, and a counter-plan by the heaviest still blocking.
    split = "blocked";
    const counter = counted.filter((seat) => blocks.has(seat.member.id)).sort(byWeight)[0]!;
    phase("propose", 0, "position");
    const [answer] = await askAll([counter], "propose", () =>
      counterPrompt({
        task: options.task,
        letter: letter(counter),
        letters,
        fresh: fresh(counter),
        plan,
        concern: blocks.get(counter.member.id)!,
      }),
    );
    if (answer) message(counter, "propose", 0, "position", answer.reply);
    seats = remaining(seats);
    const counterPlan = answer ? readPlan(answer.reply) : "";
    if (counterPlan)
      plans.push({ letter: letter(counter), memberId: counter.member.id, plan: counterPlan });
    const support = new Map([
      [author.member.id, total - blocking],
      [counter.member.id, blocking],
    ]);
    const said = [
      ...answers.flatMap((entry) => {
        if (!entry.read) return [];
        const parts = [
          entry.onRequest === false ? "said it no longer does what was asked" : "",
          entry.amendments?.length
            ? `amendments: ${entry.amendments.map((text) => quoted(text)).join(", ")}`
            : "",
          entry.block ? `blocked: ${quoted(entry.block)}` : "",
        ].filter(Boolean);
        return parts.length > 0
          ? [`${letterOf.get(entry.memberId)} on Plan ${letter(author)}: ${parts.join(". ")}`]
          : [`${letterOf.get(entry.memberId)} on Plan ${letter(author)}: no block, no amendment.`];
      }),
      ...(revision?.answers
        ? [`${letter(author)}, its writer, answered: ${quoted(revision.answers)}`]
        : []),
      ...rechecks.flatMap((entry) =>
        entry.read
          ? [
              `${letterOf.get(entry.memberId)} after the revision: ${entry.stillBlocks ? `still blocks${entry.block ? `: ${quoted(entry.block)}` : "."}` : "no longer blocks."}`,
            ]
          : [],
      ),
    ];
    return settle(plans, support, said);
  }

  // 6. Split with no majority (or no plan for it): the two leading approaches as positions.
  seats = remaining(seats);
  const leaders = approaches
    .map((approach, index) => ({
      approach,
      index,
      weight: backing(approach.label),
      backers: backersOf(approach.label).length,
    }))
    .sort((a, b) => b.weight - a.weight || b.backers - a.backers || a.index - b.index)
    .slice(0, 2)
    .map(({ approach }) => approach);
  const used = new Set<string>();
  const entries = leaders.map((approach) => {
    const free = (seat: Seat) => !used.has(seat.member.id);
    const proposer = seats.find((seat) => seat.member.id === approach.memberId);
    const seat =
      backersOf(approach.label).find(free) ??
      (proposer && free(proposer) ? proposer : undefined) ??
      [...seats].sort(byWeight).find(free)!;
    used.add(seat.member.id);
    return { member: seat.member, seat, approach, plan: "" };
  });
  phase("propose", 0, "position");
  for (const { seat: entry, reply } of await askAll(entries, "propose", (entry) =>
    positionPrompt({
      task: options.task,
      letter: letter(entry.seat),
      letters,
      approach: shown([entry.approach])[0]!,
      transcript,
    }),
  )) {
    message(entry.seat, "propose", 0, "position", reply);
    entry.plan = readPlan(reply);
  }
  const plans = entries
    .filter((entry) => entry.plan && isLive(entry.member.id))
    .map(({ seat, member, plan: written }) => ({
      letter: letter(seat),
      memberId: member.id,
      plan: written,
    }));
  seats = remaining(seats);
  const approachOf = new Map(entries.map((entry) => [letter(entry.seat), entry.approach]));
  const support = new Map(
    entries.map((entry) => [entry.member.id, backing(entry.approach.label)] as const),
  );
  const planFor = (label: string | undefined) =>
    plans.find((entry) => approachOf.get(entry.letter)?.label === label)?.letter;
  const said = [...lastWord].flatMap(([memberId, word]) => {
    if (!isLive(memberId)) return [];
    const position = planFor(stands.get(memberId));
    return [
      `${letterOf.get(memberId)} ${word}${position ? ` (the approach of Plan ${position})` : ""}`,
    ];
  });
  return settle(plans, support, said);

  /**
   * A split: two positions go to the advisors, who are sent them and what each member said
   * and nothing else. Fewer than two positions leaves the choice to the person, with no
   * `tied` and no `winner`.
   */
  async function settle(
    plans: ReadonlyArray<{ letter: string; memberId: string; plan: string }>,
    support: ReadonlyMap<string, number>,
    said: readonly string[],
  ): Promise<SwarmResult> {
    const scoreOf = (entry: { letter: string; memberId: string }): SwarmScore => {
      const weight = round6(support.get(entry.memberId) ?? 0);
      return {
        letter: entry.letter,
        memberId: entry.memberId,
        points: weight,
        firstPlaces: 0,
        weightedFirstPlaces: weight,
      };
    };
    let scores = plans.map(scoreOf);
    if (plans.length < 2) return { ...base, plans, scores, deliberation: deliberation(false) };
    const tied = plans.map((entry) => entry.letter);
    let advice: AdvisorsAnswer | undefined;
    let skipped: string | undefined;
    const prompt =
      options.advisors && options.advisors.length > 0
        ? splitAdvisorPrompt({ task: options.task, plans, said })
        : undefined;
    if (options.advisors && options.advisors.length > 0 && !prompt) {
      skipped =
        "The request is too long to send to the advisors word for word with enough of both plans, so they were not asked.";
    }
    if (options.advisors && prompt) {
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
    }
    const order = advice?.order;
    if (order)
      scores = [...scores].sort((a, b) => order.indexOf(a.letter) - order.indexOf(b.letter));
    return {
      ...base,
      plans,
      scores,
      ...(order ? { winner: scores[0]! } : {}),
      tied,
      ...(advice ? { advisors: advice.answers } : {}),
      ...(order ? { advisorOrder: order } : {}),
      ...(advice && advice.notNeeded.length > 0 ? { advisorsNotNeeded: advice.notNeeded } : {}),
      ...(skipped ? { advisorsSkipped: skipped } : {}),
      deliberation: deliberation(false),
    };
  }
}
