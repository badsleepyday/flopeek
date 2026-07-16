const { createContextRef } = require("./context-card");
const { DEFAULT_FLOW_LENS_MAX_STEPS, MAX_FLOW_LENS_STEPS, validateFlowLensMaxSteps } = require("./flow-lens-options");

const FLOW_LENS_SCHEMA = "flowpeek-flow-lens/v1";
const FLOW_TRAVERSAL_STEP_BOUND = MAX_FLOW_LENS_STEPS;

function nodeSummary(node) {
  return { id: node.id, label: node.label, type: node.type, kind: node.kind, path: node.path || null };
}

function evidenceEdgeId(edge) {
  return `edge:${edge.source}|${edge.type}|${edge.target}`;
}

function evidenceEdge(edge) {
  return {
    id: evidenceEdgeId(edge),
    sourceId: edge.source,
    targetId: edge.target,
    type: edge.type,
    confidence: edge.confidence || "unknown",
    evidence: edge.evidence || null,
  };
}

function stepRole(node) {
  if (node.kind === "endpoint") return "entry";
  if (["route", "controller"].includes(node.type)) return "routing";
  if (node.type === "service") return "orchestration";
  if (["repository", "database"].includes(node.type)) return "persistence";
  if (node.type === "queue") return "async-boundary";
  if (node.type === "external") return "external-boundary";
  if (node.kind === "symbol") return "implementation";
  if (node.type === "module") return "module";
  return "technical-component";
}

function staticBoundary(node) {
  if (node.type === "database") return "persistence";
  if (node.type === "queue") return "async";
  if (node.type === "external") return "external";
  return null;
}

function availableFlows(graph, scope) {
  return scope === "all" ? graph.diagnosticFlows || graph.flows : graph.flows;
}

function findFlow(graph, flowId, scope) {
  return availableFlows(graph, scope).find((flow) => flow.id === flowId || flow.entryId === flowId) || null;
}

function createFlowProjection(graph, flow, options = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new Error("Flow Lens requires a project ID and graph version.");
  if (!flow?.entryId || !Array.isArray(flow.steps)) throw new Error("Flow Lens requires a detected flow with steps.");
  const maxSteps = validateFlowLensMaxSteps(options.maxSteps ?? DEFAULT_FLOW_LENS_MAX_STEPS);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const sourceSteps = flow.steps.filter((step) => nodeById.has(step.id));
  const sourceStepById = new Map(sourceSteps.map((step) => [step.id, step]));
  const displayedSourceSteps = sourceSteps.slice(0, maxSteps);
  const displayedIds = new Set(displayedSourceSteps.map((step) => step.id));
  const exactTransitions = graph.edges
    .filter((edge) => displayedIds.has(edge.source) && displayedIds.has(edge.target))
    .filter((edge) => sourceStepById.get(edge.source).depth + 1 === sourceStepById.get(edge.target).depth)
    .sort((left, right) => evidenceEdgeId(left).localeCompare(evidenceEdgeId(right)));
  const parentsByTarget = new Map();
  for (const edge of exactTransitions) {
    if (!parentsByTarget.has(edge.target)) parentsByTarget.set(edge.target, []);
    parentsByTarget.get(edge.target).push(edge);
  }
  const primaryParentByTarget = new Map();
  for (const [target, parents] of parentsByTarget) primaryParentByTarget.set(target, parents[0]);
  const primaryChildrenBySource = new Map();
  for (const edge of primaryParentByTarget.values()) {
    if (!primaryChildrenBySource.has(edge.source)) primaryChildrenBySource.set(edge.source, []);
    primaryChildrenBySource.get(edge.source).push(edge);
  }
  const steps = displayedSourceSteps.map((sourceStep, index) => {
    const node = nodeById.get(sourceStep.id);
    const parents = parentsByTarget.get(node.id) || [];
    const primaryParent = primaryParentByTarget.get(node.id) || null;
    const children = (primaryChildrenBySource.get(node.id) || []).sort((left, right) => evidenceEdgeId(left).localeCompare(evidenceEdgeId(right)));
    const omittedChildren = graph.edges
      .filter((edge) => edge.source === node.id && sourceStepById.has(edge.target) && !displayedIds.has(edge.target))
      .filter((edge) => sourceStep.depth + 1 === sourceStepById.get(edge.target).depth)
      .length;
    return {
      index: index + 1,
      depth: sourceStep.depth,
      id: node.id,
      node: nodeSummary(node),
      role: stepRole(node),
      knowledgeClass: "derived",
      confidence: primaryParent?.confidence || node.analysis?.confidence || "unknown",
      contextRef: createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion),
      transition: primaryParent ? evidenceEdge(primaryParent) : null,
      alternativeIncomingTransitions: parents.slice(1).map(evidenceEdge),
      branch: children.length + omittedChildren > 1 ? {
        kind: "fan-out",
        transitions: children.map(evidenceEdge),
        omittedTargets: omittedChildren,
      } : null,
      staticBoundary: staticBoundary(node),
    };
  });
  const boundaries = steps
    .filter((step) => step.staticBoundary)
    .map((step) => ({ category: step.staticBoundary, node: step.node, contextRef: step.contextRef, knowledgeClass: "derived" }));
  const missingTransitions = steps.slice(1).filter((step) => !step.transition).map((step) => step.id);
  const truncation = {
    requestedMaxSteps: maxSteps,
    displayedSteps: steps.length,
    sourceFlowSteps: sourceSteps.length,
    displayTruncated: sourceSteps.length > steps.length,
    displayTruncationReason: sourceSteps.length > steps.length ? "requested-step-limit-reached" : null,
    sourceTraversalStepBound: FLOW_TRAVERSAL_STEP_BOUND,
    sourceTraversalMayBeTruncated: sourceSteps.length >= FLOW_TRAVERSAL_STEP_BOUND,
    sourceTraversalTruncationReason: sourceSteps.length >= FLOW_TRAVERSAL_STEP_BOUND ? "source-traversal-bound-reached" : null,
    missingTransitionEvidence: missingTransitions,
  };
  const entryNode = nodeById.get(flow.entryId);
  const handlerEdge = graph.edges.find((edge) => edge.source === flow.entryId && edge.type === "handles") || null;
  const handlerNode = handlerEdge ? nodeById.get(handlerEdge.target) : null;
  const exactHandler = Boolean(handlerNode?.kind === "symbol" && handlerEdge?.confidence === "exact");
  const siblingHandlerIds = sourceSteps
    .map((step) => nodeById.get(step.id))
    .filter((node) => node?.kind === "symbol" && node.path === entryNode?.path && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(node.label) && node.id !== handlerNode?.id)
    .map((node) => node.id);
  const handlerEvidence = {
    binding: exactHandler ? "exact-handler" : handlerNode ? "non-exact-handler" : "file-fallback",
    handlerId: handlerNode?.id || null,
    edge: handlerEdge ? evidenceEdge(handlerEdge) : null,
    siblingHandlerContamination: siblingHandlerIds.length > 0,
    siblingHandlerIds,
  };
  const limitations = [
    "This is a bounded static technical projection from a detected HTTP/request entry. It is not a runtime trace, business process, control-flow proof, or timing sequence.",
    "Step roles and static boundaries are derived from node type and parser evidence; they do not establish ownership, side-effect success, or external behavior.",
  ];
  if (truncation.displayTruncated) limitations.push(`The lens displays the first ${steps.length} of ${sourceSteps.length} traversed steps; use raw dependencies to inspect omitted continuation.`);
  if (truncation.sourceTraversalMayBeTruncated) limitations.push(`The source traversal reached Flowpeek's ${FLOW_TRAVERSAL_STEP_BOUND}-step bound; further static continuation may be omitted.`);
  if (missingTransitions.length) limitations.push("Some displayed steps have no adjacent-depth parser edge in the retained traversal; they are shown as static members, not a proven transition.");
  if (!exactHandler) limitations.push("The endpoint could not be bound to one exact exported HTTP handler symbol, so this is a lower-confidence file-level fallback rather than handler-specific evidence.");
  if (handlerEvidence.siblingHandlerContamination) limitations.push("Sibling HTTP handler symbols were retained in this traversal. Semantic confidence is reduced until the containment path is removed or inspected.");
  return {
    schemaVersion: FLOW_LENS_SCHEMA,
    id: `lens:${flow.id}@${graph.state.graphVersion}`,
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    flow: {
      id: flow.id,
      title: flow.title,
      entryId: flow.entryId,
      contextRef: createContextRef(graph.project.projectId, "flow", flow.id, graph.state.graphVersion),
      entryContextRef: createContextRef(graph.project.projectId, "node", flow.entryId, graph.state.graphVersion),
    },
    knowledgeClass: "derived",
    confidence: exactHandler && !handlerEvidence.siblingHandlerContamination ? "exact-static-evidence" : "limited-static-evidence",
    steps,
    staticBoundaries: boundaries,
    truncation,
    handlerEvidence,
    verification: null,
    unresolvedQuestions: ["No flow-level human verification record exists in this vertical slice."],
    limitations,
    safeActions: [
      { id: "inspect-node", label: "Inspect a raw node Context Card", kind: "navigation" },
      { id: "inspect-dependencies", label: "Inspect direct static dependencies", kind: "navigation" },
      { id: "inspect-impact", label: "Inspect static change impact", kind: "recommendation" },
    ],
  };
}

function getFlowProjection(graph, flowId, scope = "application", options = {}) {
  const flow = findFlow(graph, flowId, scope);
  return flow ? createFlowProjection(graph, flow, options) : null;
}

module.exports = {
  DEFAULT_FLOW_LENS_MAX_STEPS,
  FLOW_LENS_SCHEMA,
  FLOW_TRAVERSAL_STEP_BOUND,
  createFlowProjection,
  evidenceEdgeId,
  getFlowProjection,
};
