"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { createDurableBrief } = require("../../src/durable-brief");
const { createHandoffContext } = require("../../src/handoff-context");
const { listRuntimeEvidence, runtimeEvidenceSummary, saveRuntimeEvidence } = require("../../src/runtime-evidence");
const { scanRepository } = require("../../src/scanner");

function fixture(root) {
  fs.mkdirSync(path.join(root, "src", "app", "api", "health"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "runtime-evidence-fixture" }));
  fs.writeFileSync(path.join(root, "src", "app", "api", "health", "route.ts"), "export async function GET() { return Response.json({ ok: true }); }");
  return scanRepository(root);
}

function input(graph, operationId, index = 0) {
  const endpoint = graph.nodes.find((node) => node.kind === "endpoint");
  return {
    operationId,
    subjectRef: createContextRef(graph.project.projectId, "node", endpoint.id, graph.state.graphVersion),
    kind: "request-observation",
    outcome: "succeeded",
    observedAt: `2026-07-15T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    summary: `Observed health request ${index} returned an expected status category.`,
    source: "local integration probe",
    statusCode: 200,
    durationMs: index,
  };
}

test("runtime evidence is opt-in, sanitized, separated from graph facts, and retains expired manifests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-runtime-evidence-"));
  try {
    const graph = fixture(root);
    const first = saveRuntimeEvidence(root, graph, input(graph, "runtime-0"), { now: "2026-07-15T00:00:00.000Z" });
    assert.equal(first.created, true);
    assert.equal(first.record.evidenceClass, "runtime-evidence");
    assert.equal(first.record.policy.optIn, true);
    assert.equal(graph.edges.some((edge) => edge.type === "runtime-evidence"), false);
    assert.throws(() => saveRuntimeEvidence(root, graph, { ...input(graph, "unsafe"), summary: "const token = secret;" }), /source-, credential-, or machine-specific text/);
    assert.throws(() => saveRuntimeEvidence(root, graph, { ...input(graph, "unknown"), sourceDump: "hidden" }), /documented observation fields/);

    for (let index = 1; index <= 101; index += 1) {
      saveRuntimeEvidence(root, graph, input(graph, `runtime-${index}`, index), { now: `2026-07-15T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z` });
    }
    const listed = listRuntimeEvidence(root, graph, { limit: 100 });
    assert.equal(listed.status, "available");
    assert.equal(listed.catalog.total, 100);
    assert.equal(listed.manifests.length, 2);
    assert.ok(listed.manifests.every((item) => item.artifactStatus === "expired"));
    const summary = runtimeEvidenceSummary(root, graph);
    assert.equal(summary.status, "available");
    assert.equal(summary.retained, 100);
    assert.equal(summary.expiredManifests, 2);
    const brief = createDurableBrief(graph, "project");
    assert.equal(brief.sections.runtimeEvidence.status, "available");
    assert.equal(brief.sections.runtimeEvidence.evidenceClass, "runtime-evidence");
    const packet = createHandoffContext(graph, { taskIntent: "Inspect health runtime evidence.", tokenBudget: 4096 });
    assert.equal(packet.included.runtimeEvidence.status, "available");
    assert.equal(packet.included.runtimeEvidence.retained, 100);
    const serialized = JSON.stringify(listed);
    assert.equal(serialized.includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime evidence rejects unknown input and never serves a store with injected fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-runtime-evidence-invalid-"));
  try {
    const graph = fixture(root);
    saveRuntimeEvidence(root, graph, input(graph, "valid-runtime"), { now: "2026-07-15T00:00:00.000Z" });
    const storePath = path.join(root, ".flowpeek", "runtime-evidence", "records.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    store.records[0].sourceBody = "not permitted";
    fs.writeFileSync(storePath, JSON.stringify(store));
    const listed = listRuntimeEvidence(root, graph);
    assert.equal(listed.status, "unavailable");
    assert.match(listed.diagnostics[0].message, /does not match/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
