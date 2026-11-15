import { describe, expect, it } from "vitest";
import { askOpenRouter, readOpenRouterKey } from "../src/openrouter.js";

const KEY = "sk-or-test-0000";

/** A fetch that records what it was sent and answers with `reply`. */
function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const fetchIt = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchIt, calls };
}

const answer = (content: unknown) => ({ choices: [{ message: { content } }] });

describe("askOpenRouter", () => {
  it("sends the prompt and the model, and nothing that names the app", async () => {
    const { fetchIt, calls } = fakeFetch({ body: answer(' {"ranking": ["B"]} ') });
    const reply = await askOpenRouter("Which plan?", {
      model: "google/gemini-4-argon",
      fetch: fetchIt,
      readKey: async () => KEY,
    });
    expect(reply).toBe('{"ranking": ["B"]}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(["Authorization", "Content-Type"]);
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({
      model: "google/gemini-4-argon",
      messages: [{ role: "user", content: "Which plan?" }],
    });
  });

  it("sends an effort as a reasoning level OpenRouter has", async () => {
    for (const [effort, sent] of [
      ["low", "low"],
      ["high", "high"],
      ["max", "high"],
    ] as const) {
      const { fetchIt, calls } = fakeFetch({ body: answer("ok") });
      await askOpenRouter("p", { model: "m", effort, fetch: fetchIt, readKey: async () => KEY });
      expect(calls[0]!.body["reasoning"]).toEqual({ effort: sent });
    }
  });

  it("reads an answer given in parts", async () => {
    const { fetchIt } = fakeFetch({
      body: answer([{ type: "text", text: "A " }, { text: "wins" }]),
    });
    expect(await askOpenRouter("p", { model: "m", fetch: fetchIt, readKey: async () => KEY })).toBe(
      "A wins",
    );
  });

  it("says there is no key, and asks nobody", async () => {
    const { fetchIt, calls } = fakeFetch({ body: answer("ok") });
    await expect(
      askOpenRouter("p", { model: "m", fetch: fetchIt, readKey: async () => undefined }),
    ).rejects.toThrow(/No OpenRouter key/);
    expect(calls).toHaveLength(0);
  });

  it("never repeats the key in an error", async () => {
    const echoed = fakeFetch({ status: 401, body: { error: { message: `bad key ${KEY}` } } });
    const refused = await askOpenRouter("p", {
      model: "m",
      fetch: echoed.fetchIt,
      readKey: async () => KEY,
    }).catch((error: Error) => error.message);
    expect(refused).toContain("OpenRouter answered 401 for m");
    expect(refused).not.toContain(KEY);

    const failing = (async () => {
      throw new Error(`connect failed with ${KEY}`);
    }) as unknown as typeof fetch;
    const unreachable = await askOpenRouter("p", {
      model: "m",
      fetch: failing,
      readKey: async () => KEY,
    }).catch((error: Error) => error.message);
    expect(unreachable).toContain("could not be reached");
    expect(unreachable).not.toContain(KEY);

    // The headers arrive, then reading the body fails with an error that holds the key.
    const brokenBody = (async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error(`stream reset while sending ${KEY}`);
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const cutOff = await askOpenRouter("p", {
      model: "m",
      fetch: brokenBody,
      readKey: async () => KEY,
    }).catch((error: Error) => error.message);
    expect(cutOff).toContain("OpenRouter's answer could not be read");
    expect(cutOff).not.toContain(KEY);
  });

  it("fails on an error body with a 200, and on an empty answer", async () => {
    const withError = fakeFetch({ body: { error: { message: "model overloaded" } } });
    await expect(
      askOpenRouter("p", { model: "m", fetch: withError.fetchIt, readKey: async () => KEY }),
    ).rejects.toThrow(/model overloaded/);
    const empty = fakeFetch({ body: answer("  ") });
    await expect(
      askOpenRouter("p", { model: "m", fetch: empty.fetchIt, readKey: async () => KEY }),
    ).rejects.toThrow(/gave no answer/);
  });
});

describe("readOpenRouterKey", () => {
  it("takes the key from the environment first", async () => {
    expect(await readOpenRouterKey({ OPENROUTER_API_KEY: ` ${KEY} ` })).toBe(KEY);
  });
});
