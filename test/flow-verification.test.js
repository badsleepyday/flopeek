const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepositoryScanner, writeGraphCache } = require("../src/scanner");
const { getFlowContextCard, getFlowProjection, getFlowVerification, verifyFlow } = require("../src/graph-service");
const { FlowVerificationError, readFlowVerificationStore } = require("../src/flow-verification");

function write(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-verification-"));
  write(root, "package.json", JSON.stringify({ name: "verification-example" }));
  write(root, "src/orders.routes.ts", "import { submit } from './orders.service';\nrouter.post('/orders', () => submit());");
  write(root, "src/orders.service.ts", "export function submit() { return true; }");
  const scanner = createRepositoryScanner(root);
  const first = scanner.scan();
  writeGraphCache(root, first, { reason: "initial" });
  return { root, scanner, graph: first, flowId: "flow:endpoint:src/orders.routes.ts:POST:/orders" };
}

function input(overrides = {}) {
  return {
    title: "Submit order",
    description: "Accepts an order request and delegates submission to the order service.",
    owner: "Commerce",
    risk: "high",
    questions: ["Does the service reserve inventory before payment?"],
    verifiedBy: "Flow owner",
    ...overrides,
  };
}

test("flow verification is immutable, visible in Flow Lens and Context Cards, and excludes source contents", () => {
  const { root, graph, flowId } = setup();
  try {
    const verification = verifyFlow(graph, flowId, input());
    assert.equal(verification.status, "current");
    assert.equal(verification.record.sourceGraphVersion, 1);
    assert.equal(verification.record.supersedes, null);
    const lens = getFlowProjection(graph, flowId);
    assert.equal(lens.verification.status, "current");
    assert.equal(lens.unresolvedQuestions[0], "Does the service reserve inventory before payment?");
    const card = getFlowContextCard(graph, flowId);
    assert.equal(card.card.humanVerification.knowledgeClass, "human-verified");
    assert.equal(card.card.humanVerification.title, "Submit order");
    assert.equal(JSON.stringify(card).includes("return true"), false);
    const markdown = getFlowContextCard(graph, flowId, "markdown");
    assert.match(markdown.markdown, /Human verification/);
    assert.match(markdown.markdown, /Submit order/);

    const superseding = verifyFlow(graph, flowId, input({ title: "Submit customer order", description: "Confirmed current order submission behavior.", risk: "medium" }));
    assert.equal(superseding.status, "current");
    assert.equal(superseding.record.supersedes, verification.record.id);
    assert.equal(superseding.history.length, 2);
    assert.equal(superseding.history.find((record) => record.id === verification.record.id).lifecycleStatus, "superseded");
    const store = readFlowVerificationStore(root, graph.project.projectId);
    assert.equal(store.status, "valid");
    assert.equal(store.store.records.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("flow verification is compatible for unrelated changes, stale for participating source changes, and detached after removal", () => {
  const { root, scanner, graph: first, flowId } = setup();
  try {
    verifyFlow(first, flowId, input());
    write(root, "src/unrelated.ts", "export const unrelated = true;");
    const second = scanner.scan(["src/unrelated.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/unrelated.ts"] });
    assert.equal(getFlowVerification(second, flowId).status, "compatible");

    write(root, "src/orders.service.ts", "export function submit() { return false; }");
    const third = scanner.scan(["src/orders.service.ts"]);
    writeGraphCache(root, third, { reason: "filesystem", changedPaths: ["src/orders.service.ts"] });
    const stale = getFlowVerification(third, flowId);
    assert.equal(stale.status, "stale");
    assert.match(stale.reason, /orders\.service\.ts/);

    fs.rmSync(path.join(root, "src", "orders.routes.ts"));
    const fourth = scanner.scan(["src/orders.routes.ts"]);
    writeGraphCache(root, fourth, { reason: "filesystem", changedPaths: ["src/orders.routes.ts"] });
    const detached = getFlowVerification(fourth, flowId);
    assert.equal(detached.status, "detached");
    assert.equal(detached.record.title, "Submit order");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid verification metadata is not overwritten and invalid human input is rejected", () => {
  const { root, graph, flowId } = setup();
  try {
    const target = path.join(root, ".flowpeek", "flow-verifications.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ not valid json");
    assert.equal(readFlowVerificationStore(root, graph.project.projectId).status, "invalid");
    assert.throws(() => verifyFlow(graph, flowId, input()), (error) => error instanceof FlowVerificationError && error.code === "invalid-verification-store");
    assert.equal(fs.readFileSync(target, "utf8"), "{ not valid json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verification rejects a draft that does not target the current graph and Flow Context Ref", () => {
  const { root, scanner, graph: first, flowId } = setup();
  try {
    const lens = getFlowProjection(first, flowId);
    write(root, "src/orders.service.ts", "export function submit() { return false; }");
    const second = scanner.scan(["src/orders.service.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/orders.service.ts"] });
    assert.throws(() => verifyFlow(second, flowId, input({ expectedGraphVersion: lens.project.graphVersion, expectedFlowContextRef: lens.flow.contextRef })), (error) => error instanceof FlowVerificationError && error.code === "stale-verification-draft" && error.statusCode === 409);
    assert.equal(getFlowVerification(second, flowId).status, "unverified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
