#!/usr/bin/env node
// FILE: xatlas-bridge.js
// Purpose: CLI surface for foreground bridge runs, pairing reset, thread resume, and macOS service control.
// Layer: CLI binary
// Exports: none
// Depends on: ../src

const {
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  readBridgeConfig,
  resetMacOSBridgePairing,
  runMacOSBridgeService,
  startBridge,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  resetBridgePairing,
  openLastActiveThread,
  watchThreadRollout,
} = require("../src");
const { version } = require("../package.json");

const CLI_NAME = "xatlas";
const command = process.argv[2] || "up";

void main();

// ─── ENTRY POINT ─────────────────────────────────────────────

async function main() {
  if (isVersionCommand(command)) {
    console.log(version);
    return;
  }

  if (command === "up") {
    if (process.platform === "darwin") {
      const result = await startMacOSBridgeService({
        waitForPairing: true,
      });
      printMacOSBridgePairingQr({
        pairingSession: result.pairingSession,
      });
      return;
    }

    startBridge();
    return;
  }

  if (command === "run") {
    startBridge();
    return;
  }

  if (command === "run-service") {
    runMacOSBridgeService();
    return;
  }

  if (command === "start") {
    assertMacOSCommand(command);
    readBridgeConfig();
    await startMacOSBridgeService({
      waitForPairing: false,
    });
    console.log("[xatlas] macOS bridge service is running.");
    return;
  }

  if (command === "stop") {
    assertMacOSCommand(command);
    stopMacOSBridgeService();
    console.log("[xatlas] macOS bridge service stopped.");
    return;
  }

  if (command === "status") {
    assertMacOSCommand(command);
    printMacOSBridgeServiceStatus();
    return;
  }

  if (command === "reset-pairing") {
    try {
      if (process.platform === "darwin") {
        resetMacOSBridgePairing();
        console.log(`[xatlas] Stopped the macOS bridge service and cleared the saved pairing state. Run \`${CLI_NAME} up\` to pair again.`);
      } else {
        resetBridgePairing();
        console.log(`[xatlas] Cleared the saved pairing state. Run \`${CLI_NAME} up\` to pair again.`);
      }
    } catch (error) {
      console.error(`[xatlas] ${(error && error.message) || "Failed to clear the saved pairing state."}`);
      process.exit(1);
    }
    return;
  }

  if (command === "resume") {
    try {
      const state = openLastActiveThread();
      console.log(
        `[xatlas] Opened last active thread: ${state.threadId} (${state.source || "unknown"})`
      );
    } catch (error) {
      console.error(`[xatlas] ${(error && error.message) || "Failed to reopen the last thread."}`);
      process.exit(1);
    }
    return;
  }

  if (command === "watch") {
    try {
      watchThreadRollout(process.argv[3] || "");
    } catch (error) {
      console.error(`[xatlas] ${(error && error.message) || "Failed to watch the thread rollout."}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error(
    `Usage: ${CLI_NAME} up | ${CLI_NAME} run | ${CLI_NAME} start | ${CLI_NAME} stop | ${CLI_NAME} status | `
    + `${CLI_NAME} reset-pairing | ${CLI_NAME} resume | ${CLI_NAME} watch [threadId] | ${CLI_NAME} --version`
  );
  process.exit(1);
}

function assertMacOSCommand(name) {
  if (process.platform === "darwin") {
    return;
  }

  console.error(`[xatlas] \`${name}\` is only available on macOS. Use \`${CLI_NAME} up\` or \`${CLI_NAME} run\` for the foreground bridge on this OS.`);
  process.exit(1);
}

function isVersionCommand(value) {
  return value === "-v" || value === "--v" || value === "-V" || value === "--version" || value === "version";
}
