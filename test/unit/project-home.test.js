"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { saveHandoffWorkspace } = require("../../src/handoff-workspace");
const { projectHome } = require("../../src/project-home");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(root) {
  write(root, "package.json", JSON.stringify({ name: "project-home-fixture" }));
  write(root, "src/app/api/auth/login/route.ts", "const SOURCE_BODY_SENTINEL = 'never export';\nexport async function POST() { return Response.json({ ok: true }); }");
  write(root, "src/app/api/payments/approve/route.ts", "export async function POST() { return Response.json({ ok: true }); }");
  write(root, "src/app/api/invitations/redeem/route.ts", "export async function POST() { return Response.json({ ok: true }); }");
  write(root, "src/notifications/reminder.ts", "export function sendReminder() {}");
  write(root, "test/payment.test.js", "const testOnly = require('fixture-payments-sdk');\nfunction paymentTestSentinel() { return testOnly; }");
  return scanRepository(root);
}

test("project home never invents purpose and exposes evidence-linked human and deterministic cards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-project-home-"));
  try {
    const graph = fixture(root);
    const before = projectHome(graph);
    assert.equal(before.purpose.status, "unavailable");
    assert.equal(before.architectureOverview.status, "unavailable");
    assert.equal(before.criticalFlows.status, "unavailable");
    assert.equal(before.handoffReadiness.percentage, 0);
    assert.ok(before.recommendedStartingPoints.items.length > 0);
    assert.equal(before.recommendedStartingPoints.evidenceClass, "deterministic-inference");

    const flow = graph.flows.find((item) => item.title === "POST /api/payments/approve");
    const startRef = createContextRef(graph.project.projectId, "flow", flow.id, graph.state.graphVersion);
    const approvalEndpoint = graph.nodes.find((item) => item.kind === "endpoint" && item.label === "POST /api/payments/approve");
    const approvalEndpointRef = createContextRef(graph.project.projectId, "node", approvalEndpoint.id, graph.state.graphVersion);
    saveHandoffWorkspace(root, graph, {
      operationId: "project-home-v1",
      author: "Handoff owner",
      purpose: "Operate authentication, invitations, payments, and notifications safely.",
      architectureSummary: "Next route handlers expose application endpoints grouped by domain.",
      criticalFlowIds: [flow.id],
      owners: ["Platform team owns route boundaries."],
      risks: ["Payment approval changes require focused review."],
      knownLimitations: ["Runtime provider behavior is unavailable."],
      unresolvedQuestions: ["Who owns invitation expiry policy?"],
      recommendedStartingPointRefs: [startRef],
      conceptTags: [{ subjectRef: approvalEndpointRef, tags: ["reconciliation"] }],
    }, { now: "2026-07-14T01:00:00.000Z" });
    const after = projectHome(graph, { concept: "payments" });
    assert.equal(after.purpose.status, "available");
    assert.equal(after.purpose.evidenceClass, "human-authored");
    assert.equal(after.criticalFlows.total, 1);
    assert.equal(after.recommendedStartingPoints.evidenceClass, "human-authored");
    assert.ok(after.handoffReadiness.percentage > 0);
    assert.ok(after.featureMap.items.every((item) => item.briefRef.startsWith("fp://local/")));
    assert.ok(after.featureMap.items.every((item) => item.evidenceRefCatalog.total === item.evidenceRefCatalog.returned + item.evidenceRefCatalog.omitted));
    assert.ok(after.featureMap.items.every((item) => item.evidenceRefCatalog.omittedIds.length === item.evidenceRefCatalog.omitted));
    assert.ok(after.conceptSearch.results.some((item) => item.label.includes("payments")));
    assert.ok(after.conceptSearch.results.every((item) => item.reasons.length > 0 && item.contextRef.startsWith("fp://local/")));
    const serialized = JSON.stringify(after);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("SOURCE_BODY_SENTINEL"), false);
    const reconciliation = projectHome(graph, { concept: "reconciliation" });
    assert.ok(reconciliation.conceptSearch.results.some((item) => item.id === approvalEndpoint.id && item.reasons.some((reason) => reason.includes("humanTag"))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concept index uses exact deterministic token reasons and does not claim semantic or runtime proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-concept-index-"));
  try {
    const graph = fixture(root);
    const home = projectHome(graph, { concept: "authentication" });
    assert.equal(home.conceptIndex.schemaVersion, "flopeek-concept-index/v1");
    assert.match(home.conceptIndex.policy, /exact deterministic token matches/);
    assert.ok(home.conceptSearch.results.some((item) => item.reasons.some((reason) => reason.includes("'login'"))));
    assert.equal(home.conceptSearch.results.some((item) => item.label.includes("payments")), false);
    const payments = projectHome(graph, { concept: "payments" });
    assert.equal(payments.conceptSearch.results.some((item) => item.path?.includes("test/payment.test.js")), false);
    assert.equal(payments.conceptSearch.results.some((item) => item.id.includes("fixture-payments-sdk")), false);
    assert.match(payments.conceptIndex.policy, /application-scoped/);
    const unknown = projectHome(graph, { concept: "database" });
    assert.equal(unknown.conceptSearch.status, "unavailable");
    assert.deepEqual(unknown.conceptSearch.results, []);
    const ambiguous = projectHome(graph, { concept: "settlement" });
    assert.equal(ambiguous.conceptSearch.status, "abstained");
    assert.equal(ambiguous.conceptSearch.matchMode, "ambiguous-alias");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project home falls back to evidence-linked features when no application flow is available", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-project-home-no-flow-"));
  try {
    const graph = fixture(root);
    graph.flows = [];
    const home = projectHome(graph);
    assert.ok(home.recommendedStartingPoints.items.length > 0);
    assert.match(home.recommendedStartingPoints.items[0].text, /feature area/);
    assert.ok(home.recommendedStartingPoints.items.every((item) => item.evidenceRefs[0].startsWith("fp://local/")));
    assert.equal(home.recommendedStartingPoints.catalog.total, home.featureMap.total);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
