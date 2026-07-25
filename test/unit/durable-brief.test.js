"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDurableBrief, createDurableBriefPacket, listDurableBriefManifests, materializeDurableBrief, resolveDurableBriefRef, sourceBasis } = require("../../src/durable-brief");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixtureGraph(root) {
  write(root, "package.json", JSON.stringify({ name: "durable-brief-fixture" }));
  write(root, "src/app/api/payments/route.ts", "const INTERNAL_SENTINEL_BODY = 'SUPER_SECRET_BODY';\nexport async function GET() { return Response.json({ ok: true }); }\nexport async function POST() { return Response.json({ ok: true }); }\n");
  return scanRepository(root);
}

test("layered Project, Feature, Flow, and Node Briefs preserve evidence classes and portable provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-durable-brief-"));
  try {
    const graph = fixtureGraph(root);
    const flow = graph.flows.find((item) => item.title === "GET /api/payments");
    const node = graph.nodes.find((item) => item.id.endsWith(":function:GET"));
    const feature = graph.nodes.find((item) => item.feature)?.feature;
    const briefs = [
      createDurableBrief(graph, "project"),
      createDurableBrief(graph, "feature", feature),
      createDurableBrief(graph, "flow", flow.id),
      createDurableBrief(graph, "node", node.id),
    ];
    for (const brief of briefs) {
      assert.equal(brief.schemaVersion, "flopeek-brief/v1");
      assert.equal(brief.projectIdentity.projectId, graph.project.projectId);
      assert.equal(brief.graphVersion, graph.state.graphVersion);
      assert.equal(brief.evidenceClass, "deterministic-inference");
      assert.equal(brief.freshnessStatus, "current");
      assert.equal(brief.briefPolicy.derivedEvidenceCeiling, "deterministic-inference");
      assert.equal(brief.sections.parserFacts.evidenceClass, "static-parser-fact");
      assert.equal(brief.sections.deterministicInference.evidenceClass, "deterministic-inference");
      assert.equal(brief.sections.humanNotes.evidenceClass, "human-authored");
      assert.equal(brief.sections.verificationRecords.evidenceClass, "human-verified");
      assert.equal(brief.sections.runtimeEvidence.status, "unavailable");
      const serialized = JSON.stringify(brief);
      assert.equal(serialized.includes(root), false);
      assert.equal(serialized.includes("SUPER_SECRET_BODY"), false);
      assert.match(serialized, /source-file bod(?:y|ies)/);
    }
    const markdown = createDurableBriefPacket(graph, "flow", flow.id, "markdown");
    assert.match(markdown.markdown, /Evidence class: deterministic-inference/);
    assert.match(markdown.markdown, /No opt-in sanitized runtime evidence store/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable Brief manifests survive artifact eviction and report current, stale, and expired states", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-brief-manifest-"));
  try {
    const graph = fixtureGraph(root);
    const materialized = materializeDurableBrief(root, graph, "project");
    assert.equal(materialized.created, true);
    assert.equal(materializeDurableBrief(root, graph, "project").created, false);
    let listed = listDurableBriefManifests(root, graph, { kind: "project" });
    assert.equal(listed.total, 1);
    assert.equal(listed.records[0].freshnessStatus, "current");
    assert.equal(listed.records[0].artifactStatus, "retained");

    const laterGraph = { ...graph, state: { ...graph.state, graphVersion: graph.state.graphVersion + 1 } };
    listed = listDurableBriefManifests(root, laterGraph, { kind: "project" });
    assert.equal(listed.records[0].freshnessStatus, "stale");

    fs.rmSync(path.join(root, listed.records[0].artifact.relativePath));
    listed = listDurableBriefManifests(root, laterGraph, { kind: "project" });
    assert.equal(listed.records[0].artifactStatus, "expired");
    assert.match(listed.records[0].artifactReason, /manifest and provenance remain/);
    const resolution = resolveDurableBriefRef(root, laterGraph, materialized.brief.briefRef);
    assert.equal(resolution.status, "expired");
    assert.equal(resolution.manifest.hash, materialized.brief.integrity.contentHash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source basis uses a clean Git revision only when cleanliness is known", () => {
  const base = { state: { sourceRevision: "abc1234", sourceFingerprint: "sha256:source" }, project: { git: {} } };
  assert.equal(sourceBasis(base).kind, "working-tree-fingerprint");
  assert.equal(sourceBasis({ ...base, project: { git: { dirty: true } } }).kind, "working-tree-fingerprint");
  assert.deepEqual(sourceBasis({ ...base, project: { git: { dirty: false } } }), {
    kind: "git-revision",
    value: "abc1234",
    gitRevision: "abc1234",
    sourceFingerprint: "sha256:source",
  });
});
