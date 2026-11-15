import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { withAccountModels } from "./accounts.js";
import { runDeliberation } from "./deliberate.js";
import { runSwarm } from "./engine.js";
import { formatSwarmReport } from "./report.js";
import { readOpenRouterKey } from "./openrouter.js";
import { askMember, cliEnv, listAvailableAgents, parseAdvisor, parseMember } from "./runners.js";
import { saveRun } from "./store.js";
import type { SwarmEvent, SwarmMode, SwarmResult } from "./types.js";

const { values } = parseArgs({
  options: {
    task: { type: "string" },
    with: { type: "string" },
    cwd: { type: "string" },
    rounds: { type: "string", default: "1" },
    out: { type: "string" },
    save: { type: "string" },
    advisor: { type: "string" },
    mode: { type: "string", default: "contest" },
    list: { type: "boolean", default: false },
  },
});

if (values.list || !values.task || !values.with) {
  for (const agent of await withAccountModels(await listAvailableAgents())) {
    const models = agent.models?.length ? `  e.g. ${agent.models.slice(0, 4).map((model) => `${agent.agent}:${model}`).join(", ")}` : "";
    console.log(`${agent.ready ? "✓" : "✗"} ${agent.agent}: ${agent.detail}${models}`);
  }
  const hasKey = Boolean(await readOpenRouterKey(await cliEnv()));
  console.log(`${hasKey ? "✓" : "✗"} openrouter: ${hasKey ? "key found" : 'no key (set OPENROUTER_API_KEY or the Keychain item "openrouter-api-key")'}  advisor only, e.g. --advisor claude:opus+high,claude:claude-mythos-5-2,openrouter:google/gemini-4-argon`);
  if (!values.list) {
    console.log('\nUsage: pnpm --filter @zcode/swarm swarm --task "…" --with claude:opus,codex:gpt-6-astra[,…] [--rounds 1] [--cwd dir] [--out report.md] [--save dir] [--advisor a,b,c] [--mode contest|deliberate]');
    console.log("  Each member is agent[:model][+option…]. Options: low, medium, high, xhigh or max (effort), fast, vote (a fresh voter: only ranks the plans), w<number> (vote weight).");
    console.log("  e.g. --with claude:claude-mythos-5-2+max+w2,claude:fable+high,codex:gpt-6-astra+xhigh+fast,gemini:gemini-2.5-pro+vote");
    console.log("  --advisor names outside models asked in order, only when the vote ends level or a deliberation splits: openrouter:<model>[+effort] or claude:<model>[+effort]. The first two are asked together and the next only while they disagree. They are sent the two or more plans and the ballots (or what the members said), not the project, and have no tools.");
    console.log("  --mode deliberate: the members discuss the request by letter, agree on one plan and amend it; nobody votes, and a split goes to the advisors or to you. The default, contest, has each write a whole plan and ranks them.");
    console.log("  pnpm runs this in packages/swarm, so give --cwd, --out and --save as absolute paths.");
    process.exit(values.task || values.with ? 2 : 0);
  }
  process.exit(0);
}

if (values.mode !== "contest" && values.mode !== "deliberate") {
  console.error(`Unknown --mode "${values.mode}": use contest or deliberate.`);
  process.exit(2);
}
const mode: SwarmMode = values.mode;
const members = values.with.split(",").map((spec) => parseMember(spec.trim()));
const advisors = (values.advisor ?? "").split(",").map((spec) => spec.trim()).filter(Boolean).map(parseAdvisor);
const rounds = Number(values.rounds);
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const events: SwarmEvent[] = [];
/** Saves the run when --save was given, finished or not. */
async function save(status: "done" | "failed", result?: SwarmResult, error?: string) {
  if (!values.save) return;
  const id = `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const file = await saveRun(values.save, {
    id,
    savedAt: new Date().toISOString(),
    status,
    task: values.task!,
    members,
    rounds,
    mode,
    events,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  });
  console.log(`\nSaved run: ${file}`);
}
let result: SwarmResult;
try {
  result = await (mode === "deliberate" ? runDeliberation : runSwarm)(
    { task: values.task, cwd: values.cwd ?? process.cwd(), members, rounds, ...(advisors.length > 0 ? { advisors } : {}) },
    askMember,
    (event) => {
      events.push(event);
      if (event.type === "phase") console.log(`\n[${elapsed()}] ${event.step ?? event.phase}${event.phase === "debate" ? ` round ${event.round}` : ""}`);
      if (event.type === "message") console.log(`  ✓ ${event.step ? `${event.step}${event.letter ? ` ${event.letter}` : ""}` : event.letter ? `Plan ${event.letter}` : "Fresh vote"} (${event.memberId}): ${event.text.split("\n").find((line) => line.trim())?.slice(0, 100) ?? ""}`);
      if (event.type === "dropped") console.log(`  ✗ ${event.memberId}: ${event.error}`);
      if (event.type === "advisor") console.log(`\n[${elapsed()}] ${mode === "deliberate" ? "split" : "level vote"} between ${event.tied.join(", ")}: ${event.memberId} ${event.ranking ? `ranked them ${event.ranking.join(" > ")}` : `could not answer (${event.error ?? "no answer"})`}`);
      if (event.type === "unsupported") console.log(`  ! ${event.memberId}: ${event.option} not applied. ${event.detail}`);
    },
  );
} catch (error) {
  await save("failed", undefined, error instanceof Error ? error.message : String(error));
  throw error;
}
await save("done", result);
const report = formatSwarmReport(result);
if (values.out) {
  await writeFile(values.out, report);
  console.log(`\nReport: ${values.out}`);
}
console.log(`\n${report.split(/^## (?:Final plans|Approaches)$/m)[0]}`);
