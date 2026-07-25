const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepositoryScanner, writeGraphCache } = require("../../src/scanner");
const { getFlowProjection, getFlowVerification, getSemanticSuggestionFeedback, listSemanticSuggestionFeedback, recordAgentEvidenceTrace, recordSemanticSuggestionFeedback } = require("../../src/graph-service");
const { SemanticSuggestionFeedbackError, feedbackMetrics, feedbackPath, readSemanticSuggestionFeedbackStore } = require("../../src/semantic-suggestion-feedback");
const { evaluateSemanticSuggestionFeedbackCorpus } = require("../../src/semantic-suggestion-feedback-evaluation");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-semantic-feedback-"));
  write(root, "package.json", JSON.stringify({ name: "semantic-feedback-example" }));
  write(root, "src/orders.routes.ts", "import { submit } from './orders.service';\nrouter.post('/orders', () => submit());");
  write(root, "src/orders.service.ts", "export function submit() { return true; }");
  const scanner = createRepositoryScanner(root);
  const graph = scanner.scan();
  writeGraphCache(root, graph, { reason: "initial" });
  return { root, graph, flowId: "flow:endpoint:src/orders.routes.ts:POST:/orders" };
}

function input(overrides = {}) {
  return {
    operationId: "semantic-feedback-001",
    decision: "accepted",
    reviewedBy: "Flow owner",
    ...overrides,
  };
}

test("semantic feedback is immutable, linked to a current suggestion and optional matching trace, and never creates verification", () => {
  const { root, graph, flowId } = setup();
  try {
    const lens = getFlowProjection(graph, flowId);
    const trace = recordAgentEvidenceTrace(graph, {
      operationId: "trace-order-001",
      contextRef: lens.flow.contextRef,
      actionType: "test",
      actionSummary: "Ran focused order-flow tests.",
      changedPaths: ["src/orders.service.ts"],
      verificationStatus: "passed",
      verificationSummary: "Focused order-flow tests passed.",
      actor: "agent-test",
    });
    const accepted = recordSemanticSuggestionFeedback(graph, flowId, input({ traceOperationId: trace.record.operationId }));
    assert.equal(accepted.created, true);
    assert.equal(accepted.record.knowledgeClass, "human-feedback");
    assert.equal(accepted.record.decision, "accepted");
    assert.equal(accepted.record.traceLink.operationId, "trace-order-001");
    assert.equal(getFlowVerification(graph, flowId).status, "unverified");

    const retry = recordSemanticSuggestionFeedback(graph, flowId, input({ traceOperationId: trace.record.operationId }));
    assert.equal(retry.created, false);
    assert.equal(retry.record.id, accepted.record.id);

    const edited = recordSemanticSuggestionFeedback(graph, flowId, input({
      operationId: "semantic-feedback-002",
      decision: "edited",
      reason: "Use the team's order naming convention.",
      editedCandidate: {
        title: "Submit Order",
        technicalPurpose: "Submits the statically detected order request to the local order service.",
        role: "create-request",
        grouping: { key: "orders", label: "Orders" },
      },
    }));
    assert.equal(edited.record.supersedes, accepted.record.id);
    const feedback = getSemanticSuggestionFeedback(graph, flowId);
    assert.equal(feedback.status, "current");
    assert.equal(feedback.record.decision, "edited");
    assert.equal(feedback.history.length, 2);
    assert.equal(feedback.history.find((record) => record.id === accepted.record.id).lifecycleStatus, "superseded");
    const listed = listSemanticSuggestionFeedback(graph, { flowId });
    assert.equal(listed.totalMatched, 2);
    assert.equal(feedbackMetrics(listed.records).editedRate, 0.5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semantic feedback validates decisions, edit labels, and trace Context Ref binding", () => {
  const { root, graph, flowId } = setup();
  try {
    const lens = getFlowProjection(graph, flowId);
    assert.throws(() => recordSemanticSuggestionFeedback(graph, flowId, input({ decision: "rejected" })), (error) => error instanceof SemanticSuggestionFeedbackError && error.code === "missing-reason");
    assert.throws(() => recordSemanticSuggestionFeedback(graph, flowId, input({ decision: "edited", reason: "Needs a different title." })), (error) => error.code === "missing-edited-candidate");
    assert.throws(() => recordSemanticSuggestionFeedback(graph, flowId, input({ decision: "abstained", reason: "No review." })), (error) => error.code === "incompatible-decision");
    recordAgentEvidenceTrace(graph, {
      operationId: "trace-node-001",
      contextRef: lens.steps[1].contextRef,
      actionType: "inspect",
      actionSummary: "Inspected the order service node.",
      changedPaths: [],
      verificationStatus: "not-run",
      verificationSummary: "No command was needed.",
      actor: "agent-test",
    });
    assert.throws(() => recordSemanticSuggestionFeedback(graph, flowId, input({ traceOperationId: "trace-node-001" })), (error) => error.code === "trace-context-mismatch");
    assert.equal(fs.existsSync(feedbackPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid semantic feedback metadata is preserved and feedback is never flow verification", () => {
  const { root, graph, flowId } = setup();
  try {
    fs.mkdirSync(path.dirname(feedbackPath(root)), { recursive: true });
    fs.writeFileSync(feedbackPath(root), "{ invalid json", "utf8");
    const before = fs.readFileSync(feedbackPath(root), "utf8");
    assert.equal(readSemanticSuggestionFeedbackStore(root, graph.project.projectId).status, "invalid");
    assert.throws(() => recordSemanticSuggestionFeedback(graph, flowId, input()), (error) => error.code === "invalid-semantic-feedback-store");
    assert.equal(fs.readFileSync(feedbackPath(root), "utf8"), before);
    const unavailable = getSemanticSuggestionFeedback(graph, flowId);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(Object.hasOwn(unavailable, "verification"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("synthetic feedback evaluation checks metric aggregation without claiming human calibration", () => {
  const corpus = {
    schemaVersion: "flopeek-semantic-suggestion-feedback-evaluation/v1",
    interpretation: "Synthetic contract only.",
    records: [
      { id: "a", decision: "accepted", traceVerificationStatus: "passed" },
      { id: "b", decision: "edited" },
      { id: "c", decision: "rejected", traceVerificationStatus: "failed" },
      { id: "d", decision: "abstained" },
    ],
    expected: {
      total: 4,
      decisions: { accepted: 1, edited: 1, rejected: 1, abstained: 1 },
      traceLinked: 2,
      traceVerificationStatuses: { passed: 1, failed: 1 },
    },
  };
  const result = evaluateSemanticSuggestionFeedbackCorpus(corpus);
  assert.equal(result.passed, true);
  assert.equal(result.metrics.traceLinkedRate, 0.5);
  assert.equal(result.interpretation, "Synthetic contract only.");
  assert.throws(() => evaluateSemanticSuggestionFeedbackCorpus({ schemaVersion: corpus.schemaVersion, records: [] }), /Invalid semantic suggestion feedback evaluation corpus/);
});
