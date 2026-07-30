"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
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

test("CLI records the strict Rust source authority for an unbounded native experimental scan", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cli,
    "scan",
    fixture,
    "--no-cache",
    "--format",
    "json",
    "--core-mode",
    "native-experimental",
  ], { cwd: repositoryRoot, windowsHide: true });
  assert.equal(stderr, "");
  const graph = JSON.parse(stdout);
  assert.equal(graph.analysis.coreRuntime.requestedMode, "native-experimental");
  assert.deepEqual(graph.analysis.coreRuntime.execution, {
    selectedImplementation: "native",
    sourceAuthority: "rust",
    parserHost: "rust-tree-sitter-source/v18",
    factEnvelopeHost: "rust-native-structural-batch/v1",
    fallback: { active: false, reason: null },
  });
});

test("CLI native authority ignores and never rewrites stale graph.json", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-cli-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(fixture, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  const metadata = path.join(root, ".flopeek");
  fs.mkdirSync(metadata, { recursive: true });
  const cachePath = path.join(metadata, "graph.json");
  const stale = Buffer.from('{"staleJavaScriptAuthority":true}\n');
  fs.writeFileSync(cachePath, stale);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cli,
    "scan",
    root,
    "--format",
    "json",
    "--core-mode",
    "native-experimental",
  ], { cwd: repositoryRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(stderr, "");
  const graph = JSON.parse(stdout);
  assert.equal(graph.analysis.cacheState.status, "native-sqlite");
  assert.deepEqual(fs.readFileSync(cachePath), stale);
  assert.equal(fs.existsSync(path.join(metadata, "native-core.sqlite3")), true);
});

test("CLI routes bounded package dogfood scans through the strict Rust authority", async () => {
  const packageFixture = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-package-cli-"));
  fs.cpSync(path.join(repositoryRoot, "test", "fixtures", "monorepo-package-selection"), packageFixture, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli,
      "scan",
      packageFixture,
      "--package",
      "apps/api",
      "--max-files",
      "20",
      "--no-cache",
      "--format",
      "json",
      "--core-mode",
      "native-experimental",
    ], { cwd: repositoryRoot, windowsHide: true });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.status, "complete");
    assert.equal(result.scanOutcome.coreRuntime.boundedNative.status, "completed");
    assert.equal(result.scanOutcome.coreRuntime.boundedNative.sourceAuthority, "rust");
    assert.equal(result.scanOutcome.discovery.verified, true);
    assert.equal(result.graph.analysis.packageSelection.packagePath, "apps/api");
    assert.equal(result.graph.analysis.cacheState.reason, "native-package-scoped-session");
    assert.equal(fs.existsSync(path.join(packageFixture, ".flopeek")), false);
  } finally {
    fs.rmSync(packageFixture, { recursive: true, force: true });
  }
});
