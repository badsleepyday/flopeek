"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { createContinuationCheckpoint } = require("../../src/continuation-checkpoint");
const { createContinuationContext } = require("../../src/continuation-context");
const { createPlannedOverlay } = require("../../src/planned-overlay");
const { resolveContextRef } = require("../../src/graph-service");
const { scanRepository } = require("../../src/scanner");

function write(root, file, content) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, "utf8"); }

test("continuation context is bounded, versioned, source-free, and explicit about stale selected refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-continuation-context-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "continuation-context" }));
    write(root, "src/app/api/orders/route.ts", "const PRIVATE_SOURCE_SENTINEL = 'omit'; export async function GET() { return { ok: true }; }\n");
    const baseline = scanRepository(root, { persistIdentity: true });
    const ref = createContextRef(baseline.project.projectId, "flow", baseline.flows[0].id, baseline.state.graphVersion);
    const { createWorkRecord } = require("../../src/delivery-graph");
    createWorkRecord(root, baseline, { operationId: "context-work", id: "task.context", kind: "task", title: "Continue the bounded order flow", contextRefs: [ref], createdBy: "developer", createdAt: "2026-07-18T08:00:00.000Z" });
    createContinuationCheckpoint(root, baseline, { operationId: "context-checkpoint", id: "checkpoint.context", expectedGraphVersion: baseline.state.graphVersion, selectedContextRefs: [ref], workRecordIds: ["task.context"], remainingWorkRecordIds: ["task.context"], constraints: ["Keep static evidence separate."], acceptanceCriteria: ["Refresh after edits."], unresolvedQuestions: ["What runtime behavior is required?"], createdBy: "developer", createdByKind: "human" });
    const overlay = createPlannedOverlay(root, baseline, { operationId: "context-overlay", id: "overlay.context", expectedGraphVersion: baseline.state.graphVersion, checkpointId: "checkpoint.context", nodes: [{ id: "planned.order-audit", kind: "service", title: "Order audit", responsibility: "Record planned audit metadata.", acceptanceCriteria: ["Human review remains required."], anchors: [ref], candidatePath: "src/orders/audit.ts" }], edges: [], createdBy: "developer", createdByKind: "human" }).overlay;
    const resolver = (value) => resolveContextRef(baseline, value);
    const first = createContinuationContext(root, baseline, { checkpointId: "checkpoint.context", overlayId: overlay.id, tokenBudget: 2048 }, { resolveContextRef: resolver });
    const second = createContinuationContext(root, baseline, { checkpointId: "checkpoint.context", overlayId: overlay.id, tokenBudget: 2048 }, { resolveContextRef: resolver });
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, "flopeek-continuation-context/v1");
    assert.equal(first.status, "ready");
    assert.equal(first.budget.status, "within-budget");
    assert.ok(first.budget.estimatedCharacterCount <= first.budget.characterBudget);
    assert.equal(first.selectedContexts[0].status, "current");
    assert.equal(first.work.records[0].dependencyReadiness.readyToStart, true);
    assert.equal(first.planned.nodes[0].planRef.startsWith("fpp://local/"), true);
    assert.equal(JSON.stringify(first).includes(root), false);
    assert.equal(JSON.stringify(first).includes("PRIVATE_SOURCE_SENTINEL"), false);
    const changed = structuredClone(baseline); changed.state.graphVersion += 1; changed.state.sourceFingerprint = "sha256:changed";
    const stale = createContinuationContext(root, changed, { checkpointId: "checkpoint.context", tokenBudget: 2048 }, { resolveContextRef: (value) => resolveContextRef(changed, value) });
    assert.equal(stale.status, "requires-source-fallback");
    assert.equal(stale.selectedContexts[0].status, "stale");
    assert.equal(stale.omissions.plannedOverlay.reasons[0], "no-overlay-selected");
    assert.throws(() => createContinuationContext(root, baseline, { checkpointId: "checkpoint.context", tokenBudget: 100 }, { resolveContextRef: resolver }), /1024/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
