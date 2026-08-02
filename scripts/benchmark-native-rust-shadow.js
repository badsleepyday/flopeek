"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const nativeBinary = path.join(ROOT, "native", "flopeek-core", "target", "release", process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core");
const jsRunner = path.join(ROOT, "scripts", "run-native-rust-shadow.js");

function median(samples) {
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function makeCorpus(root, modules) {
  write(root, "Cargo.toml", "[package]\nname = \"native-rust-shadow-benchmark\"\nversion = \"0.1.0\"\n");
  write(root, "src/shared.rs", "pub fn validate(value: usize) -> usize { value + 1 }\n");
  write(root, "src/lib.rs", `mod shared;\n${Array.from({ length: modules }, (_, index) => `mod module_${index};`).join("\n")}\npub fn entry() -> usize { ${Array.from({ length: modules }, (_, index) => `module_${index}::run_${index}()`).join(" + ")} }\n`);
  for (let index = 0; index < modules; index += 1) {
    write(root, `src/module_${index}.rs`, `use crate::shared::validate;\npub fn run_${index}() -> usize { validate(${index}) }\n`);
  }
}

function run(command, args) {
  const started = process.hrtime.bigint();
  const output = execFileSync(command, args, { cwd: ROOT, encoding: "utf8" });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { elapsedMs, output: JSON.parse(output) };
}

function normalizeNative(payload) {
  return {
    schemaVersion: payload.schemaVersion,
    nodes: payload.nodes.map((node) => node.id).sort(),
    edges: payload.edges.map((edge) => ({ type: edge.type, source: edge.source, target: edge.target }))
      .sort((left, right) => `${left.type}\0${left.source}\0${left.target}`.localeCompare(`${right.type}\0${right.source}\0${right.target}`)),
  };
}

function parseArguments(argumentsList) {
  const index = argumentsList.indexOf("--iterations");
  const iterations = index === -1 ? 5 : Number(argumentsList[index + 1]);
  if (!Number.isInteger(iterations) || iterations < 3 || iterations > 15) throw new Error("--iterations must be an integer from 3 to 15.");
  return { iterations };
}

function main() {
  const { iterations } = parseArguments(process.argv.slice(2));
  if (!fs.existsSync(nativeBinary)) throw new Error(`Native release binary is missing: ${nativeBinary}. Run cargo build --release --manifest-path native/flopeek-core/Cargo.toml first.`);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-rust-shadow-benchmark-"));
  try {
    const seed = path.join(sandbox, "seed");
    makeCorpus(seed, 120);
    const warmJsRoot = path.join(sandbox, "warm-js");
    const warmNativeRoot = path.join(sandbox, "warm-native");
    fs.cpSync(seed, warmJsRoot, { recursive: true });
    fs.cpSync(seed, warmNativeRoot, { recursive: true });
    const warmJs = run(process.execPath, [jsRunner, warmJsRoot]);
    const warmNative = run(nativeBinary, ["--native-rust-graph", warmNativeRoot]);
    assert.deepEqual(normalizeNative(warmNative.output), warmJs.output, "Native Rust shadow projection diverged during symmetric process warm-up.");
    const jsSamples = [];
    const nativeSamples = [];
    let parity = null;
    for (let index = 0; index < iterations; index += 1) {
      const jsRoot = path.join(sandbox, `js-${index}`);
      const nativeRoot = path.join(sandbox, `native-${index}`);
      fs.cpSync(seed, jsRoot, { recursive: true });
      fs.cpSync(seed, nativeRoot, { recursive: true });
      const js = run(process.execPath, [jsRunner, jsRoot]);
      const native = run(nativeBinary, ["--native-rust-graph", nativeRoot]);
      const normalizedNative = normalizeNative(native.output);
      assert.deepEqual(normalizedNative, js.output, `Native Rust shadow projection diverged on sample ${index + 1}.`);
      parity = { nodes: js.output.nodes.length, edges: js.output.edges.length };
      jsSamples.push(Number(js.elapsedMs.toFixed(3)));
      nativeSamples.push(Number(native.elapsedMs.toFixed(3)));
    }
    const jsMedian = median(jsSamples);
    const nativeMedian = median(nativeSamples);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "flopeek-native-rust-shadow-benchmark/v1",
      mode: "cold-command-envelope-after-symmetric-warmup",
      iterations,
      corpus: { generatedRustFiles: 122, modules: 120, projection: parity },
      parity: { status: "exact", compared: ["node IDs", "contains/imports/calls edges"] },
      javascript: { samplesMs: jsSamples, medianMs: Number(jsMedian.toFixed(3)) },
      native: { samplesMs: nativeSamples, medianMs: Number(nativeMedian.toFixed(3)) },
      speedupNativeVsJavaScript: Number((jsMedian / nativeMedian).toFixed(3)),
      limitation: "Both sides receive one unmeasured process warm-up, then run as a fresh command against identical disposable source copies. This measures the declared Rust graph-shadow subset, including steady process startup but excluding one-time loader/page-cache noise; it is not a whole-product or warm-cache benchmark."
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main();
