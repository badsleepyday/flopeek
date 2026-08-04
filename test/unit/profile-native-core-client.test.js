"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { latencySummary, profileQueries } = require("../../scripts/profile-native-core-client");

test("native core profiler reports percentile and JSONL transport summaries", () => {
  const summary = latencySummary([1, 2, 3, 4, 5], [
    { requestBytes: 10, responseBytes: 20, roundTripMilliseconds: 1 },
    { requestBytes: 30, responseBytes: 40, roundTripMilliseconds: 5 },
  ]);
  assert.equal(summary.samples, 5);
  assert.equal(summary.p50Ms, 3);
  assert.equal(summary.p95Ms, 5);
  assert.equal(summary.p99Ms, 5);
  assert.deepEqual(summary.rawSamplesMs, [1, 2, 3, 4, 5]);
  assert.deepEqual(summary.transport, {
    samples: 2,
    requestBytes: 40,
    responseBytes: 60,
    roundTripP50Ms: 1,
    roundTripP95Ms: 5,
  });
});

test("native core profiler samples graph and Context Ref queries without a graph fallback", async () => {
  const calls = [];
  const core = {
    findNodes: async () => calls.push("findNodes"),
    getProjectOverview: async () => calls.push("projectOverview"),
    getContextCard: async () => {
      calls.push("contextCard");
      return { card: { contextRef: "fp://local/project/node@1" } };
    },
    resolveContextRef: async () => calls.push("resolveContextRef"),
    getFlowProjection: async () => calls.push("flowProjection"),
  };
  const transport = {
    getLastResponseStats: () => ({ requestBytes: 12, responseBytes: 34, roundTripMilliseconds: 0.5 }),
  };
  const profile = await profileQueries(core, {
    nodes: [{ id: "file:src/example.ts", kind: "file", label: "Example" }],
    flows: [{ id: "flow:example" }],
  }, transport);
  assert.equal(profile.schemaVersion, "flopeek-native-query-profile/v1");
  for (const operation of Object.values(profile.operations)) {
    assert.equal(operation.samples, profile.samplesPerOperation);
    assert.equal(operation.transport.samples, profile.samplesPerOperation);
    assert.equal(operation.transport.requestBytes, 12 * profile.samplesPerOperation);
  }
  assert.equal(calls.filter((name) => name === "contextCard").length, profile.samplesPerOperation + 1);
  assert.ok(calls.includes("resolveContextRef"));
  assert.ok(calls.includes("flowProjection"));
  assert.equal(profile.operations.resolveContextRef.targetStatus, "present");
  assert.equal(profile.operations.flowProjection.targetStatus, "present");
});

test("native core profiler measures explicit absent lookups when a repository has no flow or Context Ref", async () => {
  const requested = { contextRefs: [], flowIds: [] };
  const core = {
    findNodes: async () => [],
    getProjectOverview: async () => ({}),
    getContextCard: async () => ({ card: null }),
    resolveContextRef: async (_graph, value) => requested.contextRefs.push(value),
    getFlowProjection: async (_graph, value) => {
      requested.flowIds.push(value);
      return null;
    },
  };
  const profile = await profileQueries(core, {
    nodes: [{ id: "file:src/lib.rs", kind: "file", label: "lib.rs" }],
    flows: [],
  });

  assert.deepEqual(Object.keys(profile.operations).sort(), ["contextCard", "findNodes", "flowProjection", "projectOverview", "resolveContextRef"]);
  assert.equal(profile.operations.resolveContextRef.targetStatus, "absent");
  assert.equal(profile.operations.flowProjection.targetStatus, "absent");
  assert.ok(requested.contextRefs.every((value) => value === "fp://invalid/profile"));
  assert.ok(requested.flowIds.every((value) => value === "flow:__flopeek_profile_absent__"));
});

test("native core profiler rejects a missing result for a declared present target", async () => {
  const core = {
    findNodes: async () => ({}),
    getProjectOverview: async () => ({}),
    getContextCard: async () => ({ card: { contextRef: "fp://local/project/node@1" } }),
    resolveContextRef: async () => ({}),
    getFlowProjection: async () => null,
  };
  await assert.rejects(
    profileQueries(core, {
      nodes: [{ id: "file:src/example.ts", kind: "file", label: "Example" }],
      flows: [{ id: "flow:example" }],
    }),
    /flowProjection declared a present profile target but returned null/,
  );
});
