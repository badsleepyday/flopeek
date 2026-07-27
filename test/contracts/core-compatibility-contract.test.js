"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  CORE_COMPATIBILITY_SCHEMA,
  createCoreCompatibilityDigest,
  createCoreCompatibilityProjection,
} = require("../../src/core-compatibility");
const { scanRepository } = require("../../src/scanner");
const { verifyJsCoreBaseline } = require("../../scripts/verify-core-baseline");

const ROOT = path.resolve(__dirname, "..", "..");

test("core compatibility projection excludes session state while preserving deterministic facts", () => {
  const fixture = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
  const graph = scanRepository(fixture, { persistIdentity: false });
  const changedSession = structuredClone(graph);
  changedSession.generatedAt = "2099-01-01T00:00:00.000Z";
  changedSession.project.projectId = "project:different-session";
  changedSession.project.root = "X:/different/root";
  changedSession.state.graphVersion += 99;
  changedSession.analysis.cacheState = { status: "different" };
  changedSession.nodes[0].manualDescription = "Local human metadata is outside parser parity.";
  const changedFact = structuredClone(graph);
  changedFact.nodes[0].label = `${changedFact.nodes[0].label} changed`;

  const projection = createCoreCompatibilityProjection(graph);
  assert.equal(projection.schemaVersion, CORE_COMPATIBILITY_SCHEMA);
  assert.equal(createCoreCompatibilityDigest(changedSession), createCoreCompatibilityDigest(graph));
  assert.notEqual(createCoreCompatibilityDigest(changedFact), createCoreCompatibilityDigest(graph));
  assert.equal(projection.nodes.length, graph.nodes.length);
  assert.equal(projection.edges.length, graph.edges.length);
  assert.equal(projection.flows.length, graph.flows.length);
});

test("committed JavaScript core baseline matches every audited fixture", () => {
  const baseline = verifyJsCoreBaseline();
  assert.ok(baseline.cases.length >= 10);
  assert.ok(baseline.cases.every((item) => item.sourceDigest.startsWith("sha256:")));
  assert.ok(baseline.cases.every((item) => item.compatibilityDigest.startsWith("sha256:")));
});
