/** A line that opens the ideas beyond the request: a heading of any level, or a bold line, in any case. */
const BEYOND = /^\s{0,3}(?:(#{1,6})\s+|\*\*\s*)\**\s*beyond the request\b/i;
const HEADING = /^\s{0,3}(#{1,6})\s/;

/**
 * Splits a plan into the work and the ideas beyond the request, by the plan's "Beyond the
 * request" section (`PLAN_SECTIONS` in the swarm, and the single planner's prompt). A section
 * runs to the next heading of the same or a higher level (a bold-line section to the next
 * heading); every such section goes to `beyond`. Only `work` is divided or given to an
 * executor; the person sees the whole plan on the job.
 */
export function splitBeyond(plan: string): { work: string; beyond: string } {
  const work: string[] = [];
  const beyond: string[] = [];
  let level: number | undefined;
  for (const line of plan.split(/\r?\n/)) {
    const opens = BEYOND.exec(line);
    const heading = HEADING.exec(line);
    if (opens) {
      level = opens[1]?.length ?? 7;
      beyond.push(line);
      continue;
    }
    if (level !== undefined && heading && heading[1]!.length <= level) level = undefined;
    (level === undefined ? work : beyond).push(line);
  }
  return { work: work.join("\n").trim(), beyond: beyond.join("\n").trim() };
}
