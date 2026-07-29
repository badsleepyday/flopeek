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

test("CLI help exposes the explicit native experimental dogfood mode", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "help"], { cwd: repositoryRoot, windowsHide: true });
  assert.equal(stderr, "");
  assert.match(stdout, /--core-mode js\|shadow\|native\|native-experimental/);
});

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

test("CLI records a blocked native request instead of silently presenting it as native", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cli,
    "scan",
    fixture,
    "--no-cache",
    "--format",
    "json",
    "--core-mode",
    "native",
  ], { cwd: repositoryRoot, windowsHide: true });
  assert.equal(stderr, "");
  const graph = JSON.parse(stdout);
  assert.equal(graph.analysis.coreRuntime.requestedMode, "native");
  assert.equal(graph.analysis.coreRuntime.selectedImplementation, "javascript");
  assert.equal(graph.analysis.coreRuntime.fallback.reason, "native-rollout-gate-blocked");
});
