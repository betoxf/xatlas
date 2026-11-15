import type { SwarmResult } from "@zcode/services";

/** A message that starts a conversation from the swarm's winning plan. */
export function buildSwarmContinuePrompt(result: SwarmResult): string {
  const winner = result.winner;
  const plan = winner ? result.plans.find((candidate) => candidate.letter === winner.letter) : undefined;
  if (!winner || !plan) return result.task;
  const reasons = result.ballots
    .map((ballot) => ballot.reasons[winner.letter])
    .filter((reason): reason is string => Boolean(reason));
  return [
    result.task,
    "",
    `A swarm of ${result.plans.length} models debated plans for this and voted for this one:`,
    "",
    plan.plan.trim(),
    ...(reasons.length > 0 ? ["", "Why they picked it:", ...reasons.map((reason) => `- ${reason}`)] : []),
    "",
    "Implement this plan.",
  ].join("\n");
}
