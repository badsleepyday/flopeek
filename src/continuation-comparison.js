"use strict";

const { getContinuationCheckpoint } = require("./continuation-checkpoint");
const { getPlannedOverlay } = require("./planned-overlay");
const { listPlanReconciliations } = require("./plan-reconciliation");

const CONTINUATION_COMPARISON_SCHEMA = "flowpeek-continuation-comparison/v1";
const PLAN_STATUSES = new Set([
  "planned-only",
  "reconciled",
  "partial",
  "implemented-differently",
  "superseded",
  "anchor-stale",
  "unresolved",
]);

class ContinuationComparisonError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ContinuationComparisonError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function activeReconciliations(records) {
  const superseded = new Set(records.map((record) => record.supersedes).filter(Boolean));
  return records
    .filter((record) => !superseded.has(record.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

function planStatus({ checkpointFreshnessStatus, planResolution, reconciliations, reconciliationAvailability }) {
  if (reconciliationAvailability !== "available") return "unresolved";
  const latest = activeReconciliations(reconciliations)[0] || null;
  if (latest?.outcome === "confirmed-implemented") return "reconciled";
  if (latest?.outcome === "partially-implemented") return "partial";
  if (latest?.outcome === "implemented-differently") return "implemented-differently";
  if (latest?.outcome === "superseded") return "superseded";
  if (latest) return "unresolved";
  if (planResolution?.status === "unavailable" || planResolution?.status === "unresolved" || checkpointFreshnessStatus === "unavailable") return "unresolved";
  if (checkpointFreshnessStatus !== "current" || planResolution?.status !== "current") return "anchor-stale";
  return "planned-only";
}

function compactReconciliation(record) {
  return {
    id: record.id,
    outcome: record.outcome,
    actor: record.actor,
    actorKind: record.actorKind,
    knowledgeClass: record.knowledgeClass,
    createdAt: record.createdAt,
    supersedes: record.supersedes,
    actualContextStatuses: record.actualContextStatuses,
  };
}

function compareContinuation(root, graph, options = {}) {
  const checkpointId = options.checkpointId;
  const overlayId = options.overlayId;
  if (typeof checkpointId !== "string" || !checkpointId) throw new ContinuationComparisonError("missing-checkpoint-id", "checkpointId is required.");
  if (typeof overlayId !== "string" || !overlayId) throw new ContinuationComparisonError("missing-overlay-id", "overlayId is required.");

  const checkpointResult = getContinuationCheckpoint(root, graph, checkpointId);
  const overlayResult = getPlannedOverlay(root, graph, overlayId);
  if (checkpointResult.status !== "available" || overlayResult.status !== "available") {
    return {
      schemaVersion: CONTINUATION_COMPARISON_SCHEMA,
      status: "unavailable",
      project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
      baseline: null,
      planned: null,
      current: { graphVersion: graph.state.graphVersion, sourceFingerprint: graph.state.sourceFingerprint },
      plans: [],
      diagnostics: [...(checkpointResult.diagnostics || []), ...(overlayResult.diagnostics || [])],
      limitation: "Retained checkpoint or planned-overlay evidence is unavailable. Flowpeek does not infer missing implementation, reconstruct omitted historical state, or use similarity matching.",
    };
  }
  const checkpoint = checkpointResult.checkpoint;
  const overlay = overlayResult.overlay;
  if (overlay.checkpointId !== checkpoint.id) {
    throw new ContinuationComparisonError("overlay-checkpoint-mismatch", "The selected planned overlay does not belong to the selected continuation checkpoint.", 409);
  }

  const reconciliationResult = listPlanReconciliations(root, graph);
  const reconciliationsByPlan = new Map();
  for (const record of reconciliationResult.records || []) {
    const existing = reconciliationsByPlan.get(record.planRef) || [];
    existing.push(record);
    reconciliationsByPlan.set(record.planRef, existing);
  }
  const plans = overlay.nodes.map((node) => {
    const reconciliations = reconciliationsByPlan.get(node.planRef) || [];
    const latest = activeReconciliations(reconciliations)[0] || null;
    const status = planStatus({
      checkpointFreshnessStatus: overlay.checkpointFreshnessStatus,
      planResolution: latest?.planResolution || { status: overlay.checkpointFreshnessStatus === "unavailable" ? "unavailable" : overlay.checkpointFreshnessStatus },
      reconciliations,
      reconciliationAvailability: reconciliationResult.status,
    });
    if (!PLAN_STATUSES.has(status)) throw new ContinuationComparisonError("invalid-comparison-status", "Comparison produced an unsupported plan status.", 500);
    return {
      planRef: node.planRef,
      plannedNode: {
        id: node.id,
        kind: node.kind,
        title: node.title,
        responsibility: node.responsibility,
        candidatePath: node.candidatePath,
        anchors: node.anchors,
      },
      status,
      checkpointFreshnessStatus: overlay.checkpointFreshnessStatus,
      latestReconciliation: latest ? compactReconciliation(latest) : null,
      reconciliations: reconciliations.map(compactReconciliation),
      limitation: "This status reports retained plan metadata, current Context Ref resolution, and recorded reconciliation only. It is not source proof, a historical reconstruction, test proof, runtime evidence, or approval authority.",
    };
  });
  const statusCounts = Object.fromEntries([...PLAN_STATUSES].map((status) => [status, plans.filter((plan) => plan.status === status).length]));
  return {
    schemaVersion: CONTINUATION_COMPARISON_SCHEMA,
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    baseline: {
      checkpointId: checkpoint.id,
      freshnessStatus: checkpoint.freshnessStatus,
      git: checkpoint.baseline.git,
      graphVersion: checkpoint.baseline.graphVersion,
      sourceFingerprint: checkpoint.baseline.sourceFingerprint,
    },
    planned: {
      overlayId: overlay.id,
      overlayVersion: overlay.overlayVersion,
      checkpointId: overlay.checkpointId,
      checkpointFreshnessStatus: overlay.checkpointFreshnessStatus,
      nodeCount: overlay.nodes.length,
    },
    current: { graphVersion: graph.state.graphVersion, sourceFingerprint: graph.state.sourceFingerprint },
    plans,
    summary: { statusCounts, reconciliationAvailability: reconciliationResult.status },
    diagnostics: reconciliationResult.diagnostics || [],
    limitation: "This deterministic comparison uses retained checkpoint/overlay metadata and current Context Ref resolution plus append-only reconciliation records. Missing or unavailable retained evidence is unknown or unavailable, never evidence that an implementation is absent. Flowpeek uses no AI, similarity, or automatic materialization heuristic here.",
  };
}

module.exports = {
  CONTINUATION_COMPARISON_SCHEMA,
  ContinuationComparisonError,
  PLAN_STATUSES,
  compareContinuation,
};
