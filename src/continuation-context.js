"use strict";

const { getContinuationCheckpoint } = require("./continuation-checkpoint");
const { getPlannedOverlay } = require("./planned-overlay");
const { compareContinuation } = require("./continuation-comparison");
const { getCheckpointDivergence } = require("./continuation-divergence");
const { listPlanReconciliations } = require("./plan-reconciliation");
const { listWorkRecords } = require("./delivery-graph");
const { getWorkDependencyStatus } = require("./workflow-engine");

const CONTINUATION_CONTEXT_SCHEMA = "flowpeek-continuation-context/v1";
const TOKENIZER_ID = "flowpeek-char4-estimator/v1";
const MIN_TOKEN_BUDGET = 1024;
const MAX_TOKEN_BUDGET = 16384;
const MAX_CONTEXTS = 24;

class ContinuationContextError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ContinuationContextError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function safeId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value)) throw new ContinuationContextError(`invalid-${field}`, `${field} must be a safe identifier up to 160 characters.`);
  return value;
}

function compactText(value, maximum = 480) {
  const text = typeof value === "string" ? value : null;
  return text && text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function estimate(packet) {
  const estimatedCharacterCount = JSON.stringify(packet).length;
  return { estimatedCharacterCount, estimatedTokenCount: Math.ceil(estimatedCharacterCount / 4) };
}

function updateEstimate(packet) {
  for (let index = 0; index < 3; index += 1) Object.assign(packet.budget, estimate(packet));
  return packet;
}

function compactCard(resolution) {
  const card = resolution.card;
  if (!card) return null;
  const projection = card.projection;
  return {
    contextRef: resolution.resolvedRef || resolution.requestedRef,
    kind: card.kind,
    title: compactText(card.title || card.node?.label || card.flow?.title, 240),
    knowledgeClass: card.knowledgeClass || "extracted",
    confidence: card.confidence || null,
    technicalSummary: compactText(card.technicalSummary?.text || null),
    relatedTestCount: Array.isArray(card.relatedTests) ? card.relatedTests.length : 0,
    displayedStaticStepCount: Array.isArray(projection?.steps) ? projection.steps.length : null,
    limitation: compactText((card.limitations || [])[0] || null),
  };
}

function resolveSelected(graph, checkpoint, options) {
  const resolver = options.resolveContextRef;
  if (typeof resolver !== "function") throw new ContinuationContextError("missing-context-resolver", "A current Context Ref resolver is required.", 500);
  return checkpoint.selectedContextRefs.map((item) => {
    const resolution = resolver(item.contextRef);
    return {
      requestedRef: item.contextRef,
      status: resolution.status,
      resolvedRef: resolution.resolvedRef || null,
      reason: resolution.reason || null,
      card: compactCard(resolution),
    };
  });
}

function unavailable(graph, diagnostics) {
  return {
    schemaVersion: CONTINUATION_CONTEXT_SCHEMA,
    status: "unavailable",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    packet: null,
    diagnostics,
    limitation: "Required retained continuation evidence is unavailable. Flowpeek does not reconstruct missing history, source bodies, or implementation evidence.",
  };
}

function createContinuationContext(root, graph, input = {}, options = {}) {
  const checkpointId = safeId(input.checkpointId, "checkpointId");
  const overlayId = input.overlayId === undefined || input.overlayId === null ? null : safeId(input.overlayId, "overlayId");
  const tokenBudget = Number(input.tokenBudget ?? 4000);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < MIN_TOKEN_BUDGET || tokenBudget > MAX_TOKEN_BUDGET) throw new ContinuationContextError("invalid-token-budget", `tokenBudget must be an integer from ${MIN_TOKEN_BUDGET} to ${MAX_TOKEN_BUDGET}.`);
  const checkpointResult = getContinuationCheckpoint(root, graph, checkpointId);
  if (checkpointResult.status !== "available") return unavailable(graph, checkpointResult.diagnostics || []);
  const checkpoint = checkpointResult.checkpoint;
  const selected = resolveSelected(graph, checkpoint, options);
  const unresolved = selected.filter((item) => item.status !== "current");
  let overlay = null;
  let comparison = null;
  let planReconciliations = [];
  const diagnostics = [];
  if (overlayId) {
    const overlayResult = getPlannedOverlay(root, graph, overlayId);
    if (overlayResult.status !== "available") return unavailable(graph, overlayResult.diagnostics || []);
    overlay = overlayResult.overlay;
    if (overlay.checkpointId !== checkpoint.id) throw new ContinuationContextError("overlay-checkpoint-mismatch", "The selected overlay does not belong to checkpointId.", 409);
    comparison = compareContinuation(root, graph, { checkpointId, overlayId });
    const reconciliationResult = listPlanReconciliations(root, graph);
    diagnostics.push(...(reconciliationResult.diagnostics || []));
    const planRefs = new Set(overlay.nodes.map((node) => node.planRef));
    planReconciliations = (reconciliationResult.records || []).filter((record) => planRefs.has(record.planRef)).map((record) => ({ id: record.id, planRef: record.planRef, outcome: record.outcome, actorKind: record.actorKind, createdAt: record.createdAt, actualContextStatuses: record.actualContextStatuses }));
  }
  const workResult = listWorkRecords(root, graph, { limit: 100 });
  diagnostics.push(...(workResult.diagnostics || []));
  const workIds = new Set(checkpoint.workRecordIds);
  const workRecords = (workResult.records || []).filter((record) => workIds.has(record.id)).map((record) => {
    const dependencyReadiness = getWorkDependencyStatus(root, graph, record.id);
    return {
      id: record.id,
      title: compactText(record.title, 240),
      state: record.state || null,
      contextRefCount: Array.isArray(record.contextRefs) ? record.contextRefs.length : 0,
      dependencyReadiness: dependencyReadiness.status === "available"
        ? dependencyReadiness.summary
        : { status: "unavailable" },
    };
  });
  const packet = {
    schemaVersion: CONTINUATION_CONTEXT_SCHEMA,
    status: unresolved.length ? "requires-source-fallback" : "ready",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceFingerprint: graph.state.sourceFingerprint },
    baseline: { checkpointId: checkpoint.id, freshnessStatus: checkpoint.freshnessStatus, git: checkpoint.baseline.git, graphVersion: checkpoint.baseline.graphVersion, sourceFingerprint: checkpoint.baseline.sourceFingerprint },
    divergence: getCheckpointDivergence(root, graph, checkpointId),
    selectedContexts: selected,
    work: { records: workRecords, completedWorkRecordIds: checkpoint.completedWorkRecordIds, remainingWorkRecordIds: checkpoint.remainingWorkRecordIds },
    planned: overlay ? { overlayId: overlay.id, overlayVersion: overlay.overlayVersion, checkpointFreshnessStatus: overlay.checkpointFreshnessStatus, nodes: overlay.nodes.map((node) => ({ planRef: node.planRef, id: node.id, kind: node.kind, title: node.title, responsibility: compactText(node.responsibility), acceptanceCriteria: node.acceptanceCriteria, anchors: node.anchors, candidatePath: node.candidatePath })), comparison, reconciliations: planReconciliations } : null,
    continuation: { constraints: checkpoint.constraints, acceptanceCriteria: checkpoint.acceptanceCriteria, unresolvedQuestions: checkpoint.unresolvedQuestions },
    nextSafeSteps: [
      "Stop and inspect current source with authorized host tools when any selected Context Ref is not current.",
      "Treat Plan Refs as delivery intent, not source facts or implementation proof.",
      "Before entering implementation, stop for declared dependencies that are blocking, unresolved, or unknown; ready is local workflow metadata only.",
      "Edit only through authorized host workspace tools; Flowpeek has no source-write or execution surface.",
      "After edits, refresh_graph, inspect get_changed_contexts, then compare baseline, plan, and current context.",
      "An agent may record only a reconciliation proposal; human confirmation remains unresolved.",
    ],
    omissions: { selectedContexts: { total: selected.length, included: selected.length, omitted: 0, reasons: [] }, plannedOverlay: overlay ? { total: 1, included: 1, omitted: 0, reasons: [] } : { total: 0, included: 0, omitted: 0, reasons: ["no-overlay-selected"] }, unresolvedSelectedContextRefs: unresolved.map((item) => ({ contextRef: item.requestedRef, status: item.status })) },
    budget: { requestedTokenBudget: tokenBudget, tokenizerId: TOKENIZER_ID, estimation: "approximate-character-fallback", characterBudget: tokenBudget * 4, estimatedCharacterCount: 0, estimatedTokenCount: 0, status: "within-budget" },
    limitations: ["No source-file body, absolute machine path, credential, shell access, target execution, private reasoning, or runtime claim is included.", "Static parser facts, planned metadata, and reconciliation assertions remain separate evidence classes."],
    diagnostics,
  };
  while (JSON.stringify(packet).length > packet.budget.characterBudget && packet.selectedContexts.length) {
    const omitted = packet.selectedContexts.pop();
    packet.omissions.selectedContexts.included -= 1;
    packet.omissions.selectedContexts.omitted += 1;
    packet.omissions.selectedContexts.reasons = ["selected-context-card-omitted-to-respect-budget"];
    packet.omissions.unresolvedSelectedContextRefs.push({ contextRef: omitted.requestedRef, status: "omitted" });
  }
  if (JSON.stringify(packet).length > packet.budget.characterBudget) packet.budget.status = "minimum-envelope-exceeded";
  return updateEstimate(packet);
}

module.exports = { CONTINUATION_CONTEXT_SCHEMA, ContinuationContextError, MAX_TOKEN_BUDGET, MIN_TOKEN_BUDGET, TOKENIZER_ID, createContinuationContext };
