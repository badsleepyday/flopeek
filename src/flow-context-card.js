const { CONTEXT_CARD_SCHEMA, createContextRef } = require("./context-card");

const MAX_FLOW_CARD_TESTS = 20;

function nodeSummary(node) {
  return { id: node.id, label: node.label, type: node.type, kind: node.kind, path: node.path || null };
}

function edgeSummary(edge) {
  return {
    id: edge.id || `edge:${edge.source}|${edge.type}|${edge.target}`,
    sourceId: edge.source,
    targetId: edge.target,
    type: edge.type,
    confidence: edge.confidence || "unknown",
    evidence: edge.evidence || null,
  };
}

function relatedFlowTests(graph, lens) {
  const stepIds = new Set(lens.steps.map((step) => step.id));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const filesByPath = new Map(graph.nodes.filter((node) => node.kind === "file" && node.path).map((node) => [node.path, node]));
  for (const step of lens.steps) {
    if (!step.node?.path) continue;
    const containingFile = filesByPath.get(step.node.path);
    if (containingFile) stepIds.add(containingFile.id);
  }
  const byTestId = new Map();
  for (const edge of graph.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const test = source?.type === "test" && stepIds.has(edge.target)
      ? source
      : target?.type === "test" && stepIds.has(edge.source)
        ? target
        : null;
    if (!test || byTestId.has(test.id)) continue;
    byTestId.set(test.id, { test: nodeSummary(test), edge: edgeSummary(edge) });
  }
  const all = [...byTestId.values()].sort((left, right) => left.test.id.localeCompare(right.test.id));
  return { items: all.slice(0, MAX_FLOW_CARD_TESTS), truncated: all.length > MAX_FLOW_CARD_TESTS };
}

function createFlowContextCard(graph, lens) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new Error("Flow Context Cards require a project ID and graph version.");
  if (!lens?.flow?.id || !Array.isArray(lens.steps)) throw new Error("Flow Context Cards require a Flow Lens.");
  const tests = relatedFlowTests(graph, lens);
  const limitations = [
    ...lens.limitations,
    "This card is a portable view of bounded static evidence. It does not retain source-file contents, credentials, runtime events, or business rationale.",
    "Related tests are limited to direct stored relationships for the displayed Flow Lens steps.",
  ];
  if (!tests.items.length) limitations.push("No direct test relationship was found for the displayed steps; that does not prove behavioral coverage is absent.");
  return {
    schemaVersion: CONTEXT_CARD_SCHEMA,
    contextRef: createContextRef(graph.project.projectId, "flow", lens.flow.id, graph.state.graphVersion),
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    kind: "flow",
    title: lens.flow.title,
    knowledgeClass: "derived",
    confidence: lens.confidence,
    flow: { ...lens.flow },
    technicalSummary: {
      text: `${lens.flow.title} is a bounded static ${lens.flow.entry?.kind === "package-script" ? "package-script" : lens.flow.entry?.kind === "framework-command" ? "framework-command" : lens.flow.entry?.kind === "scheduled-task" ? "scheduled-task" : lens.flow.entry?.kind === "http-request" ? "HTTP/request" : "entry"} projection with ${lens.steps.length} displayed technical step${lens.steps.length === 1 ? "" : "s"}.`,
      knowledgeClass: "derived",
      confidence: lens.confidence,
    },
    projection: {
      schemaVersion: lens.schemaVersion,
      id: lens.id,
      steps: lens.steps,
      staticBoundaries: lens.staticBoundaries,
      truncation: lens.truncation,
    },
    semanticSuggestion: lens.semanticSuggestion || null,
    agentSemanticProposal: lens.agentSemanticProposal || null,
    semanticFeedback: lens.semanticFeedback || null,
    flowInterface: lens.flowInterface || null,
    relatedTests: tests.items,
    truncation: { ...lens.truncation, relatedTests: tests.truncated },
    verification: lens.verification,
    humanVerification: lens.verification?.record ? {
      title: lens.verification.record.title,
      description: lens.verification.record.description,
      owner: lens.verification.record.owner,
      risk: lens.verification.record.risk,
      questions: lens.verification.record.questions,
      verifiedBy: lens.verification.record.verifiedBy,
      verifiedAt: lens.verification.record.verifiedAt,
      sourceGraphVersion: lens.verification.record.sourceGraphVersion,
      status: lens.verification.status,
      knowledgeClass: "human-verified",
    } : null,
    limitations,
    unresolvedQuestions: lens.unresolvedQuestions,
    safeActions: [
      { id: "inspect-flow", label: "Open the current Flow Lens", kind: "navigation" },
      { id: "inspect-step", label: "Inspect a step Context Card", kind: "navigation" },
      { id: "compare-adjacent", label: "Inspect a retained adjacent flow comparison", kind: "navigation" },
      { id: "inspect-impact", label: "Inspect static change impact", kind: "recommendation" },
    ],
  };
}

module.exports = {
  MAX_FLOW_CARD_TESTS,
  createFlowContextCard,
  relatedFlowTests,
};
