import { jsonObjectsIn } from "@zcode/swarm/replies";
import type { PlanStep } from "../types.js";
import { normalizeOwnedPath } from "./paths.js";

/** A division read from a model's reply, with the model's note ("" when it gave none). */
export interface DivisionReply {
  readonly steps: PlanStep[];
  readonly note: string;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(items.map(text).filter((item) => item !== ""))];
}

/** Normalised paths; any entry meaning the whole repository ("." or "*.md") makes it `[]`. */
function ownedPaths(value: unknown): string[] {
  const paths = list(value).map(normalizeOwnedPath);
  return paths.includes("") ? [] : [...new Set(paths)];
}

function readStep(value: unknown): PlanStep | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const key = text(raw.key);
  const title = text(raw.title);
  const brief = text(raw.brief);
  if (!key || !title || !brief) return undefined;
  return {
    key,
    title,
    brief,
    dependsOn: list(raw.dependsOn),
    owns: ownedPaths(raw.owns),
  };
}

/**
 * The last JSON object in the reply that has a `steps` array, cleaned: steps without a key,
 * title or brief are dropped, and `undefined` when none is left or there is no such object.
 */
export function readDivisionReply(reply: string): DivisionReply | undefined {
  // Last object first, an outer one before those inside it; the first with `steps` decides.
  const division = jsonObjectsIn(reply).find((object) => Array.isArray(object.steps));
  if (!division) return undefined;
  const { steps, note } = division as { steps: unknown[]; note?: unknown };
  const cleaned = steps.map(readStep).filter((step): step is PlanStep => step !== undefined);
  return cleaned.length > 0
    ? { steps: cleaned, note: typeof note === "string" ? note.trim() : "" }
    : undefined;
}

/** The steps from a model's division reply; see `readDivisionReply`. */
export function readDivision(reply: string): PlanStep[] | undefined {
  return readDivisionReply(reply)?.steps;
}
