"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { adapterContractDigest } = require("../../src/adapter-registry");
const { REQUIRED_NATIVE_ADAPTERS } = require("../../src/native-rollout-gate");
const { CORE_MODE_SCHEMA, CoreModeError, requestedCoreMode, selectCoreMode } = require("../../src/core-mode");
const { createConfiguredCoreClient, createSurfaceCoreClient, createSurfaceCoreRuntime, observeCoreRuntime } = require("../../src/core-runtime");
const { createJsCoreClient } = require("../../src/js-core-client");

function completeEvidence() {
  return {
    backendParity: {
      schemaVersion: "flopeek-native-backend-parity/v1",
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
    benchmark: { rows: Array.from({ length: 5 }, (_, index) => ({ repository: `repo-${index + 1}`, states: {
      cold: { speedupNativeVsJavaScript: 1 },
      unchanged: { speedupNativeVsJavaScript: 1 },
      oneFileChange: { speedupNativeVsJavaScript: index < 4 ? 2 : 1 },
    } })) },
    performance: {
      coreQueryP95Ms: 49,
      contextRefP95Ms: 19,
      databaseOpenDoesNotDeserializeFullGraph: true,
      memoryPeakNoWorseThanJavaScript: true,
    },
  };
}

test("core mode defaults to JavaScript and rejects ambiguous activation", () => {
  assert.equal(requestedCoreMode(undefined), "js");
  assert.throws(() => requestedCoreMode("auto"), CoreModeError);
  const selected = selectCoreMode({ mode: "js" });
  assert.equal(selected.schemaVersion, CORE_MODE_SCHEMA);
  assert.equal(selected.selectedImplementation, "javascript");
  assert.equal(selected.nativeShadow, false);
});

test("shadow mode is explicit while preserving JavaScript as the public implementation", () => {
  const selected = selectCoreMode({ mode: "shadow" });
  assert.equal(selected.requestedMode, "shadow");
  assert.equal(selected.selectedImplementation, "javascript");
  assert.equal(selected.nativeShadow, true);
  assert.equal(selected.fallback, null);
});

test("native request falls back explicitly until the gate and a trusted native core are both available", () => {
  const blocked = selectCoreMode({ mode: "native" });
  assert.equal(blocked.selectedImplementation, "javascript");
  assert.equal(blocked.fallback.reason, "native-rollout-gate-blocked");
  const eligibleButUnavailable = selectCoreMode({ mode: "native", rolloutEvidence: completeEvidence() });
  assert.equal(eligibleButUnavailable.gate.eligible, true);
  assert.equal(eligibleButUnavailable.selectedImplementation, "javascript");
  assert.equal(eligibleButUnavailable.fallback.reason, "native-public-core-unavailable");
  const eligible = selectCoreMode({ mode: "native", rolloutEvidence: completeEvidence(), nativeAvailable: true });
  assert.equal(eligible.selectedImplementation, "native");
  assert.equal(eligible.fallback.reason, "native-runtime-fallback-required");
});

test("native experimental is an explicit dogfood selection, never a rollout-approved native default", async () => {
  const nativeCore = { ...createJsCoreClient(), implementation: "native-experimental", backendAuthority: "rust-sqlite" };
  const runtime = createSurfaceCoreRuntime({ coreMode: "native-experimental", nativeCore });
  assert.equal(runtime.selection.requestedMode, "native-experimental");
  assert.equal(runtime.selection.selectedImplementation, "native");
  assert.equal(runtime.selection.experimental, true);
  assert.equal(runtime.selection.gate.eligible, false);
  assert.equal(runtime.core.implementation, "native-experimental");
  await runtime.core.close();
});

test("configured core activates shadow only through the supplied native protocol client", async () => {
  const native = {
    start: async () => {},
    request: async () => ({ nodes: [], edges: [] }),
    close: async () => {},
  };
  const shadow = createConfiguredCoreClient({ mode: "shadow", native });
  assert.equal(shadow.implementation, "shadow");
  await shadow.close();
  const fallback = createConfiguredCoreClient({ mode: "native" });
  assert.equal(fallback.implementation, "javascript");
  await fallback.close();
});

test("configured core selects an explicitly supplied native client only after the complete gate", async () => {
  const javascript = createJsCoreClient();
  const nativeCore = { ...javascript, implementation: "native-experimental" };
  const selected = createConfiguredCoreClient({
    mode: "native",
    rolloutEvidence: completeEvidence(),
    nativeCore,
  });
  assert.equal(selected.implementation, "native-experimental");
  await selected.close();
});

test("strict native activation never constructs or reads a JavaScript rollback authority", async () => {
  const nativeCore = { ...createJsCoreClient(), implementation: "native-experimental", backendAuthority: "rust-sqlite" };
  const options = {
    mode: "native",
    rolloutEvidence: completeEvidence(),
    nativeCore,
    strictNative: true,
  };
  Object.defineProperty(options, "javascript", {
    get() { throw new Error("strict native must not read JavaScript authority"); },
  });
  const selected = createConfiguredCoreClient(options);
  assert.equal(selected, nativeCore);
  assert.equal(selected.backendAuthority, "rust-sqlite");
  await selected.close();
  assert.throws(
    () => createConfiguredCoreClient({ mode: "native", strictNative: true }),
    (error) => error.code === "strict-native-unavailable",
  );
});

test("configured native core falls back to JavaScript only before native authority exists", async () => {
  const javascript = {
    ...createJsCoreClient(),
    scan: async () => ({ project: { projectId: "project:js-fallback" } }),
  };
  const nativeCore = {
    ...createJsCoreClient(),
    implementation: "native-experimental",
    scan: async () => { throw new Error("native bootstrap failed"); },
  };
  const selected = createConfiguredCoreClient({
    mode: "native",
    rolloutEvidence: completeEvidence(),
    nativeCore,
    javascript,
  });
  const graph = await selected.scan("ignored");
  assert.equal(graph.project.projectId, "project:js-fallback");
  assert.equal(selected.implementation, "javascript");
  assert.deepEqual(selected.fallback, { active: true, reason: "native-bootstrap-failed-before-authority" });
  await selected.close();
});

test("surface runtime records an actual bootstrap fallback instead of only its native preflight selection", async () => {
  const javascript = {
    ...createJsCoreClient(),
    scan: async () => ({ project: { projectId: "project:js-fallback" } }),
  };
  const nativeCore = {
    ...javascript,
    implementation: "native-experimental",
    sourceAuthority: "rust",
    scan: async () => { throw new Error("native bootstrap failed"); },
  };
  const runtime = createSurfaceCoreRuntime({
    coreMode: "native-experimental",
    nativeCore,
    javascript,
  });
  await runtime.core.scan("ignored");
  const observed = observeCoreRuntime(runtime.selection, runtime.core);
  assert.equal(observed.requestedMode, "native-experimental");
  assert.equal(observed.policySelectedImplementation, "native");
  assert.equal(observed.selectedImplementation, "javascript");
  assert.equal(observed.sourceAuthority, null);
  assert.deepEqual(observed.execution, {
    selectedImplementation: "javascript",
    sourceAuthority: null,
    parserHost: null,
    factEnvelopeHost: null,
    fallback: { active: true, reason: "native-bootstrap-failed-before-authority" },
  });
  assert.deepEqual(observed.fallback, {
    reason: "native-bootstrap-failed-before-authority",
    required: "automatic-javascript-fallback-required",
    gateReasons: runtime.selection.gate.reasons,
    active: true,
  });
  await runtime.core.close();
});

test("surface runtime exposes strict Rust source authority in its execution record", async () => {
  const nativeCore = {
    ...createJsCoreClient(),
    implementation: "native-experimental",
    sourceAuthority: "rust",
    parserHost: "rust-tree-sitter-source/v17",
    factEnvelopeHost: "rust-native-structural-batch/v1",
  };
  const runtime = createSurfaceCoreRuntime({ coreMode: "native-experimental", nativeCore });
  const observed = observeCoreRuntime(runtime.selection, runtime.core);
  assert.equal(observed.selectedImplementation, "native");
  assert.deepEqual(observed.execution, {
    selectedImplementation: "native",
    sourceAuthority: "rust",
    parserHost: "rust-tree-sitter-source/v17",
    factEnvelopeHost: "rust-native-structural-batch/v1",
    fallback: { active: false, reason: null },
  });
  await runtime.core.close();
});

test("configured native core does not create a JavaScript authority after native promotion", async () => {
  const javascript = {
    ...createJsCoreClient(),
    refresh: async () => { throw new Error("JavaScript fallback must not run after native promotion"); },
  };
  const graph = { project: { projectId: "project:native" } };
  const nativeCore = {
    ...createJsCoreClient(),
    implementation: "native-experimental",
    scan: async () => graph,
    refresh: async () => { throw new Error("native refresh failed after promotion"); },
  };
  const selected = createConfiguredCoreClient({
    mode: "native",
    rolloutEvidence: completeEvidence(),
    nativeCore,
    javascript,
  });
  assert.equal(await selected.scan("ignored"), graph);
  await assert.rejects(() => selected.refresh("ignored"), /native refresh failed after promotion/);
  assert.equal(selected.implementation, "native-experimental");
  assert.deepEqual(selected.fallback, { active: false, reason: null });
  await selected.close();
});

test("surface presentation mode cannot accidentally select a core implementation", async () => {
  const client = createSurfaceCoreClient({ mode: "overview" });
  assert.equal(client.implementation, "javascript");
  await client.close();
});
