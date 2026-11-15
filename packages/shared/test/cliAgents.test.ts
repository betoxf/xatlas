import { describe, expect, it } from "vitest";
import { cliAgentBaseModel, cliAgentModelId } from "../src/cli-agents.js";

describe("cliAgentModelId", () => {
  it("is the model's name when no option is given", () => {
    expect(cliAgentModelId("opus")).toBe("opus");
    expect(cliAgentModelId(undefined)).toBe("default");
    expect(cliAgentModelId("  ")).toBe("default");
  });

  it("carries effort and fast mode after the name", () => {
    expect(cliAgentModelId("opus", { effort: "high" })).toBe("opus+high");
    expect(cliAgentModelId("gpt-6.1-sol", { effort: "max", fast: true })).toBe(
      "gpt-6.1-sol+max+fast",
    );
    expect(cliAgentModelId(undefined, { fast: true })).toBe("default+fast");
  });

  it("gives the name back", () => {
    expect(cliAgentBaseModel("gpt-6.1-sol+max+fast")).toBe("gpt-6.1-sol");
    expect(cliAgentBaseModel("opus")).toBe("opus");
  });
});
