/**
 * The board: what each step's executor is told about the rest of its job, and which steps can
 * start and from which commits. Pure; every function takes the whole ledger (from seq 1),
 * because tasks and runs are what replaying it gives. Spec: docs/xatlas/orchestrator-wiring.md,
 * "The board" and "Steps and what they wait for".
 */
export { boardDigest } from "./digest.js";
export { jobSteps, stepTaskId, stepsToStart, type JobStep, type StepStart } from "./steps.js";
