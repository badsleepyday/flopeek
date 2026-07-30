"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { adapterContractDigest } = require("../../src/adapter-registry");
const { NATIVE_BACKEND_PARITY_SCHEMA, NATIVE_ROLLOUT_GATE_SCHEMA, REQUIRED_NATIVE_ADAPTERS, evaluateNativeDefaultRollout } = require("../../src/native-rollout-gate");

function benchmarkRow(repository, { cold = 1.1, unchanged = 1.2, oneFileChange = 2.1 } = {}) {
  return { repository, states: {
    cold: { speedupNativeVsJavaScript: cold },
    unchanged: { speedupNativeVsJavaScript: unchanged },
    oneFileChange: { speedupNativeVsJavaScript: oneFileChange },
  } };
}

function evidence(overrides = {}) {
  return {
    backendParity: {
      schemaVersion: NATIVE_BACKEND_PARITY_SCHEMA,
      sourceDiscoveryAuthority: "rust",
      parserAuthority: "rust",
      resolverAuthority: "rust",
      structuralFactAuthority: "rust",
      javascriptRole: "oracle-and-rollback-only",
      fixtureCount: 1,
      exactFixtureCount: 1,
      adapterContractDigest: adapterContractDigest(),
      requiredAdapters: REQUIRED_NATIVE_ADAPTERS,
      nativeAdapters: REQUIRED_NATIVE_ADAPTERS,
      fallbackOnlyAdapters: [],
      adapterCoveragePolicy: "all-native",
    },
    structuralParity: { publicIds: true, fixtureCount: 11, exactFixtureCount: 11 },
    queryParity: { flowLens: true, impact: true, relatedTests: true, contextRef: true, changedContexts: true },
    lifecycle: { sqlitePromotion: true, recovery: true, javascriptFallback: true },
    benchmark: { rows: Array.from({ length: 5 }, (_, index) => benchmarkRow(`repo-${index + 1}`)) },
    performance: {
      coreQueryP95Ms: 49,
      contextRefP95Ms: 19,
      databaseOpenDoesNotDeserializeFullGraph: true,
      memoryPeakNoWorseThanJavaScript: true,
    },
    ...overrides,
  };
}

test("native rollout gate permits only complete parity and non-regressing benchmarks", () => {
  const result = evaluateNativeDefaultRollout(evidence());
  assert.equal(result.schemaVersion, NATIVE_ROLLOUT_GATE_SCHEMA);
  assert.equal(result.eligible, true);
  assert.equal(result.selectedImplementation, "javascript", "the gate does not silently activate native");
  assert.deepEqual(result.reasons, []);
});

test("native rollout gate keeps JavaScript authoritative when cold timing regresses", () => {
  const result = evaluateNativeDefaultRollout(evidence({ benchmark: {
    rows: Array.from({ length: 5 }, (_, index) => benchmarkRow(`repo-${index + 1}`, { cold: 0.813, unchanged: 1.37, oneFileChange: 2.2 })),
  } }));
  assert.equal(result.eligible, false);
  assert.equal(result.selectedImplementation, "javascript");
  assert.ok(result.reasons.includes("cold-benchmark-regression-exceeds-10-percent"));
  assert.equal(result.rollback, "automatic-javascript-fallback-required");
});

test("native rollout gate blocks benchmark evidence while JavaScript remains the parser host", () => {
  const result = evaluateNativeDefaultRollout(evidence({ backendParity: {
    schemaVersion: NATIVE_BACKEND_PARITY_SCHEMA,
    sourceDiscoveryAuthority: "rust",
    parserAuthority: "javascript",
    resolverAuthority: "javascript",
    structuralFactAuthority: "javascript",
    javascriptRole: "production-parser-host",
    fixtureCount: 1,
    exactFixtureCount: 1,
    adapterContractDigest: adapterContractDigest(),
    requiredAdapters: REQUIRED_NATIVE_ADAPTERS,
    nativeAdapters: REQUIRED_NATIVE_ADAPTERS,
    fallbackOnlyAdapters: [],
    adapterCoveragePolicy: "all-native",
  } }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("native-backend-parity-incomplete"));
  assert.equal(result.benchmark.status, "blocked-until-native-backend-parity");
});

test("native rollout gate is bound to exact adapter contract coverage", () => {
  const backendParity = {
    ...evidence().backendParity,
    nativeAdapters: REQUIRED_NATIVE_ADAPTERS.filter((adapter) => adapter !== "go"),
    fallbackOnlyAdapters: ["go"],
  };
  const result = evaluateNativeDefaultRollout(evidence({ backendParity }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("native-backend-parity-incomplete"));
});

test("native rollout gate rejects incomplete corpus and unproven performance evidence", () => {
  const result = evaluateNativeDefaultRollout(evidence({
    benchmark: { rows: Array.from({ length: 4 }, (_, index) => benchmarkRow(`repo-${index + 1}`, { oneFileChange: 1.2 })) },
    performance: {},
  }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("benchmark-corpus-insufficient"));
  assert.ok(result.reasons.includes("one-file-change-acceleration-insufficient"));
  assert.ok(result.reasons.includes("core-query-p95-not-proven"));
  assert.ok(result.reasons.includes("context-ref-p95-not-proven"));
  assert.ok(result.reasons.includes("database-open-behavior-not-proven"));
  assert.ok(result.reasons.includes("memory-peak-not-proven"));
});

test("native rollout gate requires five distinct benchmark repositories", () => {
  const result = evaluateNativeDefaultRollout(evidence({
    benchmark: { rows: Array.from({ length: 5 }, () => benchmarkRow("repeated-repository")) },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.benchmark.repositories, 1);
  assert.ok(result.reasons.includes("benchmark-corpus-insufficient"));
});
