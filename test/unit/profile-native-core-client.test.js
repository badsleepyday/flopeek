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
});
