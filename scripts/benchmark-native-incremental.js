"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const JS_RUNNER = path.join(ROOT, "scripts", "run-js-core-scan.js");
const NATIVE_RUNNER = path.join(ROOT, "scripts", "run-native-incremental-scan.js");
const IGNORED_DIRECTORIES = new Set([".flowpeek", ".git", ".next", ".nuxt", ".project-flow", ".turbo", "build", "coverage", "dist", "node_modules", "out", "target", "vendor"]);
const SOURCE_EXTENSIONS = new Set([".asm", ".astro", ".bash", ".c", ".cc", ".cjs", ".cpp", ".cs", ".cxx", ".go", ".h", ".java", ".js", ".jsx", ".kt", ".kts", ".mjs", ".php", ".py", ".rb", ".rs", ".scala", ".sh", ".svelte", ".swift", ".ts", ".tsx", ".vue", ".zsh"]);

function parseArguments(argumentsList) {
  const result = { roots: [], iterations: 3 };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "--root") result.roots.push(path.resolve(argumentsList[++index] || ""));
    else if (value === "--iterations") result.iterations = Number(argumentsList[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!result.roots.length || result.roots.some((root) => !fs.statSync(root).isDirectory())) throw new Error("Supply one or more existing --root repository paths.");
  if (!Number.isInteger(result.iterations) || result.iterations < 1 || result.iterations > 7) throw new Error("--iterations must be an integer from 1 to 7.");
  return result;
}

function median(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function copyable(source) {
  const relative = path.relative(copyable.root, source).replaceAll("\\", "/");
  if (!relative) return true;
  const name = path.basename(source);
  const parentNames = relative.split("/").slice(0, -1);
  if (name.startsWith(".") && relative !== ".flopeek" && relative !== ".flopeek/config.json") return false;
  if (parentNames.some((part) => IGNORED_DIRECTORIES.has(part))) return false;
  if (parentNames.some((part) => part.startsWith("."))) return relative === ".flopeek/config.json";
  if (name === ".flopeek") return true;
  try {
    const stat = fs.statSync(source);
    return stat.isDirectory() || stat.size <= 1_000_000;
  } catch {
    return false;
  }
}

function copyRepository(source, target) {
  copyable.root = source;
  fs.cpSync(source, target, { recursive: true, filter: copyable });
}

function sourceFiles(root, output = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) sourceFiles(path.join(root, entry.name), output);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (SOURCE_EXTENSIONS.has(extension) || entry.name.toLowerCase() === "makefile") output.push(path.join(root, entry.name));
  }
  return output.sort();
}

function run(runner, root) {
  const started = process.hrtime.bigint();
  const output = execFileSync(process.execPath, [runner, root], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 128 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { elapsedMs, output: JSON.parse(output) };
}

function assertEquivalent(js, native, state, rootLabel) {
  assert.equal(native.compatibilityDigest, js.compatibilityDigest, `Native incremental scan diverged from JS on ${rootLabel} during ${state}.`);
  assert.deepEqual(native.stats, js.stats, `Native incremental scan stats diverged from JS on ${rootLabel} during ${state}.`);
}

function executionOrder(iteration, stateIndex) {
  return (iteration + stateIndex) % 2 === 0 ? ["js", "native"] : ["native", "js"];
}

function benchmarkRoot(source, iteration, sandbox) {
  const label = path.basename(source);
  const jsRoot = path.join(sandbox, `${label}-js-${iteration}`);
  const nativeRoot = path.join(sandbox, `${label}-native-${iteration}`);
  copyRepository(source, jsRoot);
  copyRepository(source, nativeRoot);
  const samples = {};
  for (const [stateIndex, [state, mutate]] of [
    ["cold", null],
    ["unchanged", null],
    ["oneFileChange", (root) => fs.appendFileSync(sourceFiles(root)[0], "\n")],
  ].entries()) {
    if (mutate) {
      mutate(jsRoot);
      mutate(nativeRoot);
    }
    const order = executionOrder(iteration, stateIndex);
    const results = {};
    for (const implementation of order) {
      results[implementation] = implementation === "js"
        ? run(JS_RUNNER, jsRoot)
        : run(NATIVE_RUNNER, nativeRoot);
    }
    const { js, native } = results;
    assertEquivalent(js.output, native.output, state, label);
    samples[state] = {
      jsMs: Number(js.elapsedMs.toFixed(3)),
      nativeMs: Number(native.elapsedMs.toFixed(3)),
      executionOrder: order,
    };
  }
  return samples;
}

function summarize(label, samples) {
  const states = {};
  for (const state of ["cold", "unchanged", "oneFileChange"]) {
    const jsSamples = samples.map((sample) => sample[state].jsMs);
    const nativeSamples = samples.map((sample) => sample[state].nativeMs);
    const jsMedianMs = median(jsSamples);
    const nativeMedianMs = median(nativeSamples);
    states[state] = {
      jsSamplesMs: jsSamples,
      nativeSamplesMs: nativeSamples,
      jsMedianMs: Number(jsMedianMs.toFixed(3)),
      nativeMedianMs: Number(nativeMedianMs.toFixed(3)),
      speedupNativeVsJavaScript: Number((jsMedianMs / nativeMedianMs).toFixed(3)),
      executionOrders: samples.map((sample) => sample[state].executionOrder),
    };
  }
  return { repository: label, states };
}

function main() {
  const { roots, iterations } = parseArguments(process.argv.slice(2));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-incremental-benchmark-"));
  try {
    const rows = roots.map((root) => {
      const samples = Array.from({ length: iterations }, (_, index) => benchmarkRoot(root, index + 1, sandbox));
      return summarize(path.basename(root), samples);
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "flopeek-native-incremental-benchmark/v1",
      mode: "cold-command-envelope-with-persistent-native-session-and-cross-process-cache",
      iterations,
      rows,
      parity: "Every JS/native pair must have equal flopeek-core-compatibility/v1 SHA-256 digest and equal graph statistics before its timing is retained.",
      isolation: "Each implementation receives an independent disposable copy. Target repositories are read-only; generated Flopeek metadata exists only in the disposable copies.",
      ordering: "JS/native execution order alternates by iteration and scan state. The per-sample order is retained with each state so filesystem-cache order cannot be hidden by a single aggregate.",
      limitation: "The native side keeps one JSONL process for its manifest/load/store requests within each scan command, then closes it. This measures the current Rust inventory plus SQLite-backed JavaScript parser-record reuse; it is not a whole-product native-parser benchmark, a cross-command daemon benchmark, a universal speed guarantee, or runtime-behavior evidence.",
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { benchmarkRoot, copyRepository, executionOrder, parseArguments, sourceFiles, summarize };
