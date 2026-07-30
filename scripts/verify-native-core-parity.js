"use strict";

// Reusable correctness gate for a real repository.  This deliberately runs
// cache-disabled sessions so it neither changes the target's .flopeek state
// nor measures speed.  A benchmark is a separate concern: this command proves
// only that the strict Rust source/graph authority and the JavaScript oracle
// produce the same public compatibility projection for the declared roots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { createScanCoordinator } = require("../src/scan-coordinator");

const ROOT = path.resolve(__dirname, "..");

function releaseNativeOptions() {
  const binary = path.join(
    ROOT,
    "native",
    "flopeek-core",
    "target",
    "release",
    process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core",
  );
  if (!fs.existsSync(binary)) {
    throw new Error(`Native release binary is missing: ${binary}. Run cargo build --release --manifest-path native/flopeek-core/Cargo.toml first.`);
  }
  return Object.freeze({ command: binary, args: [] });
}

function parseArguments(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root") throw new Error(`Unknown argument: ${argv[index]}. Use one or more --root <repository> values.`);
    const value = argv[index + 1];
    if (!value) throw new Error("--root requires a repository path.");
    const root = path.resolve(value);
    if (!fs.statSync(root).isDirectory()) throw new Error(`--root is not a directory: ${root}`);
    roots.push(root);
    index += 1;
  }
  if (!roots.length) throw new Error("Supply one or more --root <repository> values.");
  return [...new Set(roots)];
}

async function verifyRoot(root, nativeOptions = releaseNativeOptions()) {
  const javascript = createJsCoreClient();
  const native = createNativeCoreClient({ nativeOptions, sourceAuthority: "rust" });
  try {
    assert.equal(native.backendAuthority, "rust-sqlite");
    assert.equal(native.sourceAuthority, "rust");
    assert.equal(native.parserHost, "rust-tree-sitter-source/v19");
    assert.equal(native.factEnvelopeHost, "rust-native-structural-batch/v1");
    const javascriptCoordinator = createScanCoordinator(root, { cache: false, coreClient: javascript });
    const nativeCoordinator = createScanCoordinator(root, { cache: false, coreClient: native });
    const javascriptResult = await javascriptCoordinator.refresh(null, "native-core-parity-js");
    const nativeResult = await nativeCoordinator.refresh(null, "native-core-parity-rust");
    assert.equal(javascriptResult.outcome.status, "complete", `JavaScript scan did not complete for ${root}.`);
    assert.equal(nativeResult.outcome.status, "complete", `Strict Rust scan did not complete for ${root}.`);
    const jsDigest = createCoreCompatibilityDigest(javascriptResult.graph);
    const nativeDigest = createCoreCompatibilityDigest(nativeResult.graph);
    assert.equal(nativeDigest, jsDigest, `Strict Rust graph diverged from JavaScript for ${root}.`);
    assert.deepEqual(nativeResult.graph.stats, javascriptResult.graph.stats, `Strict Rust graph statistics diverged from JavaScript for ${root}.`);
    return {
      root,
      exact: true,
      jsDigest,
      nativeDigest,
      stats: nativeResult.graph.stats,
      persistence: nativeResult.graph.analysis.graphState.persistence,
      sourceAuthority: native.sourceAuthority,
    };
  } finally {
    await native.close();
  }
}

async function main() {
  const roots = parseArguments(process.argv.slice(2));
  const nativeOptions = releaseNativeOptions();
  const cases = [];
  for (const root of roots) cases.push(await verifyRoot(root, nativeOptions));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "flopeek-native-core-parity/v1",
    mode: "cache-disabled-js-oracle-vs-strict-rust-source-graph-authority",
    nativeRuntime: "release-binary",
    writesTargetRepository: false,
    summary: { roots: cases.length, exactRoots: cases.filter((item) => item.exact).length },
    cases,
    limitation: "This is a static compatibility gate for the supplied roots. It does not measure performance, prove runtime behavior, or activate the rollout-gated default native mode.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, releaseNativeOptions, verifyRoot };
