import type { SwarmDeliberation, SwarmMember, SwarmResult } from "./types.js";

/** Whole points as they are; a fresh voter's fractions to two decimals. */
const points = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** One member's settings in the members table, or `undefined` when they're all defaults. */
function memberRow(member: SwarmMember): string | undefined {
  if (member.weight === undefined && !member.votesOnly && !member.effort && member.fast === undefined) return undefined;
  return `| ${member.id} | ${member.votesOnly ? "fresh voter" : "proposes"} | ${member.weight ?? 1} | ${member.effort ?? "default"} | ${member.fast ? "asked" : "default"} |`;
}

/**
 * The run as Markdown: winner and why, the members' settings, the vote, every final plan, the
 * debate. A deliberation that agreed shows who wrote the plan, the answers to it, the dissent it
 * carries and the plan; one that split says why, what the advisors chose (or that the choice is
 * the person's) and both positions. Either way the ideas beyond the request, the approaches and
 * the discussion follow. Nobody votes in a deliberation.
 */
export function formatSwarmReport(result: SwarmResult): string {
  const lines = [`# Swarm: ${result.task.split("\n")[0]}`, ""];
  const deliberation = result.deliberation;
  if (deliberation) lines.push(...deliberationLines(result, deliberation), ...memberLines(result), ...droppedLines(result), ...discussionLines(result, deliberation));
  else lines.push(...contestLines(result));
  return `${lines.join("\n")}\n`;
}

const SPLIT: Record<NonNullable<SwarmDeliberation["split"]>, string> = {
  "no-majority": "no approach was backed by more than half of the members' weight",
  "no-plan": "no member that backed the agreed approach wrote a plan",
  blocked: "the plan still had too much blocking after its one revision",
};

/** The deliberation's outcome: the plan that stood and what was said about it, or the split. */
function deliberationLines(result: SwarmResult, deliberation: SwarmDeliberation): string[] {
  const lines: string[] = [];
  // A run saved before deliberations discussed may lack these lists.
  const voices = new Map((deliberation.voices ?? []).map((entry) => [entry.memberId, entry.letter]));
  const who = (id: string | undefined) => (id ? (voices.has(id) ? `${voices.get(id)} (${id})` : id) : "?");
  const approach = (label: string | undefined) => {
    const found = (deliberation.approaches ?? []).find((entry) => entry.label === label);
    return found ? `Approach ${found.label}: ${found.name}` : `Approach ${label ?? "?"}`;
  };
  const weightOf = (id: string) => result.members?.find((member) => member.id === id)?.weight ?? 1;
  const dissent = deliberation.dissent ?? [];
  if (deliberation.agreed) {
    const standing = result.winner?.points ?? 0;
    const total = standing + dissent.reduce((sum, entry) => sum + weightOf(entry.memberId), 0);
    lines.push(`**The plan stands.** More than half of the weight backed ${approach(deliberation.majority)}, and ${who(deliberation.writer)} wrote the plan${deliberation.revision ? " and revised it once" : ""}. Weight ${points(standing)} of ${points(Number(total.toFixed(6)))} has no block left (the writer counted). Nobody voted.`, "");
  } else {
    const why = deliberation.split ? SPLIT[deliberation.split] : "the members did not agree";
    lines.push(`**Split:** ${why}. ${result.plans.length >= 2 ? `Two positions were written, Plans ${result.plans.map((plan) => plan.letter).join(" and ")}; nobody voted.` : "There were not two positions to choose between, so the choice is yours."}`, "");
    if (deliberation.majority) lines.push(`More than half of the weight backed ${approach(deliberation.majority)}${deliberation.writer ? `, and ${who(deliberation.writer)} wrote its plan` : ""}.`, "");
  }
  const answers = deliberation.amendments ?? [];
  if (answers.length > 0) {
    lines.push("Answers to the plan:");
    for (const entry of answers) {
      const said = !entry.read
        ? "said nothing readable (no block)"
        : [entry.amendments?.length ? `amendments: ${entry.amendments.join("; ")}` : "", entry.block ? `blocked: ${entry.block}` : ""].filter(Boolean).join(". ") || "no block, no amendment";
      lines.push(`- ${who(entry.memberId)}: ${said}`);
    }
    lines.push("");
  }
  if (deliberation.revision?.answers) lines.push("The writer's answers:", "", deliberation.revision.answers, "");
  const rechecks = deliberation.rechecks ?? [];
  if (rechecks.length > 0) {
    lines.push("After the revision:");
    for (const entry of rechecks) lines.push(`- ${who(entry.memberId)}: ${!entry.read ? "said nothing readable (its block stands)" : entry.stillBlocks ? `still blocks${entry.block ? `: ${entry.block}` : ""}` : "no longer blocks"}`);
    lines.push("");
  }
  if (deliberation.agreed && dissent.length > 0) {
    lines.push("**Dissent kept** (the plan stands without these members' support):", ...dissent.map((entry) => `- ${who(entry.memberId)}: ${entry.block}`), "");
  }
  if (deliberation.agreed && result.plans[0]) lines.push("## Plan", "", result.plans[0].plan, "");
  if (!deliberation.agreed) {
    if (result.tied && result.tied.length > 1) lines.push(...advisorLines(result, `The parliament split between Plans ${result.tied.join(", ")}.`, true));
    if (result.plans.length > 0) lines.push(result.plans.length >= 2 ? "## Positions" : "## The one position written");
    for (const plan of result.plans) lines.push("", `### Plan ${plan.letter} (${plan.memberId})`, "", plan.plan);
    if (result.plans.length > 0) lines.push("");
  }
  const beyond = (deliberation.turns ?? []).filter((turn) => turn.beyond);
  if (beyond.length > 0) {
    lines.push("## Beyond the request (for you to decide)", "", ...beyond.map((turn) => `- ${who(turn.memberId)}${turn.round > 0 ? `, round ${turn.round}` : ""}: ${turn.beyond}`), "");
  }
  return lines;
}

/** The voices, every approach with who proposed it, then what each member said in each round. */
function discussionLines(result: SwarmResult, deliberation: SwarmDeliberation): string[] {
  const fresh = new Set((result.members ?? []).filter((member) => member.votesOnly).map((member) => member.id));
  const voices = new Map((deliberation.voices ?? []).map((entry) => [entry.memberId, entry.letter]));
  const who = (id: string) => (voices.has(id) ? `${voices.get(id)} (${id})` : id);
  const lines = ["## Approaches", ""];
  if (voices.size > 0) lines.push(`Voices: ${[...voices].map(([id, letter]) => `${letter} ${id}${fresh.has(id) ? " (fresh reader)" : ""}`).join(", ")}.`);
  for (const entry of deliberation.approaches ?? []) {
    lines.push("", `### Approach ${entry.label}: ${entry.name} (${who(entry.memberId)}${entry.round ? `, merged in round ${entry.round}` : ""})`, "", entry.idea);
    if (entry.tradeoff) lines.push("", `Trade-off: ${entry.tradeoff}`);
  }
  const turns = deliberation.turns ?? [];
  if (turns.length > 0) {
    lines.push("", "## Discussion");
    for (const turn of turns) {
      // A run saved before deliberations discussed calls the stand `best`.
      const stand = turn.stand ?? (turn as { best?: string }).best;
      lines.push("", `### ${turn.round === 0 ? "Opening" : `Round ${turn.round}`}: ${who(turn.memberId)}`, "");
      if (!stand && !turn.why && !turn.findings && !turn.questions && !turn.replies && !turn.beyond) {
        lines.push("No readable answer (it said nothing in this step).");
        continue;
      }
      lines.push(stand ? `${turn.round === 0 ? "Picks" : "Stands on"} Approach ${stand}.${turn.merged ? ` Offered Approach ${turn.merged}, a merge.` : ""}` : "Named no approach it backs.");
      if (turn.why) lines.push(`Why: ${turn.why}`);
      for (const reply of turn.replies ?? []) lines.push(`- To ${reply.to}: ${reply.point}`);
      for (const finding of turn.findings ?? []) lines.push(`- Found: ${finding.fact}${finding.source ? ` [source: ${finding.source}]` : " [no source given]"}`);
      for (const question of turn.questions ?? []) lines.push(`- Asks: ${question}`);
    }
  }
  return lines;
}

/** The members' settings and the options their CLIs couldn't take, when there is anything to say. */
function memberLines(result: SwarmResult): string[] {
  const lines: string[] = [];
  const rows = (result.members ?? []).map(memberRow).filter((row) => row !== undefined);
  if (rows.length > 0 || (result.unsupported?.length ?? 0) > 0) {
    lines.push("## Members", "");
    if (rows.length > 0) lines.push("Members not listed propose with weight 1 and their CLI's defaults.", "", "| Member | Role | Weight | Effort | Fast mode |", "|---|---|---|---|---|", ...rows, "");
    if (result.unsupported?.length) {
      lines.push("Options not applied:", ...result.unsupported.map((entry) => `- ${entry.memberId}, ${entry.option}: ${entry.detail}`), "");
    }
  }
  return lines;
}

/** The level vote (or a deliberation's split): what each advisor asked ranked, who was not needed, and what they chose, or that the choice is the person's. */
function advisorLines(result: SwarmResult, level: string, split: boolean): string[] {
  const unsettled = split ? "The choice is yours." : "The order here is by first places, then by letter. The choice is yours.";
  if (result.advisorsSkipped) return [`${level} ${result.advisorsSkipped} The choice is yours.`, ""];
  if (!result.advisors?.length) return [`${level} No outside advisor was set, so ${split ? "the choice is yours." : "the order here is by first places, then by letter. The choice is yours."}`, ""];
  const lines = [`${level} The outside advisors were asked in turn:`];
  for (const answer of result.advisors) {
    lines.push(answer.ranking ? `- ${answer.id} ranked them ${answer.ranking.join(" > ")}${answer.reason ? `: ${answer.reason}` : "."}` : `- ${answer.id} could not answer (${answer.error ?? "no answer"}).`);
  }
  if (result.advisorsNotNeeded?.length) lines.push(`- Not needed, because the advisors before them had chosen: ${result.advisorsNotNeeded.join(", ")}.`);
  lines.push("", result.advisorOrder?.[0] ? `The advisors chose Plan ${result.advisorOrder[0]} (their order: ${result.advisorOrder.join(" > ")}).` : `The advisors did not settle it, so ${unsettled.charAt(0).toLowerCase()}${unsettled.slice(1)}`, "");
  return lines;
}

function droppedLines(result: SwarmResult): string[] {
  return result.dropped.length > 0 ? ["Dropped:", ...result.dropped.map((entry) => `- ${entry.memberId} (${entry.phase}): ${entry.error}`), ""] : [];
}

/** The vote: winner and why, the members, the score table and ballots, every plan, the debate. */
function contestLines(result: SwarmResult): string[] {
  const byLetter = new Map(result.plans.map((plan) => [plan.letter, plan]));
  const authors = new Set(result.plans.map((plan) => plan.memberId));
  const lines: string[] = [];
  if (result.winner) {
    const winner = byLetter.get(result.winner.letter);
    lines.push(`**Winner: Plan ${result.winner.letter} (${result.winner.memberId})** with ${points(result.winner.points)} points, ${result.winner.firstPlaces} first-place vote${result.winner.firstPlaces === 1 ? "" : "s"}.`, "");
    const reasons = result.ballots
      .filter((ballot) => ballot.reasons[result.winner!.letter])
      .map((ballot) => `- ${ballot.voterId}: ${ballot.reasons[result.winner!.letter]}`);
    if (reasons.length > 0) lines.push("Why the others picked it:", ...reasons, "");
    if (result.tied) lines.push(...advisorLines(result, `The members' vote ended level between Plans ${result.tied.join(", ")}.`, false));
    if (winner) lines.push("## Winning plan", "", winner.plan, "");
  } else {
    lines.push("No winner: no member returned a readable vote.", "");
  }
  lines.push(...memberLines(result));
  lines.push("## Vote", "", "| Plan | Author | Points | First places |", "|---|---|---|---|");
  for (const score of result.scores) lines.push(`| ${score.letter} | ${score.memberId} | ${points(score.points)} | ${score.firstPlaces} |`);
  const weighted = result.ballots.some((ballot) => (ballot.weight ?? 1) !== 1 || !authors.has(ballot.voterId));
  if (weighted) {
    lines.push("", "Points are scaled by each voter's weight. A fresh voter ranks every plan; its first choice is worth as much as anyone's.");
  }
  lines.push("", "Ballots (best first):");
  for (const ballot of result.ballots) {
    // In a deliberation's contest a member that wrote neither plan ranks both, but it is no fresh voter.
    const voter = result.members?.find((member) => member.id === ballot.voterId);
    const fresh = voter ? Boolean(voter.votesOnly) : !authors.has(ballot.voterId);
    const notes = [
      ...(authors.has(ballot.voterId) ? [] : [fresh ? "fresh voter" : "wrote no plan"]),
      ...((ballot.weight ?? 1) !== 1 ? [`weight ${ballot.weight}`] : []),
    ];
    lines.push(`- ${ballot.voterId}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}: ${ballot.ranking.join(" > ")}`);
  }
  if (result.dropped.length > 0) {
    lines.push("", "Dropped:", ...result.dropped.map((entry) => `- ${entry.memberId} (${entry.phase}): ${entry.error}`));
  }
  lines.push("", "## Final plans");
  for (const plan of result.plans) lines.push("", `### Plan ${plan.letter} (${plan.memberId})`, "", plan.plan);
  if (result.debate.length > 0) {
    lines.push("", "## Debate");
    for (const entry of result.debate) lines.push("", `### Round ${entry.round}: ${entry.memberId}`, "", entry.critique);
  }
  return lines;
}
