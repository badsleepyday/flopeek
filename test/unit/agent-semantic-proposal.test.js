"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepositoryScanner, writeGraphCache } = require("../../src/scanner");
const { getAgentSemanticProposal, getFlowProjection, getSemanticReviewQueue, getVerifiedSemanticMemory, recordAgentSemanticProposal, verifyFlow } = require("../../src/graph-service");
const { readAgentSemanticProposalStore } = require("../../src/agent-semantic-proposal");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function proposal(lens, overrides = {}) {
  return {
    operationId: "agent-proposal-1",
    expectedFlowContextRef: lens.flow.contextRef,
    candidate: {
      title: "Submit Checkout Order",
      technicalPurpose: "Accept a checkout request and delegate order submission.",
      role: "command-action",
      grouping: { key: "checkout", label: "Checkout" },
      owner: "Commerce",
      risk: "high",
      questions: ["Is inventory reserved first?"],
    },
    proposedBy: "local-agent",
    provider: "test-provider",
    rationale: "Route and exact handler evidence indicate an order submission action.",
    ...overrides,
  };
}

test("agent proposal is an unverified current overlay, becomes stale, and enters the human review queue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-agent-proposal-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "agent-proposal" }));
    write(root, "src/orders.routes.ts", "router.post('/orders', () => submit());");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    const flowId = first.flows[0].id;
    const lens = getFlowProjection(first, flowId);
    const saved = recordAgentSemanticProposal(first, flowId, proposal(lens));
    assert.equal(saved.created, true);
    assert.equal(saved.record.knowledgeClass, "agent-proposed");
    assert.equal(saved.record.verificationStatus, "unverified");
    assert.equal(getAgentSemanticProposal(first, flowId).status, "current");
    const queue = getSemanticReviewQueue(first, { status: "agent-proposed" });
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].agentProposal.candidate.title, "Submit Checkout Order");

    write(root, "src/orders.routes.ts", "router.post('/orders', () => submit({ changed: true }));");
    const second = scanner.scan(["src/orders.routes.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/orders.routes.ts"] });
    assert.equal(getAgentSemanticProposal(second, flowId).status, "stale");
    assert.throws(() => recordAgentSemanticProposal(second, flowId, proposal(lens, { operationId: "stale-proposal" })), /current Flow Context Ref/);
    assert.equal(fs.readFileSync(path.join(root, ".flopeek", "agent-semantic-proposals.json"), "utf8").includes("submit({ changed"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verified semantic memory is verification-backed and excludes stale records by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-semantic-memory-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "semantic-memory" }));
    write(root, "src/orders.routes.ts", "router.post('/orders', () => submit());");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    const flowId = first.flows[0].id;
    const lens = getFlowProjection(first, flowId);
    verifyFlow(first, flowId, {
      expectedGraphVersion: lens.project.graphVersion,
      expectedFlowContextRef: lens.flow.contextRef,
      title: "Submit order",
      description: "Submit a customer order.",
      owner: "Commerce",
      risk: "high",
      questions: [],
      verifiedBy: "Flow owner",
    });
    const memory = getVerifiedSemanticMemory(first, { query: "customer" });
    assert.equal(memory.records.length, 1);
    assert.equal(memory.records[0].reusable, true);
    assert.equal(memory.storage.relativePath, ".flopeek/flow-verifications.json");
    assert.equal(memory.storage.modelWeightsStored, false);

    write(root, "src/orders.routes.ts", "router.post('/orders', () => submit({ changed: true }));");
    const second = scanner.scan(["src/orders.routes.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/orders.routes.ts"] });
    const currentMemory = getVerifiedSemanticMemory(second);
    assert.equal(currentMemory.records.length, 0);
    assert.equal(currentMemory.omitted.byStatus.stale, 1);
    const auditMemory = getVerifiedSemanticMemory(second, { includeStale: true });
    assert.equal(auditMemory.records[0].reusable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agent proposal store rejects recursively unknown fields and is not overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-agent-proposal-schema-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "agent-proposal-schema" }));
    write(root, "src/route.ts", "router.get('/accounts', () => true);");
    const graph = createRepositoryScanner(root).scan();
    writeGraphCache(root, graph, { reason: "initial" });
    const flowId = graph.flows[0].id;
    const lens = getFlowProjection(graph, flowId);
    recordAgentSemanticProposal(graph, flowId, proposal(lens));
    const target = path.join(root, ".flopeek", "agent-semantic-proposals.json");
    const injected = JSON.parse(fs.readFileSync(target, "utf8"));
    injected.records[0].candidate.hiddenPayload = "must-not-be-served";
    fs.writeFileSync(target, JSON.stringify(injected), "utf8");
    assert.equal(readAgentSemanticProposalStore(root, graph.project.projectId).status, "invalid");
    assert.equal(getAgentSemanticProposal(graph, flowId).status, "unavailable");
    assert.throws(() => recordAgentSemanticProposal(graph, flowId, proposal(lens, { operationId: "second" })), /does not match/);
    assert.equal(fs.readFileSync(target, "utf8").includes("must-not-be-served"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
