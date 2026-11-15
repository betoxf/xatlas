/**
 * Small text helpers the oversight prompts share. Anything a model or a person wrote goes
 * between tags as data; a closing tag of any block these prompts use is escaped inside it, so
 * it can't end its own block or one around it early.
 */

const CLOSING_TAG =
  /<\/(title|brief|digest|findings|finding|plan|step|dispute|question|messages)\b/gi;

export function fence(tag: string, content: string): string {
  const escaped = content.trim().replace(CLOSING_TAG, "<\\/$1");
  return `<${tag}>\n${escaped}\n</${tag}>`;
}

/** One line: runs of whitespace become one space. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A trimmed string, or "" for anything that isn't one. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What a step may change, as a phrase. An empty list is the whole repository. */
export function ownsPhrase(owns: readonly string[]): string {
  return owns.length > 0 ? owns.join(", ") : "anything in the repository";
}
