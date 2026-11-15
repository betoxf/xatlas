import type { PlanStep } from "../types.js";
import { ownershipClashes } from "./paths.js";

export type DivisionProblem = {
  kind: "duplicate-key" | "unknown-dependency" | "cycle" | "shared-ownership";
  steps: readonly string[];
  detail: string;
};

function quoted(keys: readonly string[]): string {
  const names = keys.map((key) => `"${key}"`);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * For every key, all the keys it waits on, directly or through other steps. Keys that aren't
 * steps are left out; a key in a cycle waits on itself.
 */
function waitsOn(steps: readonly PlanStep[]): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const step of steps) {
    const deps = direct.get(step.key) ?? new Set<string>();
    for (const dep of step.dependsOn) deps.add(dep);
    direct.set(step.key, deps);
  }
  const closure = new Map<string, Set<string>>();
  for (const key of direct.keys()) {
    const reached = new Set<string>();
    const queue = [...(direct.get(key) ?? [])];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (reached.has(next) || !direct.has(next)) continue;
      reached.add(next);
      queue.push(...(direct.get(next) ?? []));
    }
    closure.set(key, reached);
  }
  return closure;
}

/** Whether two steps could run at the same time: neither waits on the other in any way. */
function sideBySide(closure: Map<string, Set<string>>, a: PlanStep, b: PlanStep): boolean {
  return !closure.get(a.key)?.has(b.key) && !closure.get(b.key)?.has(a.key);
}

/**
 * What is wrong with a division, in this order: repeated keys, waits on keys that aren't
 * steps, circles of waiting, and steps that could run together but own the same file or
 * folder. A step with an empty `owns` may change anything, so it clashes with every step
 * beside it. Empty when the division is fine; never throws.
 */
export function checkDivision(steps: readonly PlanStep[]): DivisionProblem[] {
  const problems: DivisionProblem[] = [];
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.key, (counts.get(step.key) ?? 0) + 1);

  for (const [key, count] of counts) {
    if (count > 1)
      problems.push({
        kind: "duplicate-key",
        steps: [key],
        detail: `${count} steps use the key "${key}".`,
      });
  }

  for (const step of steps) {
    const missing = step.dependsOn.filter((dep) => !counts.has(dep));
    if (missing.length === 0) continue;
    problems.push({
      kind: "unknown-dependency",
      steps: [step.key],
      detail: `"${step.key}" waits on ${quoted(missing)}, which ${missing.length === 1 ? "is not a step" : "are not steps"} of this division.`,
    });
  }

  const closure = waitsOn(steps);
  const inCycle = new Set<string>();
  for (const key of counts.keys()) {
    if (inCycle.has(key) || !closure.get(key)?.has(key)) continue;
    const members = [...counts.keys()].filter(
      (other) => other === key || (closure.get(key)?.has(other) && closure.get(other)?.has(key)),
    );
    for (const member of members) inCycle.add(member);
    problems.push({
      kind: "cycle",
      steps: members,
      detail:
        members.length === 1
          ? `"${key}" waits on itself, so it can never start.`
          : `${quoted(members)} wait on each other, so none of them can start.`,
    });
  }

  steps.forEach((step, index) => {
    if (step.owns.length === 0) {
      const beside = steps.filter(
        (other, otherIndex) => otherIndex !== index && sideBySide(closure, step, other),
      );
      if (beside.length === 0) return;
      problems.push({
        kind: "shared-ownership",
        steps: [step.key, ...beside.map((other) => other.key)],
        detail: `"${step.key}" names no files or folders, so it may change anything, and it can run at the same time as ${quoted(beside.map((other) => other.key))}.`,
      });
      return;
    }
    for (const other of steps.slice(index + 1)) {
      if (other.owns.length === 0 || !sideBySide(closure, step, other)) continue;
      const clashes = ownershipClashes(step.owns, other.owns);
      if (clashes.length === 0) continue;
      problems.push({
        kind: "shared-ownership",
        steps: [step.key, other.key],
        detail: `"${step.key}" and "${other.key}" can run at the same time but both may change ${clashes
          .map(([mine, theirs]) => (mine === theirs ? `"${mine}"` : `"${mine}" / "${theirs}"`))
          .join(", ")}.`,
      });
    }
  });

  return problems;
}
