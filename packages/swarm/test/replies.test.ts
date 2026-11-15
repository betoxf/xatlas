import { describe, expect, it } from "vitest";
import { jsonObjectsIn } from "../src/replies.js";

describe("jsonObjectsIn", () => {
  it("finds the object in prose and in a code fence", () => {
    expect(
      jsonObjectsIn('Here you go:\n```json\n{"route": "chat"}\n```\nHope that helps.'),
    ).toEqual([{ route: "chat" }]);
  });

  it("gives the last object first, and an outer object before the ones inside it", () => {
    const reply = 'Draft: {"n": 1}\nFinal: {"steps": [{"key": "a"}, {"key": "b"}], "note": "x"}';
    expect(jsonObjectsIn(reply)).toEqual([
      { steps: [{ key: "a" }, { key: "b" }], note: "x" },
      { key: "b" },
      { key: "a" },
      { n: 1 },
    ]);
  });

  it("is not thrown off by braces inside a string", () => {
    expect(jsonObjectsIn('{"brief": "use {curly} braces }{ here"}')).toEqual([
      { brief: "use {curly} braces }{ here" },
    ]);
  });

  it("still finds the answer after a stray quote in the prose", () => {
    expect(jsonObjectsIn('The 6" screen case:\n{"route": "direct"}')).toEqual([
      { route: "direct" },
    ]);
  });

  it("reads an answer with a brace in a string after a stray quote in the prose", () => {
    const answer = { route: "chat", reason: "use } here", confident: true };
    expect(jsonObjectsIn(`The 6" screen case:\n${JSON.stringify(answer)}`)).toEqual([answer]);
    // The final answer still comes before an earlier draft.
    const draft = { ranking: ["B", "A"] };
    const final = { ranking: ["A", "B"], reasons: { A: "handles } and {" } };
    expect(
      jsonObjectsIn(`Draft: ${JSON.stringify(draft)}\nAt 6" wide:\n${JSON.stringify(final)}`)[0],
    ).toEqual(final);
  });

  it("skips arrays, broken objects and prose with braces", () => {
    expect(jsonObjectsIn('[1, 2] {not json} {"ok": true} }{')).toEqual([{ ok: true }]);
    expect(jsonObjectsIn("no json here")).toEqual([]);
    expect(jsonObjectsIn("")).toEqual([]);
  });

  it("ends quickly on replies made of braces", () => {
    const started = Date.now();
    expect(jsonObjectsIn("{".repeat(200_000))).toEqual([]);
    expect(jsonObjectsIn("{".repeat(100_000) + "}".repeat(100_000))).toEqual([]);
    expect(jsonObjectsIn('{ not json } {"ranking": ["A"]'.repeat(5_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("looks only at the end of a very long reply, and parses only the last few candidates", () => {
    const reply = `{"early": true}${" ".repeat(50)}{"late": true}`;
    expect(jsonObjectsIn(reply, { maxChars: 20 })).toEqual([{ late: true }]);
    expect(jsonObjectsIn('{"a":1} {"b":2} {"c":3}', { maxObjects: 2 })).toEqual([
      { c: 3 },
      { b: 2 },
    ]);
  });
});
