"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repositoryRoot, "src", "cli.js");
const fixture = path.join(repositoryRoot, "test", "fixtures", "typescript-order-flow");

test("CLI shadow core mode awaits the asynchronous facade and exits cleanly", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cli,
    "scan",
    fixture,
    "--no-cache",
    "--format",
    "summary",
    "--core-mode",
    "shadow",
  ], { cwd: repositoryRoot, windowsHide: true });
  assert.equal(stderr, "");
  assert.match(stdout, /typescript-order-flow/);
  assert.match(stdout, /5 files \/ 10 nodes \/ 15 edges/);
});
