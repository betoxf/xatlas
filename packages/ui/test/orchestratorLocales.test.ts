import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_LABEL_IDS } from "@/app-shell/orchestrator/orchestratorLabels.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const src = join(import.meta.dirname, "../src");
const sources = [
  ...readdirSync(join(src, "app-shell/orchestrator")).map((file) =>
    join(src, "app-shell/orchestrator", file),
  ),
  join(src, "app-shell/taskStack/TaskGlassCard.tsx"),
];

const orchestratorKeys = (messages: Record<string, string>) =>
  Object.keys(messages)
    .filter((key) => key.startsWith("orchestrator."))
    .sort();

describe("orchestrator words", () => {
  it("are in both languages, the same keys in each", () => {
    expect(orchestratorKeys(zhCN)).toEqual(orchestratorKeys(enUS));
    for (const key of orchestratorKeys(enUS)) {
      expect(enUS[key], key).toBeTruthy();
      expect(zhCN[key], key).toBeTruthy();
    }
  });

  it("cover every id the code asks for", () => {
    const literal = sources.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/"(orchestrator\.[A-Za-z.]+)"/g)].map(
        (match) => match[1]!,
      ),
    );
    const used = new Set([...ORCHESTRATOR_LABEL_IDS, ...literal]);
    const missing = [...used].filter((id) => !(id in enUS) || !(id in zhCN));
    expect(missing).toEqual([]);
  });
});
