"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { getChangedContexts, resolveContextRef } = require("../../src/graph-service");
const { createRepositoryScanner, scanRepository } = require("../../src/scanner");

const SOURCE = path.join(__dirname, "..", "fixtures", "typescript-order-flow");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-session-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(SOURCE, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  return root;
}

function serviceNode(graph) {
  return graph.nodes.find((node) => node.label === "Orders Service");
}

function changeService(root) {
  const target = path.join(root, "src", "orders", "orders.service.ts");
  fs.appendFileSync(target, "\nexport const sessionMarker = true;\n");
  return "src/orders/orders.service.ts";
}

test("cache-disabled scanner uses monotonic session versions and in-memory adjacent delta evidence", (t) => {
  const root = fixture(t);
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const first = scanner.scan();
  const node = serviceNode(first);
  const firstRef = createContextRef(first.project.projectId, "node", node.id, first.state.graphVersion);

  assert.equal(first.project.identity.status, "session-only");
  assert.equal(first.state.graphVersion, 1);
  assert.equal(first.state.status, "session-advanced");
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);

  const changedPath = changeService(root);
  const second = scanner.scan([changedPath]);
  assert.equal(second.project.projectId, first.project.projectId);
  assert.equal(second.state.graphVersion, 2);
  assert.equal(second.analysis.latestDelta.fromGraphVersion, 1);
  assert.equal(second.analysis.latestDelta.toGraphVersion, 2);

  const resolution = resolveContextRef(second, firstRef);
  assert.equal(resolution.status, "stale");
  assert.equal(resolution.delta.toGraphVersion, 2);
  const changed = getChangedContexts(second, { fromVersion: 1, toVersion: 2 });
  assert.equal(changed.available, true);
  assert.equal(changed.delta.sourceChanged, true);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("independent cache-disabled scanners cannot treat another session Context Ref as current", (t) => {
  const root = fixture(t);
  const canonical = scanRepository(root);
  const canonicalProjectId = canonical.project.projectId;

  const first = createRepositoryScanner(root, { persistIdentity: false }).scan();
  const firstNode = serviceNode(first);
  const firstRef = createContextRef(first.project.projectId, "node", firstNode.id, first.state.graphVersion);
  changeService(root);
  const second = createRepositoryScanner(root, { persistIdentity: false }).scan();

  assert.equal(first.project.identity.canonicalProjectId, canonicalProjectId);
  assert.equal(second.project.identity.canonicalProjectId, canonicalProjectId);
  assert.notEqual(second.project.projectId, first.project.projectId);
  assert.equal(second.state.graphVersion, 1);
  const resolution = resolveContextRef(second, firstRef);
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.code, "wrong-project-id");
});
