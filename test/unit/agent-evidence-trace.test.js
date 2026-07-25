const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const {
  AgentEvidenceTraceError,
  agentEvidenceTracePolicy,
  listAgentEvidenceTraces,
  readAgentEvidenceTraceStore,
  saveAgentEvidenceTrace,
  tracePath,
} = require("../../src/agent-evidence-trace");

function graph(root, version = 3) {
  return {
    project: { root, projectId: "project:test" },
    state: { graphVersion: version, sourceRevision: "abc123" },
  };
}

function input(contextRef, overrides = {}) {
  return {
    operationId: "agent-run-001",
    contextRef,
    actionType: "edit",
    actionSummary: "Refactored the payment handler while preserving the detected request boundary.",
    changedPaths: ["src\\payment.ts", "test/payment.test.ts", "src/payment.ts"],
    verificationStatus: "passed",
    verificationSummary: "Focused tests passed: 4/4.",
    actor: "codex",
    ...overrides,
  };
}

test("agent evidence traces are immutable, idempotent, and queryable by Context Ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-agent-evidence-"));
  try {
    const current = graph(root);
    const contextRef = createContextRef(current.project.projectId, "flow", "flow:payment", current.state.graphVersion);
    const first = saveAgentEvidenceTrace(root, current, input(contextRef), { resolution: { status: "current" }, now: "2026-07-14T10:00:00.000Z" });
    assert.equal(first.created, true);
    assert.equal(first.record.schemaVersion, "flopeek-agent-evidence-trace/v1");
    assert.equal(first.record.knowledgeClass, "agent-declared");
    assert.deepEqual(first.record.changedPaths, ["src/payment.ts", "test/payment.test.ts"]);
    assert.equal(first.record.project.evidenceGraphVersion, 3);
    assert.equal(first.record.project.recordedGraphVersion, 3);
    assert.equal(first.record.context.resolutionStatus, "current");

    const retry = saveAgentEvidenceTrace(root, graph(root, 4), input(contextRef), { resolution: { status: "unresolved" }, now: "2026-07-14T11:00:00.000Z" });
    assert.equal(retry.created, false);
    assert.equal(retry.record.id, first.record.id);
    assert.equal(readAgentEvidenceTraceStore(root, current.project.projectId).store.records.length, 1);

    const listed = listAgentEvidenceTraces(root, current, { contextRef, limit: 10 });
    assert.equal(listed.status, "available");
    assert.equal(listed.totalMatched, 1);
    assert.equal(listed.records[0].verification.status, "passed");
    assert.match(listed.limitation, /private reasoning/);

    const policy = agentEvidenceTracePolicy(root, current);
    assert.equal(policy.totalRecords, 1);
    assert.equal(policy.recentRecords[0].changedPathCount, 2);
    assert.equal(Object.hasOwn(policy.recentRecords[0], "actionSummary"), false);

    assert.throws(() => saveAgentEvidenceTrace(root, current, input(contextRef, { actionSummary: "Different immutable payload." }), { resolution: { status: "current" } }), (error) => error instanceof AgentEvidenceTraceError && error.code === "operation-id-conflict");

    const validStore = readAgentEvidenceTraceStore(root, current.project.projectId).store;
    fs.writeFileSync(tracePath(root), JSON.stringify({ ...validStore, records: [...validStore.records, validStore.records[0]] }), "utf8");
    assert.equal(readAgentEvidenceTraceStore(root, current.project.projectId).status, "invalid");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agent evidence traces reject unresolved refs and unsafe changed paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-agent-evidence-invalid-"));
  try {
    const current = graph(root);
    const contextRef = createContextRef(current.project.projectId, "node", "file:src/payment.ts", 2);
    assert.throws(() => saveAgentEvidenceTrace(root, current, input(contextRef)), (error) => error.code === "unresolved-context-ref");
    assert.throws(() => saveAgentEvidenceTrace(root, current, input(contextRef), { resolution: { status: "unresolved" } }), (error) => error.code === "unresolved-context-ref");
    assert.throws(() => saveAgentEvidenceTrace(root, current, input(contextRef, { changedPaths: ["../secret.txt"] }), { resolution: { status: "stale" } }), (error) => error.code === "unsafe-changed-path");
    assert.throws(() => saveAgentEvidenceTrace(root, current, input(contextRef, { changedPaths: ["C:\\outside.txt"] }), { resolution: { status: "stale" } }), (error) => error.code === "unsafe-changed-path");
    assert.throws(() => saveAgentEvidenceTrace(root, current, input(contextRef), { resolution: { status: "stale" }, now: "not-a-time" }), (error) => error.code === "invalid-created-at");
    assert.equal(fs.existsSync(tracePath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid agent evidence metadata is preserved and reported unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-agent-evidence-store-"));
  try {
    const current = graph(root);
    fs.mkdirSync(path.dirname(tracePath(root)), { recursive: true });
    fs.writeFileSync(tracePath(root), "{ invalid json", "utf8");
    const before = fs.readFileSync(tracePath(root), "utf8");
    const listed = listAgentEvidenceTraces(root, current);
    assert.equal(listed.status, "unavailable");
    assert.equal(listed.records.length, 0);
    const contextRef = createContextRef(current.project.projectId, "node", "file:src/payment.ts", 3);
    assert.throws(() => saveAgentEvidenceTrace(root, current, input(contextRef), { resolution: { status: "current" } }), (error) => error.code === "invalid-agent-evidence-trace-store");
    assert.equal(fs.readFileSync(tracePath(root), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
