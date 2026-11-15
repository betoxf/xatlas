/** The most text looked at, from the end of a reply; an answer sits at the end. */
const MAX_CHARS = 200_000;
/** The most candidates parsed, so a reply made of braces can't keep the app busy. */
const MAX_OBJECTS = 64;
/** The most opening braces, from the end, that get a scan of their own. */
const MAX_STARTS = 64;

/**
 * The JSON objects in a model's reply, last one first. Models wrap their answer in prose, code
 * fences or an earlier draft, so callers take the first object here that has the shape they
 * asked for.
 *
 * The work is bounded: two passes over the text find where objects could start and end, the
 * last few opening braces get one more pass each, and only the last few candidates are parsed.
 */
export function jsonObjectsIn(
  reply: string,
  limits: { readonly maxChars?: number; readonly maxObjects?: number } = {},
): Record<string, unknown>[] {
  const text = reply.slice(-(limits.maxChars ?? MAX_CHARS));
  const maxObjects = limits.maxObjects ?? MAX_OBJECTS;
  // Braces inside JSON strings must not count, but a stray quote in the prose before the
  // answer would hide everything after it. So the text is scanned both ways. Neither way reads
  // an answer that has a brace inside a string AND follows a stray quote, so each of the last
  // opening braces is also read on its own, with no memory of the prose before it.
  const spans = new Map<string, readonly [number, number]>();
  for (const span of [...braceSpans(text, true), ...braceSpans(text, false), ...lastSpans(text)])
    spans.set(span.join(), span);
  const lastFirst = [...spans.values()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const objects: Record<string, unknown>[] = [];
  for (const [start, end] of lastFirst.slice(0, maxObjects)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        objects.push(parsed as Record<string, unknown>);
    } catch {
      // Not JSON: prose that happens to hold braces.
    }
  }
  return objects;
}

/** Every `{` paired with the `}` that closes it, in one pass. */
function braceSpans(text: string, skipStrings: boolean): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  const open: number[] = [];
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"' && skipStrings) {
      inString = true;
    } else if (char === "{") {
      open.push(index);
    } else if (char === "}") {
      const start = open.pop();
      if (start !== undefined) spans.push([start, index]);
    }
  }
  return spans;
}

/** The object each of the last opening braces starts, reading strings from that brace on. */
function lastSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let starts = 0;
  for (let start = text.lastIndexOf("{"); start >= 0 && starts < MAX_STARTS; starts += 1) {
    const end = closingBrace(text, start);
    if (end >= 0) spans.push([start, end]);
    start = start > 0 ? text.lastIndexOf("{", start - 1) : -1;
  }
  return spans;
}

/** Where the object that opens at `start` closes, or -1. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
