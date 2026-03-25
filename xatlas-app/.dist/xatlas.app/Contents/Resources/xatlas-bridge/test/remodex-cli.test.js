// FILE: xatlas-cli.test.js
// Purpose: Verifies the public CLI exposes a simple version command for support/debugging.
// Layer: Integration-lite test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, child_process, path, ../package.json

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const path = require("path");
const { version } = require("../package.json");

test("xatlas --version prints the package version", () => {
  const cliPath = path.join(__dirname, "..", "bin", "xatlas-bridge.js");
  const output = execFileSync(process.execPath, [cliPath, "--version"], {
    encoding: "utf8",
  }).trim();

  assert.equal(output, version);
});
