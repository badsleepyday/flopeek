"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TOKENIZER_ID, createHandoffContext } = require("../../src/handoff-context");
const { saveHandoffWorkspace } = require("../../src/handoff-workspace");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(root) {
  write(root, "package.json", JSON.stringify({ name: "handoff-context-fixture" }));
  write(root, "src/payment/payment.routes.ts", "import { PaymentService } from './payment.service';\nrouter.post('/payments/approve', () => PaymentService.approve());");
  write(root, "src/payment/payment.service.ts", "const SECRET_SOURCE_SENTINEL = 'do-not-export';\nexport class PaymentService { static approve() {} }");
  write(root, "src/payment/payment.service.spec.ts", "import { PaymentService } from './payment.service';\ntest('approve payment', () => PaymentService.approve());");
  write(root, "src/payment/coverage.spec.ts", "test('coverage', () => true);");
  write(root, "src/invitation/invitation.routes.ts", "router.post('/invite/redeem', () => true);");
  write(root, "src/app/api/me/route.ts", "export async function GET() { return Response.json({ ok: true }); }\nexport async function POST() { return Response.json({ ok: true }); }");
  return scanRepository(root);
}

test("get_handoff_context is deterministic, relevance-ranked, portable, and within its declared budget", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-context-"));
  try {
    const graph = fixture(root);
    saveHandoffWorkspace(root, graph, { operationId: "context-handoff-v1", author: "Test team", purpose: "Keep payment approval changes bounded and reviewable." }, { now: "2026-07-14T00:00:00.000Z" });
    const input = {
      taskIntent: "change payment approval and verify the related payment test",
      changedPaths: ["src/payment/payment.service.ts"],
      targetFeature: "payment",
      tokenBudget: 2400,
      desiredEvidenceDepth: "evidence",
    };
    const first = createHandoffContext(graph, input);
    const second = createHandoffContext(graph, input);
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, "flowpeek-handoff-context/v1");
    assert.equal(first.budget.tokenizerId, TOKENIZER_ID);
    assert.equal(first.budget.status, "within-budget");
    assert.equal(first.budget.estimatedCharacterCount, JSON.stringify(first).length);
    assert.ok(first.budget.estimatedCharacterCount <= first.budget.characterBudget);
    assert.equal(first.included.features[0].id, "feature:payment");
    assert.deepEqual(first.included.pathAnchors.map((item) => item.path), ["src/payment/payment.service.ts"]);
    assert.ok(first.included.pathAnchors.every((item) => item.relevance.reasons.includes("exact-changed-path")));
    assert.ok(first.included.features.every((item) => item.relevance.score > 0));
    assert.equal(first.included.features.some((item) => item.id === "feature:invitation"), false);
    assert.equal(first.included.handoffWorkspace.purpose, "Keep payment approval changes bounded and reviewable.");
    assert.ok(first.included.flows.some((flow) => flow.title.includes("/payments/approve")));
    assert.equal(first.included.flows.find((flow) => flow.title.includes("/payments/approve")).truncation.requestedMaxSteps, 12);
    assert.ok(first.included.tests.some((item) => item.path === "src/payment/payment.service.spec.ts"));
    assert.ok(first.included.evidenceRefs.every((ref) => ref.startsWith("fp://local/")));
    assert.equal(first.omitted.features.total, first.omitted.features.included + first.omitted.features.omitted);
    assert.equal(first.confidence.runtimeClaim, false);
    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("SECRET_SOURCE_SENTINEL"), false);
    const exactHandlerPacket = createHandoffContext(graph, { taskIntent: "inspect current user", targetFlow: "GET /api/me", tokenBudget: 1800, desiredEvidenceDepth: "evidence" });
    const exactHandlerFlow = exactHandlerPacket.included.flows.find((flow) => flow.title === "GET /api/me");
    assert.equal(exactHandlerFlow.confidence.level, "high");
    assert.deepEqual(exactHandlerFlow.confidence.reasons, ["exact-handler"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("handoff context keeps exact changed paths and rejects same-feature tests without direct or task evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-relevance-"));
  try {
    const graph = fixture(root);
    const packet = createHandoffContext(graph, {
      taskIntent: "update approval behavior",
      changedPaths: ["src/payment/payment.service.ts"],
      targetFeature: "payment",
      tokenBudget: 1800,
      desiredEvidenceDepth: "standard",
    });
    assert.equal(packet.included.pathAnchors.length, 1);
    assert.equal(packet.included.pathAnchors[0].path, "src/payment/payment.service.ts");
    assert.ok(packet.included.tests.some((item) => item.path === "src/payment/payment.service.spec.ts" && item.relevance.reasons.includes("direct-static-edge-to-selected-flow")));
    assert.equal(packet.included.tests.some((item) => item.path === "src/payment/coverage.spec.ts"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standard handoff depth retains every exact changed path while the token budget remains authoritative", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-path-anchors-"));
  try {
    const graph = fixture(root);
    const changedPaths = [
      "src/payment/payment.routes.ts",
      "src/payment/payment.service.ts",
      "src/payment/payment.service.spec.ts",
      "src/payment/coverage.spec.ts",
      "src/invitation/invitation.routes.ts",
      "src/app/api/me/route.ts",
    ];
    const packet = createHandoffContext(graph, {
      taskIntent: "review changed source paths",
      changedPaths,
      tokenBudget: 4000,
      desiredEvidenceDepth: "standard",
    });
    assert.deepEqual(packet.included.pathAnchors.map((item) => item.path), [...changedPaths].sort());
    assert.equal(packet.omitted.pathAnchors.omitted, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("small packets expose omissions and never silently exceed the minimum supported envelope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-budget-"));
  try {
    const graph = fixture(root);
    const packet = createHandoffContext(graph, { taskIntent: "understand the project", tokenBudget: 1024, desiredEvidenceDepth: "summary" });
    assert.equal(packet.budget.status, "within-budget");
    assert.ok(JSON.stringify(packet).length <= 4096);
    assert.ok(packet.omitted.flows.omitted >= 0);
    if (packet.omitted.flows.omittedIdsNotListed) assert.ok(packet.omitted.flows.reasons.includes("omitted-id-list-truncated-to-respect-budget"));
    assert.throws(() => createHandoffContext(graph, { taskIntent: "unsafe", changedPaths: ["../secret"], tokenBudget: 1024 }), /repository-relative/);
    assert.throws(() => createHandoffContext(graph, { taskIntent: "unsupported", tokenBudget: 1024, tokenizerId: "pretend-model-tokenizer" }), /supports only/);
    const deduplicated = createHandoffContext(graph, { taskIntent: "payment", changedPaths: ["src/payment/payment.service.ts", "src/payment/payment.service.ts"], tokenBudget: 1024 });
    assert.deepEqual(deduplicated.request.changedPaths.items, ["src/payment/payment.service.ts"]);
    const longIntent = createHandoffContext(graph, { taskIntent: "payment ".repeat(450), tokenBudget: 1024, desiredEvidenceDepth: "summary" });
    assert.equal(longIntent.request.taskIntentTruncated, true);
    assert.equal(longIntent.budget.status, "within-budget");
    assert.ok(JSON.stringify(longIntent).length <= longIntent.budget.characterBudget);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
