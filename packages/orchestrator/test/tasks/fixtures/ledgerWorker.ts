/**
 * A separate process that writes to a ledger, for ledgerConcurrency.test.ts. It says "ready",
 * waits for a line on stdin so every worker starts at once, does its job and prints a result.
 *
 *   ledgerWorker.ts <dataDir> <projectKey> notes <count> <name>   appends <count> notes
 *   ledgerWorker.ts <dataDir> <projectKey> move <taskId> <state>  moves a task once
 */
import { once } from "node:events";
import { LedgerRuleError, openLedger, openProject } from "../../../src/tasks/index.js";

const [dataDir, projectKey, job, first, second] = process.argv.slice(2);
if (!dataDir || !projectKey || !job || !first || !second) throw new Error("missing arguments");

const ledger = openLedger({ dataDir });
process.stdout.write("ready\n");
process.stdin.setEncoding("utf8");
await once(process.stdin, "data");

if (job === "notes") {
  const seqs: number[] = [];
  for (let index = 0; index < Number(first); index += 1) {
    const entry = await ledger.append(projectKey, {
      kind: "note",
      data: { from: second, text: `note ${index}` },
    });
    seqs.push(entry.seq);
  }
  process.stdout.write(`${JSON.stringify(seqs)}\n`);
} else if (job === "move") {
  try {
    await openProject(ledger, projectKey).moveTask(first, second as "working");
    process.stdout.write("won\n");
  } catch (error) {
    if (!(error instanceof LedgerRuleError)) throw error;
    process.stdout.write(`lost:${error.code}\n`);
  }
} else {
  throw new Error(`unknown job ${job}`);
}
