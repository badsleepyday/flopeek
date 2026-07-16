"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { getOrCreateArtifact, invalidateArtifactCache, listArtifactCacheAudit } = require("../../src/artifact-cache");
const { getFlowContextCard, getFlowProjection } = require("../../src/graph-service");
const { parseFlowLensMaxStepsQuery, validateFlowLensMaxSteps } = require("../../src/flow-lens-options");
const { scanRepository } = require("../../src/scanner");

function fixture(root) {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "artifact-cache-fixture" }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "orders.ts"), "export function listOrders() { return []; }");
  fs.writeFileSync(path.join(root, "src", "unrelated.ts"), "export const unrelated = true;");
  return scanRepository(root);
}

test("derived artifacts report exact hits, bounded misses, selective invalidation, and stale non-reuse", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-artifact-cache-"));
  try {
    const graph = fixture(root);
    let computes = 0;
    const compute = () => ({ value: ++computes, graphVersion: graph.state.graphVersion });
    const first = getOrCreateArtifact(root, graph, "feature-summary", { mode: "overview" }, compute, { dependencyPaths: ["src/orders.ts"], now: "2026-07-14T01:00:00.000Z" });
    const second = getOrCreateArtifact(root, graph, "feature-summary", { mode: "overview" }, compute, { dependencyPaths: ["src/orders.ts"], now: "2026-07-14T01:01:00.000Z" });
    assert.equal(first.cache.status, "miss");
    assert.equal(second.cache.status, "hit");
    assert.equal(second.value.value, 1);
    assert.equal(computes, 1);

    const laterGraph = { ...graph, state: { ...graph.state, graphVersion: graph.state.graphVersion + 1, sourceFingerprint: "sha256:changed" } };
    const retained = invalidateArtifactCache(root, laterGraph, ["src/unrelated.ts"], { topologyChanged: false, now: "2026-07-14T01:02:00.000Z" });
    assert.equal(retained.events[0].status, "retained-unaffected");
    assert.equal(retained.events[0].reason, "changed-paths-do-not-intersect-dependencies");
    const invalidated = invalidateArtifactCache(root, laterGraph, ["src/orders.ts"], { topologyChanged: false, now: "2026-07-14T01:03:00.000Z" });
    assert.equal(invalidated.events[0].status, "invalidated");
    assert.equal(invalidated.events[0].reason, "changed-path-intersects-dependencies");

    const third = getOrCreateArtifact(root, laterGraph, "feature-summary", { mode: "overview" }, () => ({ value: ++computes, graphVersion: laterGraph.state.graphVersion }), { dependencyPaths: ["src/orders.ts"], now: "2026-07-14T01:04:00.000Z" });
    assert.equal(third.cache.status, "miss");
    assert.equal(third.cache.reason, "graph-version-changed");
    assert.equal(computes, 2);
    const audit = listArtifactCacheAudit(root, laterGraph);
    assert.equal(audit.status, "available");
    assert.equal(audit.counts.hits, 1);
    assert.equal(audit.counts.misses, 2);
    assert.equal(audit.counts.invalidated, 1);
    assert.equal(audit.counts.retainedUnaffected, 1);
    assert.equal(audit.eventCatalog.truncated, false);
    assert.equal(audit.eventCatalog.total, audit.events.length);
    assert.ok(audit.records.some((record) => record.freshnessStatus === "stale"));
    assert.ok(audit.records.some((record) => record.freshnessStatus === "current"));
    assert.equal(JSON.stringify(audit).includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid derived cache metadata is unavailable and never silently overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-artifact-cache-invalid-"));
  try {
    const graph = fixture(root);
    const registry = path.join(root, ".flowpeek", "cache", "artifacts.json");
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({ schemaVersion: "flowpeek-derived-artifact-registry/v1", projectId: graph.project.projectId, records: [{ id: "broken" }], events: [], eventsOmitted: 0 }));
    const before = fs.readFileSync(registry, "utf8");
    assert.equal(listArtifactCacheAudit(root, graph).status, "unavailable");
    const fallback = getOrCreateArtifact(root, graph, "context-packet", { task: "x" }, () => ({ ok: true }));
    assert.deepEqual(fallback.value, { ok: true });
    assert.equal(fallback.cache.status, "unavailable");
    assert.equal(fs.readFileSync(registry, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Flow Lens maxSteps validation is strict and isolates compact and expanded artifacts", () => {
  assert.equal(validateFlowLensMaxSteps(), 12);
  assert.equal(validateFlowLensMaxSteps(24), 24);
  assert.equal(parseFlowLensMaxStepsQuery(null), 12);
  assert.equal(parseFlowLensMaxStepsQuery("24"), 24);
  for (const value of [0, 25, 1.5, "12", NaN, Infinity]) assert.throws(() => validateFlowLensMaxSteps(value), /integer from 1 through 24/);
  for (const value of ["", "0", "25", "1.5", "12.0", "not-a-number"]) assert.throws(() => parseFlowLensMaxStepsQuery(value), /integer from 1 through 24/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-flow-lens-options-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "flow-lens-options-fixture" }));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "orders.routes.ts"), "import { submit } from './orders.service';\nrouter.post('/orders', () => submit());");
    fs.writeFileSync(path.join(root, "src", "orders.service.ts"), "export function submit() { return true; }");
    const graph = scanRepository(root);
    const flowId = "flow:endpoint:src/orders.routes.ts:POST:/orders";
    const compact = getFlowProjection(graph, flowId);
    const expanded = getFlowProjection(graph, flowId, "application", { maxSteps: 24 });
    const compactCard = getFlowContextCard(graph, flowId);
    const expandedCard = getFlowContextCard(graph, flowId, "json", "application", { maxSteps: 24 });
    const expandedMarkdown = getFlowContextCard(graph, flowId, "markdown", "application", { maxSteps: 24 });

    assert.equal(compact.truncation.requestedMaxSteps, 12);
    assert.equal(expanded.truncation.requestedMaxSteps, 24);
    assert.deepEqual(compactCard.card.projection.steps, compact.steps);
    assert.deepEqual(compactCard.card.projection.truncation, compact.truncation);
    assert.deepEqual(expandedCard.card.projection.steps, expanded.steps);
    assert.deepEqual(expandedCard.card.projection.truncation, expanded.truncation);
    assert.match(expandedMarkdown.markdown, /Requested maximum steps: 24/);
    assert.match(expandedMarkdown.markdown, /Displayed\/source steps:/);
    for (const maxSteps of [0, 25, 1.5, "12"]) {
      assert.throws(() => getFlowProjection(graph, flowId, "application", { maxSteps }), /integer from 1 through 24/);
      assert.throws(() => getFlowContextCard(graph, flowId, "json", "application", { maxSteps }), /integer from 1 through 24/);
    }

    const registry = JSON.parse(fs.readFileSync(path.join(root, ".flowpeek", "cache", "artifacts.json"), "utf8"));
    const projectionRecords = registry.records.filter((record) => record.type === "flow-projection");
    assert.equal(projectionRecords.length, 2);
    assert.equal(new Set(projectionRecords.map((record) => record.keyHash)).size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
