import type { PlanStep } from "../types.js";
import { ownershipClashes } from "./paths.js";

/**
 * The steps grouped by when they can start: wave 1 waits on nothing, wave 2 only on wave 1,
 * and so on, in the plan's order inside each wave. Throws when a key is repeated or a step can
 * never start (it waits on a key that isn't a step, on itself, or on a circle of steps), so a
 * division that can't finish is never shown as fine; `checkDivision` says why.
 */
export function waves(steps: readonly PlanStep[]): PlanStep[][] {
  const keys = new Set<string>();
  for (const step of steps) {
    if (keys.has(step.key)) throw new Error(`Division has the key "${step.key}" more than once.`);
    keys.add(step.key);
  }
  const result: PlanStep[][] = [];
  const placed = new Set<string>();
  let remaining = [...steps];
  while (remaining.length > 0) {
    const wave = remaining.filter((step) => step.dependsOn.every((dep) => placed.has(dep)));
    if (wave.length === 0) {
      throw new Error(
        `These steps can never start: ${remaining.map((step) => `"${step.key}"`).join(", ")}. They wait on a missing step or on each other.`,
      );
    }
    for (const step of wave) placed.add(step.key);
    remaining = remaining.filter((step) => !placed.has(step.key));
    result.push(wave);
  }
  return result;
}

/**
 * The steps to start now, in plan order: not done, not running, every step they wait on done,
 * at most `limit` minus the number running, and none that owns a path a running step (or one
 * picked in this call) also owns. A running key that isn't a step of this plan takes a slot
 * but blocks no paths.
 */
export function nextSteps(
  steps: readonly PlanStep[],
  state: { done: ReadonlySet<string>; running: ReadonlySet<string> },
  limit: number,
): PlanStep[] {
  let room = Math.floor(limit) - state.running.size;
  if (!(room > 0)) return [];
  const busy = steps.filter((step) => state.running.has(step.key)).map((step) => step.owns);
  const picked: PlanStep[] = [];
  for (const step of steps) {
    if (room <= 0) break;
    if (state.done.has(step.key) || state.running.has(step.key)) continue;
    if (!step.dependsOn.every((dep) => state.done.has(dep))) continue;
    if (busy.some((owns) => ownershipClashes(owns, step.owns).length > 0)) continue;
    picked.push(step);
    busy.push(step.owns);
    room -= 1;
  }
  return picked;
}
