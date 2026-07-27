"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CORE_COMPATIBILITY_SCHEMA,
  createCoreCompatibilityDigest,
  createCoreCompatibilityProjection,
  createSourceDigest,
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

test("core compatibility facts are invariant across LF and CRLF source checkouts", (context) => {
  const fixture = path.join(ROOT, "test", "fixtures", "python-payment-flow");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-newline-contract-"));
  const lfRoot = path.join(temporaryRoot, "lf");
  const crlfRoot = path.join(temporaryRoot, "crlf");
  context.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.cpSync(fixture, lfRoot, { recursive: true });
  fs.cpSync(fixture, crlfRoot, { recursive: true });

  for (const relativePath of ["src/payments/routes.py", "src/payments/service.py", "src/payments/service_test.py"]) {
    const canonical = fs.readFileSync(path.join(fixture, relativePath), "utf8").replace(/\r\n?/gu, "\n");
    fs.writeFileSync(path.join(lfRoot, relativePath), canonical, "utf8");
    fs.writeFileSync(path.join(crlfRoot, relativePath), canonical.replace(/\n/gu, "\r\n"), "utf8");
  }

  const lfGraph = scanRepository(lfRoot, { persistIdentity: false });
  const crlfGraph = scanRepository(crlfRoot, { persistIdentity: false });
  assert.equal(createSourceDigest(lfRoot), createSourceDigest(crlfRoot));
  assert.equal(createCoreCompatibilityDigest(lfGraph), createCoreCompatibilityDigest(crlfGraph));
  assert.deepEqual(createCoreCompatibilityProjection(lfGraph), createCoreCompatibilityProjection(crlfGraph));
});

test("committed JavaScript core baseline matches every audited fixture", () => {
  const baseline = verifyJsCoreBaseline();
  assert.ok(baseline.cases.length >= 10);
  assert.ok(baseline.cases.every((item) => item.sourceDigest.startsWith("sha256:")));
  assert.ok(baseline.cases.every((item) => item.compatibilityDigest.startsWith("sha256:")));
});
