import { jsonObjectsIn } from "./replies.js";
import type { SwarmBallot, SwarmScore } from "./types.js";

/**
 * Reads a ballot from a member's reply: the last JSON object with a `ranking`. Unknown
 * letters, duplicates and the voter's own plan are dropped. `undefined` when there's none.
 * A fresh voter has no plan of its own, so it passes no `ownLetter`.
 */
export function parseBallot(
  reply: string,
  input: { voterId: string; ownLetter?: string; letters: readonly string[] },
): SwarmBallot | undefined {
  for (const parsed of jsonObjectsIn(reply)) {
      if (!Array.isArray(parsed.ranking)) continue;
      const { ranking, reasons } = parsed as { ranking: unknown[]; reasons?: unknown };
      const valid = new Set(input.letters.filter((letter) => letter !== input.ownLetter));
      const seen = new Set<string>();
      const cleaned = ranking
        .map((letter) => String(letter).trim().toUpperCase().replace(/^PLAN\s+/, ""))
        .filter((letter) => valid.has(letter) && !seen.has(letter) && seen.add(letter));
      if (cleaned.length === 0) return undefined;
      const reasonMap: Record<string, string> = {};
      if (typeof reasons === "object" && reasons !== null) {
        for (const [letter, reason] of Object.entries(reasons)) {
          const key = letter.trim().toUpperCase().replace(/^PLAN\s+/, "");
          if (valid.has(key) && typeof reason === "string") reasonMap[key] = reason.trim();
        }
      }
      return { voterId: input.voterId, ranking: cleaned, reasons: reasonMap };
  }
  return undefined;
}

/**
 * Reads the outside advisor's answer after a level vote: the last JSON object whose `ranking`
 * names at least one of the level plans. Other letters and repeats are dropped.
 */
export function parseAdvice(reply: string, tied: readonly string[]): { ranking: string[]; reason?: string } | undefined {
  const valid = new Set(tied);
  for (const parsed of jsonObjectsIn(reply)) {
    if (!Array.isArray(parsed.ranking)) continue;
    const seen = new Set<string>();
    const ranking = (parsed.ranking as unknown[])
      .map((letter) => String(letter).trim().toUpperCase().replace(/^PLAN\s+/, ""))
      .filter((letter) => valid.has(letter) && !seen.has(letter) && seen.add(letter));
    if (ranking.length === 0) continue;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    return { ranking, ...(reason ? { reason } : {}) };
  }
  return undefined;
}

/**
 * The most a vote can weigh. A weight says how much more one seat counts than another, not a
 * score, and a ceiling keeps every total far from overflowing.
 */
export const MAX_VOTE_WEIGHT = 1000;

/** Throws unless `weight` is a number above 0 and at most `MAX_VOTE_WEIGHT`. */
export function checkWeight(weight: number, who: string): void {
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > MAX_VOTE_WEIGHT) {
    throw new Error(`The vote weight of ${who} must be a number above 0 and at most ${MAX_VOTE_WEIGHT} (got ${String(weight)}).`);
  }
}

/** Whether two sums of fractions are equal but for rounding. */
function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Whether `part` is more than half of `whole`. Exactly half, but for rounding, is not. */
export function isMajority(part: number, whole: number): boolean {
  return part > whole / 2 && !same(part, whole / 2);
}

/**
 * Whether the advisors asked so far have settled a level vote: among the answers that could be
 * read (`rankings`), one level plan is the first choice of more than half, and at least two
 * answers were read, or one when no more than one advisor could answer (one was given, or the
 * rest failed). `remaining` is how many advisors have not been asked yet.
 */
export function advisorsSettled(rankings: ReadonlyArray<readonly string[]>, remaining: number): boolean {
  const read = rankings.length;
  if (read === 0 || read < Math.min(2, read + remaining)) return false;
  const firsts = new Map<string, number>();
  for (const ranking of rankings) if (ranking[0]) firsts.set(ranking[0], (firsts.get(ranking[0]) ?? 0) + 1);
  return [...firsts.values()].some((count) => isMajority(count, read));
}

/**
 * The level plans in the advisors' combined order: by how many advisors put each first, then by
 * a Borda count of their rankings. Of k level plans, the one at place i gets k − i points, and
 * each plan an advisor left out gets the average of the places it didn't fill, so a short
 * ranking counts the same as the full one with the rest level: ["A"] and ["A", "B"] score
 * alike. Plans still level below the top keep their order in `tied`, the members' tally.
 * `undefined` when the top is still level, or nothing was read: no letter and no advisor's
 * place in the list breaks it, so the choice stays with the person.
 */
export function combineAdvice(rankings: ReadonlyArray<readonly string[]>, tied: readonly string[]): string[] | undefined {
  if (rankings.length === 0) return undefined;
  const stats = new Map(tied.map((letter) => [letter, { letter, firsts: 0, points: 0 }]));
  for (const ranking of rankings) {
    const listed = ranking.filter((letter) => stats.has(letter));
    const leftOut = (tied.length - listed.length + 1) / 2;
    for (const stat of stats.values()) {
      const index = listed.indexOf(stat.letter);
      stat.points += index === -1 ? leftOut : tied.length - index;
      if (index === 0) stat.firsts += 1;
    }
  }
  // Array.prototype.sort is stable, so equal plans keep the members' order.
  const order = [...stats.values()].sort((a, b) => b.firsts - a.firsts || b.points - a.points);
  const [first, second] = order;
  if (!first || (second && second.firsts === first.firsts && second.points === first.points)) return undefined;
  return order.map(({ letter }) => letter);
}

/**
 * The letters of the plans level on points at the top of a tally. One letter means the vote
 * decided. More than one means it didn't: `tallyBallots` still puts one first, by first
 * places and then by letter, but that order is no judgement of the plans. With three members
 * that each rank the other two, this is the cycle (A over B, B over C, C over A).
 */
export function tiedAtTop(scores: readonly SwarmScore[]): string[] {
  const top = scores[0];
  if (!top) return [];
  return scores.filter((score) => same(score.points, top.points)).map((score) => score.letter);
}

/**
 * Weighted Borda count. A ballot gives the plan at `index` (0 is best)
 * `weight × (plans − 1) × (k − index) / k` points, where `k` is how many plans the voter may
 * rank: plans − 1 for a voter that wrote one of them, all of them for a fresh voter (one
 * whose id is no plan's author). Weight is 1 unless the ballot says otherwise. With every
 * weight 1 and no fresh voter this is the plain Borda count: first choice plans − 1 points,
 * last 1. Ties go to more first places counted with weight, then to the earlier letter.
 */
export function tallyBallots(
  plans: ReadonlyArray<{ letter: string; memberId: string }>,
  ballots: readonly SwarmBallot[],
): SwarmScore[] {
  const authors = new Set(plans.map(({ memberId }) => memberId));
  const scores = new Map(
    plans.map(({ letter, memberId }) => [letter, { letter, memberId, points: 0, firstPlaces: 0, weightedFirstPlaces: 0 }]),
  );
  for (const ballot of ballots) {
    const weight = ballot.weight ?? 1;
    checkWeight(weight, ballot.voterId);
    const slots = authors.has(ballot.voterId) ? plans.length - 1 : plans.length;
    ballot.ranking.forEach((letter, index) => {
      const score = scores.get(letter);
      if (!score) return;
      // Multiply before dividing, so weight 1 from an author stays a whole number.
      score.points += (weight * (plans.length - 1) * (slots - index)) / slots;
      if (index === 0) {
        score.firstPlaces += 1;
        score.weightedFirstPlaces += weight;
      }
    });
  }
  // Fresh voters give fractions; six decimals keep 2.9999999996 from showing up as such.
  // toFixed rounds without scaling the number up, so it can't overflow.
  for (const score of scores.values()) {
    if (!Number.isFinite(score.points)) throw new Error(`Plan ${score.letter}'s points don't add up to a finite number.`);
    score.points = Number(score.points.toFixed(6));
  }
  return [...scores.values()].sort(
    (a, b) =>
      (same(a.points, b.points) ? 0 : b.points - a.points) ||
      (same(a.weightedFirstPlaces, b.weightedFirstPlaces) ? 0 : b.weightedFirstPlaces - a.weightedFirstPlaces) ||
      a.letter.localeCompare(b.letter),
  );
}
