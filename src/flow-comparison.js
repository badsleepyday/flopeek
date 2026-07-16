const { createFlowProjection } = require("./flow-lens");

const FLOW_COMPARISON_SCHEMA = "flowpeek-flow-comparison/v1";
const FLOW_LENS_SNAPSHOT_SCHEMA = "flowpeek-flow-lens-snapshot/v1";
const MAX_FLOW_COMPARISONS = 12;

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function transitionIds(step) {
  return uniqueSorted([
    step.transition?.id,
    ...(step.alternativeIncomingTransitions || []).map((transition) => transition.id),
    ...(step.branch?.transitions || []).map((transition) => transition.id),
  ]);
}

function flowSnapshot(graph, flow) {
  if (!flow) return null;
  const lens = createFlowProjection(graph, flow);
  return {
    schemaVersion: FLOW_LENS_SNAPSHOT_SCHEMA,
    id: lens.id,
    project: lens.project,
    flow: lens.flow,
    knowledgeClass: lens.knowledgeClass,
    confidence: lens.confidence,
    steps: lens.steps,
    staticBoundaries: lens.staticBoundaries,
    truncation: lens.truncation,
    limitations: lens.limitations,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparisonChanges(before, current, changedStepIds = []) {
  const beforeSteps = new Map((before?.steps || []).map((step) => [step.id, step]));
  const currentSteps = new Map((current?.steps || []).map((step) => [step.id, step]));
  const beforeIds = [...beforeSteps.keys()];
  const currentIds = [...currentSteps.keys()];
  const addedStepIds = currentIds.filter((id) => !beforeSteps.has(id)).sort();
  const removedStepIds = beforeIds.filter((id) => !currentSteps.has(id)).sort();
  const sharedIds = currentIds.filter((id) => beforeSteps.has(id)).sort();
  const movedStepIds = sharedIds.filter((id) => beforeSteps.get(id).depth !== currentSteps.get(id).depth);
  const transitionChangedStepIds = sharedIds.filter((id) => !sameJson(transitionIds(beforeSteps.get(id)), transitionIds(currentSteps.get(id))));
  const nodeMetadataChangedStepIds = sharedIds.filter((id) => {
    const beforeStep = beforeSteps.get(id);
    const currentStep = currentSteps.get(id);
    return !sameJson({ node: beforeStep.node, role: beforeStep.role, staticBoundary: beforeStep.staticBoundary }, { node: currentStep.node, role: currentStep.role, staticBoundary: currentStep.staticBoundary });
  });
  const sourceChangedStepIds = uniqueSorted(changedStepIds.filter((id) => currentSteps.has(id)));
  const changedStepIdsAll = uniqueSorted([
    ...addedStepIds,
    ...removedStepIds,
    ...movedStepIds,
    ...transitionChangedStepIds,
    ...nodeMetadataChangedStepIds,
    ...sourceChangedStepIds,
  ]);
  const unchangedStepIds = sharedIds.filter((id) => !changedStepIdsAll.includes(id));
  const beforeTransitionIds = uniqueSorted((before?.steps || []).flatMap(transitionIds));
  const currentTransitionIds = uniqueSorted((current?.steps || []).flatMap(transitionIds));
  const addedTransitionIds = currentTransitionIds.filter((id) => !beforeTransitionIds.includes(id));
  const removedTransitionIds = beforeTransitionIds.filter((id) => !currentTransitionIds.includes(id));
  const flowMetadataChanged = Boolean(before && current && !sameJson(
    { id: before.flow.id, title: before.flow.title, entryId: before.flow.entryId },
    { id: current.flow.id, title: current.flow.title, entryId: current.flow.entryId },
  ));
  const staticStructureChanged = Boolean(addedStepIds.length || removedStepIds.length || movedStepIds.length || transitionChangedStepIds.length || nodeMetadataChangedStepIds.length || addedTransitionIds.length || removedTransitionIds.length || flowMetadataChanged);
  return {
    addedStepIds,
    removedStepIds,
    movedStepIds,
    nodeMetadataChangedStepIds,
    transitionChangedStepIds,
    sourceChangedStepIds,
    unchangedStepIds,
    addedTransitionIds,
    removedTransitionIds,
    flowMetadataChanged,
    staticStructureChanged,
    sourceChangedOnly: Boolean(sourceChangedStepIds.length) && !staticStructureChanged,
  };
}

function createAdjacentFlowComparisons(previousGraph, graph, contextFlows, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || MAX_FLOW_COMPARISONS, 1), MAX_FLOW_COMPARISONS);
  const previousById = new Map((previousGraph.flows || []).map((flow) => [flow.id, flow]));
  const currentById = new Map((graph.flows || []).map((flow) => [flow.id, flow]));
  const candidates = (contextFlows?.items || []).slice().sort((left, right) => left.flow.id.localeCompare(right.flow.id));
  const comparisons = candidates.slice(0, limit).map((item) => {
    const beforeFlow = previousById.get(item.flow.id) || null;
    const currentFlow = currentById.get(item.flow.id) || null;
    const before = flowSnapshot(previousGraph, beforeFlow);
    const current = flowSnapshot(graph, currentFlow);
    const changes = comparisonChanges(before, current, item.changedStepIds || []);
    return {
      id: `flow-comparison:${item.flow.id}@${previousGraph.state.graphVersion}-${graph.state.graphVersion}`,
      flow: { id: item.flow.id, title: current?.flow.title || before?.flow.title || item.flow.title, entryId: current?.flow.entryId || before?.flow.entryId || item.flow.entryId },
      status: item.status,
      before,
      current,
      changes,
      evidence: {
        kind: "adjacent-graph-delta",
        fromGraphVersion: previousGraph.state.graphVersion,
        toGraphVersion: graph.state.graphVersion,
      },
    };
  });
  return { items: comparisons, truncated: candidates.length > comparisons.length || Boolean(contextFlows?.truncated) };
}

function findFlowComparison(delta, flowId) {
  return (delta?.flowComparisons?.items || []).find((comparison) => comparison.flow.id === flowId || comparison.flow.entryId === flowId) || null;
}

function flowComparisonResult(graph, delta, flowId) {
  const base = {
    schemaVersion: FLOW_COMPARISON_SCHEMA,
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    fromGraphVersion: delta?.fromGraphVersion ?? null,
    toGraphVersion: delta?.toGraphVersion ?? null,
    flowId,
  };
  if (!delta || delta.projectId !== graph.project.projectId) {
    return { ...base, available: false, comparison: null, limitation: "No matching retained adjacent graph delta is available for this project." };
  }
  const comparison = findFlowComparison(delta, flowId);
  if (!comparison) {
    return {
      ...base,
      available: false,
      comparison: null,
      limitation: "This flow was not captured as an affected flow in the retained adjacent delta. Flowpeek does not reconstruct an old Flow Lens from the current graph or runtime behavior.",
    };
  }
  return {
    ...base,
    available: true,
    comparison,
    limitation: "Before and current sides are bounded static Flow Lens snapshots captured during one adjacent graph delta. They do not prove runtime order, control flow, business behavior, or a complete historical Context Card.",
  };
}

module.exports = {
  FLOW_COMPARISON_SCHEMA,
  FLOW_LENS_SNAPSHOT_SCHEMA,
  MAX_FLOW_COMPARISONS,
  comparisonChanges,
  createAdjacentFlowComparisons,
  findFlowComparison,
  flowComparisonResult,
};
