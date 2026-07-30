"use strict";

const { adapterContractDigest, getAdapterRegistry } = require("./adapter-registry");
const NATIVE_ROLLOUT_GATE_SCHEMA = "flopeek-native-rollout-gate/v1";
const MINIMUM_BENCHMARK_REPOSITORIES = 5;
const MAXIMUM_REGRESSION_SPEEDUP = 0.9;
const REQUIRED_ONE_FILE_SPEEDUP = 2;
const REQUIRED_ONE_FILE_REPOSITORIES = 4;
const NATIVE_BACKEND_PARITY_SCHEMA = "flopeek-native-backend-parity/v1";
const NATIVE_BENCHMARK_SCHEMA = "flopeek-native-core-client-benchmark/v2";
const REQUIRED_NATIVE_ADAPTERS = Object.freeze(getAdapterRegistry().adapters
  .filter((adapter) => adapter.capabilities.structure !== "inventory-only")
  .map((adapter) => adapter.id)
  .sort());

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return left.length === leftSet.size
    && right.length === rightSet.size
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

// A native graph store is not a native backend when JavaScript still parses
// source, resolves imports, or materializes the parser-to-graph input. Keep
// this contract deliberately about authority, not an implementation detail
// such as the particular Rust parser crate. JavaScript remains allowed as the
// CI/rollback oracle, but it must not be on the native production data path.
function hasNativeBackendAuthority(value) {
  return value?.schemaVersion === NATIVE_BACKEND_PARITY_SCHEMA
    && value.sourceDiscoveryAuthority === "rust"
    && value.parserAuthority === "rust"
    && value.resolverAuthority === "rust"
    && value.structuralFactAuthority === "rust"
    && value.javascriptRole === "oracle-and-rollback-only"
    && Number.isSafeInteger(value.fixtureCount)
    && value.fixtureCount > 0
    && value.exactFixtureCount === value.fixtureCount
    && value.adapterContractDigest === adapterContractDigest()
    && sameStringSet(value.requiredAdapters, REQUIRED_NATIVE_ADAPTERS)
    && sameStringSet(value.nativeAdapters, REQUIRED_NATIVE_ADAPTERS)
    && Array.isArray(value.fallbackOnlyAdapters)
    && value.fallbackOnlyAdapters.length === 0
    && value.adapterCoveragePolicy === "all-native";
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function benchmarkRows(report) {
  return Array.isArray(report?.rows) ? report.rows : [];
}

function hasBoundBenchmarkArtifact(report) {
  const artifact = report?.nativeArtifact;
  return report?.schemaVersion === NATIVE_BENCHMARK_SCHEMA
    && artifact && typeof artifact === "object"
    && /^[a-f0-9]{64}$/u.test(artifact.binarySha256 || "")
    && /^[a-f0-9]{40,64}$/u.test(artifact.repositoryRevision || "")
    && /^[a-f0-9]{64}$/u.test(artifact.sourceDigest || "")
    && typeof artifact.platformPackage === "string" && artifact.platformPackage.length > 0
    && typeof artifact.target === "string" && artifact.target.length > 0
    && typeof artifact.compilerVersion === "string" && artifact.compilerVersion.length > 0;
}

function distinctBenchmarkRepositories(rows) {
  return new Set(rows
    .map((row) => typeof row?.repository === "string" ? row.repository.trim() : "")
    .filter(Boolean)).size;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function measuredSpeedup(sample) {
  const javascript = sample?.jsSamplesMs;
  const native = sample?.nativeSamplesMs;
  if (!Array.isArray(javascript) || javascript.length < 3
    || !Array.isArray(native) || native.length !== javascript.length
    || !javascript.every((value) => finiteNonNegative(value))
    || !native.every((value) => finiteNonNegative(value) && value > 0)) return null;
  const computed = Number((median(javascript) / median(native)).toFixed(3));
  return sample.speedupNativeVsJavaScript === computed ? computed : null;
}

function benchmarkSpeedup(rows, state) {
  if (!rows.length) return null;
  const samples = rows.map((row) => measuredSpeedup(row?.states?.[state]));
  return samples.every(finiteNonNegative) ? Math.min(...samples) : null;
}

function rowsAtOrAbove(rows, state, threshold) {
  return rows.filter((row) => {
    const speedup = measuredSpeedup(row?.states?.[state]);
    return speedup !== null && speedup >= threshold;
  }).length;
}

/// Decide whether the product may select native as its default core. This gate
/// never enables native by itself: callers must still provide an explicit
/// native implementation and retain automatic JavaScript fallback.
function evaluateNativeDefaultRollout(evidence = {}) {
  const reasons = [];
  const backend = evidence.backendParity || {};
  if (!hasNativeBackendAuthority(backend)) reasons.push("native-backend-parity-incomplete");
  const structural = evidence.structuralParity || {};
  const queries = evidence.queryParity || {};
  const lifecycle = evidence.lifecycle || {};
  if (structural.publicIds !== true) reasons.push("public-id-parity-not-proven");
  if (!Number.isSafeInteger(structural.fixtureCount) || structural.fixtureCount < 11
    || structural.exactFixtureCount !== structural.fixtureCount) reasons.push("structural-fixture-parity-incomplete");
  const requiredQueries = ["flowLens", "impact", "relatedTests", "contextRef", "changedContexts"];
  for (const query of requiredQueries) if (queries[query] !== true) reasons.push(`query-parity-missing:${query}`);
  if (lifecycle.sqlitePromotion !== true) reasons.push("sqlite-promotion-not-proven");
  if (lifecycle.recovery !== true) reasons.push("sqlite-recovery-not-proven");
  if (lifecycle.javascriptFallback !== true) reasons.push("javascript-fallback-not-proven");

  // Performance has no decision value until native owns the entire backend
  // path. Do not let an attractive wrapper measurement obscure a JavaScript
  // parser/resolver dependency.
  if (reasons.includes("native-backend-parity-incomplete")) {
    return Object.freeze({
      schemaVersion: NATIVE_ROLLOUT_GATE_SCHEMA,
      eligible: false,
      selectedImplementation: "javascript",
      rollback: "automatic-javascript-fallback-required",
      reasons: Object.freeze(reasons),
      backend: Object.freeze({ status: "incomplete", requiredSchema: NATIVE_BACKEND_PARITY_SCHEMA }),
      benchmark: Object.freeze({ status: "blocked-until-native-backend-parity" }),
      limitation: "A Rust store or graph assembler does not satisfy this gate while JavaScript remains on the parser, resolver, or structural-fact production path. Benchmark evidence is intentionally ignored until native backend authority is proven.",
    });
  }

  if (!hasBoundBenchmarkArtifact(evidence.benchmark)) reasons.push("benchmark-artifact-binding-missing");
  const rows = benchmarkRows(evidence.benchmark);
  const cold = benchmarkSpeedup(rows, "cold");
  const unchanged = benchmarkSpeedup(rows, "unchanged");
  const oneFileChange = benchmarkSpeedup(rows, "oneFileChange");
  const oneFileAcceleratedRepositories = rowsAtOrAbove(rows, "oneFileChange", REQUIRED_ONE_FILE_SPEEDUP);
  const repositories = distinctBenchmarkRepositories(rows);
  if (repositories < MINIMUM_BENCHMARK_REPOSITORIES) reasons.push("benchmark-corpus-insufficient");
  if (cold === null || cold < MAXIMUM_REGRESSION_SPEEDUP) reasons.push("cold-benchmark-regression-exceeds-10-percent");
  if (unchanged === null || unchanged < MAXIMUM_REGRESSION_SPEEDUP) reasons.push("unchanged-benchmark-regression-exceeds-10-percent");
  if (oneFileChange === null || oneFileChange < MAXIMUM_REGRESSION_SPEEDUP) reasons.push("one-file-change-benchmark-regression-exceeds-10-percent");
  if (oneFileAcceleratedRepositories < REQUIRED_ONE_FILE_REPOSITORIES) reasons.push("one-file-change-acceleration-insufficient");

  const performance = evidence.performance || {};
  if (!finiteNonNegative(performance.coreQueryP95Ms) || performance.coreQueryP95Ms >= 50) reasons.push("core-query-p95-not-proven");
  if (!finiteNonNegative(performance.contextRefP95Ms) || performance.contextRefP95Ms >= 20) reasons.push("context-ref-p95-not-proven");
  if (performance.databaseOpenDoesNotDeserializeFullGraph !== true) reasons.push("database-open-behavior-not-proven");
  if (performance.memoryPeakNoWorseThanJavaScript !== true) reasons.push("memory-peak-not-proven");

  return Object.freeze({
    schemaVersion: NATIVE_ROLLOUT_GATE_SCHEMA,
    eligible: reasons.length === 0,
    selectedImplementation: "javascript",
    rollback: "automatic-javascript-fallback-required",
    reasons: Object.freeze(reasons),
    backend: Object.freeze({ status: "complete", requiredSchema: NATIVE_BACKEND_PARITY_SCHEMA }),
    benchmark: Object.freeze({
      repositories,
      cold,
      unchanged,
      oneFileChange,
      oneFileAcceleratedRepositories,
    }),
    limitation: "This gate evaluates supplied static parity, lifecycle, and benchmark evidence. It does not prove runtime behavior or activate a native implementation.",
  });
}

module.exports = {
  MAXIMUM_REGRESSION_SPEEDUP,
  MINIMUM_BENCHMARK_REPOSITORIES,
  NATIVE_ROLLOUT_GATE_SCHEMA,
  REQUIRED_ONE_FILE_REPOSITORIES,
  REQUIRED_ONE_FILE_SPEEDUP,
  NATIVE_BACKEND_PARITY_SCHEMA,
  NATIVE_BENCHMARK_SCHEMA,
  REQUIRED_NATIVE_ADAPTERS,
  evaluateNativeDefaultRollout,
};
