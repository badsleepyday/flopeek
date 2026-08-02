"use strict";

// Fair migration benchmark: both sides execute through ScanCoordinator against
// isolated repository copies. This includes the production persistence boundary:
// JavaScript promotes graph.json while native promotes its authoritative SQLite
// graph through one persistent JSONL process.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { createNativeIncrementalSession } = require("../src/native-incremental-coordinator");
const { createScanCoordinator } = require("../src/scan-coordinator");
const { nativePlatformTarget } = require("../src/native-platform-targets");
const { copyRepository, executionOrder, parseArguments, sourceFiles, summarize } = require("./benchmark-native-incremental");

const ROOT = path.resolve(__dirname, "..");

// A CoreClient performance gate must measure the optimized artifact intended
// for packaging. The development resolver may legitimately choose a newer
// debug binary after tests compile it, which makes results non-reproducible and
// systematically understates native performance.
function releaseNativeOptions() {
  const name = process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
  const command = path.join(ROOT, "native", "flopeek-core", "target", "release", name);
  if (!fs.existsSync(command)) {
    throw new Error(`Native release binary is missing: ${command}. Run cargo build --release --manifest-path native/flopeek-core/Cargo.toml before benchmarking.`);
  }
  return Object.freeze({ command, args: [] });
}

function nativeArtifactBinding(command) {
  const platform = nativePlatformTarget();
  if (!platform) throw new Error(`No release target is registered for ${process.platform}/${process.arch}.`);
  const source = repositoryBinding(ROOT);
  const compilerVersion = execFileSync("rustc", ["--version"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  return {
    binarySha256: createHash("sha256").update(fs.readFileSync(command)).digest("hex"),
    platformPackage: platform.packageName,
    target: platform.rustTarget,
    compilerVersion,
    repositoryRevision: source.repositoryRevision,
    sourceDigest: source.sourceDigest,
  };
}

function repositoryBinding(root) {
  const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
  }).trim();
  if (status) throw new Error(`Benchmark repository must be clean and revision-bound: ${root}.`);
  const repositoryRevision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const sourceDigest = createHash("sha256")
    .update(execFileSync("git", ["-C", root, "ls-tree", "-r", "--full-tree", "HEAD"]))
    .digest("hex");
  return { repositoryRevision, sourceDigest };
}

function elapsed(operation) {
  const started = process.hrtime.bigint();
  return Promise.resolve(operation()).then((result) => ({
    result,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
  }));
}

function assertEquivalent(js, native, state, rootLabel) {
  assert.equal(createCoreCompatibilityDigest(native), createCoreCompatibilityDigest(js), `Native CoreClient diverged from JS on ${rootLabel} during ${state}.`);
  assert.deepEqual(native.stats, js.stats, `Native CoreClient stats diverged from JS on ${rootLabel} during ${state}.`);
}

function stateRequest(state, changedPath = null) {
  if (state === "cold") return { changedPaths: null, reason: "benchmark-cold" };
  if (state === "unchanged") return { changedPaths: [], reason: "benchmark-unchanged" };
  if (state === "oneFileChange" && typeof changedPath === "string" && changedPath) {
    return { changedPaths: [changedPath], reason: "benchmark-one-file-change" };
  }
  throw new Error(`Unknown benchmark state or missing changed path: ${state}.`);
}

async function refreshCoordinator(coordinator, request, implementation, state, rootLabel) {
  const result = await coordinator.refresh(request.changedPaths, request.reason);
  assert.equal(result.outcome.status, "complete", `${implementation} coordinator failed on ${rootLabel} during ${state}: ${result.outcome.failure?.message || result.outcome.reason || "unknown failure"}`);
  return result.graph;
}

function assertAuthorityArtifacts(jsRoot, nativeRoot, ephemeral = false) {
  if (ephemeral) {
    for (const root of [jsRoot, nativeRoot]) {
      assert.equal(fs.existsSync(path.join(root, ".flopeek", "graph.json")), false, "Ephemeral authority must not create graph.json.");
      assert.equal(fs.existsSync(path.join(root, ".flopeek", "native-core.sqlite3")), false, "Ephemeral authority must not create SQLite state.");
      assert.equal(fs.existsSync(path.join(root, ".flopeek", "project.json")), false, "Ephemeral authority must not persist a project identity.");
    }
    return;
  }
  assert.equal(fs.existsSync(path.join(jsRoot, ".flopeek", "graph.json")), true, "JavaScript authority must promote graph.json through ScanCoordinator.");
  assert.equal(fs.existsSync(path.join(jsRoot, ".flopeek", "native-core.sqlite3")), false, "JavaScript authority must not create the native SQLite graph.");
  assert.equal(fs.existsSync(path.join(nativeRoot, ".flopeek", "native-core.sqlite3")), true, "Native authority must promote its SQLite graph.");
  assert.equal(fs.existsSync(path.join(nativeRoot, ".flopeek", "graph.json")), false, "Native authority must not hide a JavaScript graph.json promotion.");
}

async function benchmarkCoreRoot(source, iteration, sandbox, nativeOptions = releaseNativeOptions(), options = {}) {
  const ephemeral = options.ephemeral === true;
  const label = path.basename(source);
  const jsRoot = path.join(sandbox, `${label}-js-core-${iteration}`);
  const nativeRoot = path.join(sandbox, `${label}-native-core-${iteration}`);
  copyRepository(source, jsRoot);
  copyRepository(source, nativeRoot);
  const javascript = createJsCoreClient();
  const native = createNativeCoreClient({
    native: createNativeIncrementalSession(nativeOptions, { cwd: ROOT }),
    sourceAuthority: "rust",
  });
  assert.equal(native.backendAuthority, "rust-sqlite", "Benchmark native side must use Rust+SQLite authority.");
  assert.equal(native.sourceAuthority, "rust", "Benchmark native side must use Rust source authority.");
  assert.equal(native.parserHost, "rust-tree-sitter-source/v19", "Benchmark must not retain a JavaScript parser host.");
  assert.equal(native.factEnvelopeHost, "rust-native-structural-batch/v1", "Benchmark must use the complete StructuralFactBatch envelope constructed by Rust.");
  assert.equal(Object.hasOwn(native, "queryFallbacks"), false, "Benchmark native side must not expose a hidden JavaScript core query fallback.");
  const javascriptCoordinator = createScanCoordinator(jsRoot, { cache: !ephemeral, coreClient: javascript });
  const nativeCoordinator = createScanCoordinator(nativeRoot, { cache: !ephemeral, coreClient: native });
  const samples = {};
  try {
    for (const [stateIndex, [state, mutate]] of [
      ["cold", null],
      ["unchanged", null],
      ["oneFileChange", (root) => {
        const file = sourceFiles(root)[0];
        fs.appendFileSync(file, "\n");
        return path.relative(root, file).replaceAll("\\", "/");
      }],
    ].entries()) {
      const jsChangedPath = mutate?.(jsRoot) || null;
      const nativeChangedPath = mutate?.(nativeRoot) || null;
      assert.equal(nativeChangedPath, jsChangedPath, "Disposable benchmark copies must mutate the same relative path.");
      const request = stateRequest(state, jsChangedPath);
      const order = executionOrder(iteration, stateIndex);
      const results = {};
      for (const implementation of order) {
        results[implementation] = implementation === "js"
          ? await elapsed(() => refreshCoordinator(javascriptCoordinator, request, "JavaScript", state, label))
          : await elapsed(() => refreshCoordinator(nativeCoordinator, request, "native", state, label));
      }
      assertEquivalent(results.js.result, results.native.result, state, label);
      assertAuthorityArtifacts(jsRoot, nativeRoot, ephemeral);
      samples[state] = {
        jsMs: Number(results.js.elapsedMs.toFixed(3)),
        nativeMs: Number(results.native.elapsedMs.toFixed(3)),
        executionOrder: order,
      };
    }
    return samples;
  } finally {
    await native.close();
  }
}

async function main() {
  const argumentList = process.argv.slice(2);
  const ephemeral = argumentList.includes("--ephemeral");
  const { roots, iterations } = parseArguments(argumentList.filter((value) => value !== "--ephemeral"));
  const nativeOptions = releaseNativeOptions();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-benchmark-"));
  try {
    const rows = [];
    for (const root of roots) {
      const samples = [];
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        samples.push(await benchmarkCoreRoot(root, iteration, sandbox, nativeOptions, { ephemeral }));
      }
      rows.push({
        ...summarize(path.basename(root), samples),
        ...repositoryBinding(root),
      });
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "flopeek-native-core-client-benchmark/v2",
      mode: ephemeral ? "scan-coordinator-js-session-vs-strict-rust-session-authority" : "scan-coordinator-js-json-vs-strict-rust-sqlite-authority",
      nativeRuntime: "release-binary",
      nativeArtifact: nativeArtifactBinding(nativeOptions.command),
      iterations,
      rows,
      parity: "Every JS/native pair must complete through ScanCoordinator, have equal flopeek-core-compatibility/v1 SHA-256 digest and graph statistics, and promote only its declared persistence artifact before timing is retained.",
      isolation: ephemeral ? "Each implementation receives an independent disposable copy and must leave no Flopeek repository metadata behind." : "Each implementation receives an independent disposable copy. Target repositories are read-only; generated Flopeek metadata exists only in the disposable copies.",
      ordering: "JS/native execution order alternates by iteration and scan state. Native retains exactly one JSONL process for cold, unchanged, and one-file-change states within one benchmark copy.",
      limitation: ephemeral ? "This measures one persistent process-local session without durable cache artifacts: JavaScript in-memory scanning versus strict Rust JS/TS parsing, Rust graph assembly, session-memory lifecycle, and JSONL transport. Repositories containing an unpromoted native source adapter are rejected instead of falling back inside the benchmark." : "This measures equivalent product authority lifecycles: JavaScript parsing/graph assembly plus graph.json promotion versus promoted Rust JS/TS parsing, Rust graph assembly, SQLite promotion, and the persistent JSONL boundary. Repositories containing an unpromoted native source adapter are rejected instead of falling back inside the benchmark. This does not measure query latency, runtime behavior, or a universal speed guarantee.",
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = {
  benchmarkCoreRoot,
  nativeArtifactBinding,
  releaseNativeOptions,
  repositoryBinding,
  stateRequest,
};
