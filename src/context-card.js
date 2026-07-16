const CONTEXT_CARD_SCHEMA = "flowpeek-context/v1";
const CONTEXT_PACKET_SCHEMA = "flowpeek-context-packet/v1";

class ContextRefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContextRefError";
    this.code = code;
  }
}

function nodeSummary(node) {
  return { id: node.id, label: node.label, type: node.type, kind: node.kind, path: node.path || null };
}

function encodePart(value) {
  return encodeURIComponent(String(value));
}

function createContextRef(projectId, kind, contextId, graphVersion) {
  if (typeof projectId !== "string" || !projectId) throw new ContextRefError("invalid-project-id", "A Context Ref requires a non-empty project ID.");
  if (typeof kind !== "string" || !kind) throw new ContextRefError("invalid-kind", "A Context Ref requires a non-empty kind.");
  if (typeof contextId !== "string" || !contextId) throw new ContextRefError("invalid-context-id", "A Context Ref requires a non-empty context ID.");
  if (!Number.isSafeInteger(graphVersion) || graphVersion < 0) throw new ContextRefError("invalid-graph-version", "A Context Ref requires a non-negative graph version.");
  return `fp://local/${encodePart(projectId)}/${encodePart(kind)}/${encodePart(contextId)}@${graphVersion}`;
}

function parseContextRef(value) {
  if (typeof value !== "string" || !value.trim()) throw new ContextRefError("invalid-context-ref", "Context Ref must be a non-empty string.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ContextRefError("invalid-context-ref", "Context Ref is not a valid URI.");
  }
  if (url.protocol !== "fp:" || url.hostname !== "local") throw new ContextRefError("unsupported-context-ref", "Context Ref must use the fp://local scheme.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) throw new ContextRefError("invalid-context-ref", "Context Ref must contain project, kind, and context ID segments.");
  const versionAt = parts[2].lastIndexOf("@");
  if (versionAt <= 0) throw new ContextRefError("invalid-context-ref", "Context Ref must include @graphVersion after its context ID.");
  const graphVersion = Number(parts[2].slice(versionAt + 1));
  if (!Number.isSafeInteger(graphVersion) || graphVersion < 0) throw new ContextRefError("invalid-graph-version", "Context Ref graphVersion must be a non-negative integer.");
  try {
    return {
      projectId: decodeURIComponent(parts[0]),
      kind: decodeURIComponent(parts[1]),
      contextId: decodeURIComponent(parts[2].slice(0, versionAt)),
      graphVersion,
      contextRef: value,
    };
  } catch {
    throw new ContextRefError("invalid-context-ref", "Context Ref contains invalid percent-encoding.");
  }
}

function relationshipSummary(item, direction) {
  return {
    direction,
    type: item.type,
    confidence: item.confidence || "unknown",
    sourceId: item.source,
    targetId: item.target,
    node: nodeSummary(item.node),
    evidence: item.evidence || null,
  };
}

function relatedFlows(graph, nodeId, limit = 12) {
  const matches = (graph.flows || [])
    .filter((flow) => (flow.steps || []).some((step) => step.id === nodeId))
    .map((flow) => ({ id: flow.id, title: flow.title, entryId: flow.entryId, knowledgeClass: "derived", confidence: "exact" }));
  return { items: matches.slice(0, limit), truncated: matches.length > limit };
}

function limited(items, limit) {
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

function createNodeContextCard(graph, detail) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new ContextRefError("missing-graph-identity", "Context Cards require a project ID and graph version.");
  if (!detail?.node?.id) throw new ContextRefError("missing-node", "Context Cards require a graph node.");
  const node = detail.node;
  const incoming = limited(detail.incoming.map((item) => relationshipSummary(item, "incoming")), 24);
  const outgoing = limited(detail.outgoing.map((item) => relationshipSummary(item, "outgoing")), 24);
  const tests = limited(detail.relatedTests.map((item) => ({ edge: relationshipSummary(item, "related-test"), test: nodeSummary(item.node) })), 20);
  const flows = relatedFlows(graph, node.id);
  const hasManualDescription = typeof node.manualDescription === "string" && node.manualDescription.trim();
  const limitations = [
    "This card summarizes static parser evidence. It is not a runtime trace, source diff, or business-intent claim.",
    "Relationships are limited to Flowpeek's documented language and framework support.",
  ];
  if (!tests.items.length) limitations.push("No direct related test relationship was found; that does not prove behavioral coverage is absent.");
  if (hasManualDescription) limitations.push("The local human description has no attributed verifier or lifecycle record yet.");
  return {
    schemaVersion: CONTEXT_CARD_SCHEMA,
    contextRef: createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion),
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    kind: "node",
    title: node.label,
    knowledgeClass: "extracted",
    confidence: node.analysis?.confidence || "unknown",
    node: nodeSummary(node),
    responsibility: {
      text: node.detectedResponsibility || "Technical responsibility is not available.",
      knowledgeClass: "extracted",
      confidence: node.analysis?.confidence || "unknown",
    },
    sourceEvidence: {
      parser: node.analysis?.parser || "unknown",
      status: node.analysis?.status || "unknown",
      evidence: node.evidence || null,
    },
    incoming: incoming.items,
    outgoing: outgoing.items,
    relatedTests: tests.items,
    relatedFlows: flows.items,
    truncation: { incoming: incoming.truncated, outgoing: outgoing.truncated, relatedTests: tests.truncated, relatedFlows: flows.truncated },
    humanDescription: hasManualDescription ? {
      text: node.manualDescription,
      knowledgeClass: "human-authored",
      authorship: { status: "local-unattributed", author: null, graphVersion: graph.state.graphVersion },
      verification: null,
    } : null,
    verification: null,
    limitations,
    unresolvedQuestions: [],
    safeActions: [
      { id: "inspect", label: "Inspect raw parser evidence", kind: "navigation" },
      { id: "dependencies", label: "Inspect direct dependencies", kind: "navigation" },
      { id: "tests", label: "Inspect related tests", kind: "navigation" },
      { id: "impact", label: "Inspect static change impact", kind: "recommendation" },
    ],
  };
}

function markdownList(items, format) {
  return items.length ? items.map((item) => `- ${format(item)}`).join("\n") : "- None detected.";
}

function createNodeMarkdown(card) {
  return [
    `# ${card.title}`,
    "",
    `- Context Ref: \`${card.contextRef}\``,
    `- Graph: \`${card.project.projectId}\` v${card.project.graphVersion}`,
    `- Knowledge: ${card.knowledgeClass} (${card.confidence})`,
    "",
    "## Technical responsibility",
    "",
    card.responsibility.text,
    "",
    "## Source evidence",
    "",
    `- Parser: ${card.sourceEvidence.parser}`,
    `- Status: ${card.sourceEvidence.status}`,
    `- Path: ${card.node.path || "not available"}`,
    "",
    "## Direct relationships",
    "",
    markdownList(card.incoming, (item) => `Incoming ${item.type}: ${item.node.label} (\`${item.node.id}\`)`),
    markdownList(card.outgoing, (item) => `Outgoing ${item.type}: ${item.node.label} (\`${item.node.id}\`)`),
    "",
    "## Related tests",
    "",
    markdownList(card.relatedTests, (item) => `${item.test.label} (\`${item.test.path || item.test.id}\`)`),
    "",
    "## Limitations",
    "",
    markdownList(card.limitations, (item) => item),
  ].join("\n");
}

function createFlowMarkdown(card) {
  return [
    `# ${card.title}`,
    "",
    `- Context Ref: \`${card.contextRef}\``,
    `- Graph: \`${card.project.projectId}\` v${card.project.graphVersion}`,
    `- Knowledge: ${card.knowledgeClass} (${card.confidence})`,
    `- Entry: \`${card.flow.entryId}\``,
    "",
    "## Technical summary",
    "",
    card.technicalSummary.text,
    "",
    "## Displayed static steps",
    "",
    markdownList(card.projection.steps, (step) => `${step.index}. ${step.node.label} — ${step.role} (\`${step.id}\`)`),
    "",
    "## Projection bounds",
    "",
    `- Requested maximum steps: ${card.projection.truncation.requestedMaxSteps}`,
    `- Displayed/source steps: ${card.projection.truncation.displayedSteps}/${card.projection.truncation.sourceFlowSteps}`,
    `- Display truncated: ${card.projection.truncation.displayTruncated ? `yes (${card.projection.truncation.displayTruncationReason})` : "no"}`,
    `- Source traversal may be truncated: ${card.projection.truncation.sourceTraversalMayBeTruncated ? `yes (${card.projection.truncation.sourceTraversalTruncationReason})` : "no"}`,
    "",
    "## Static boundaries",
    "",
    markdownList(card.projection.staticBoundaries, (boundary) => `${boundary.category}: ${boundary.node.label} (\`${boundary.node.id}\`)`),
    "",
    "## Related tests",
    "",
    markdownList(card.relatedTests, (item) => `${item.test.label} (\`${item.test.path || item.test.id}\`)`),
    "",
    "## Deterministic semantic suggestion",
    "",
    card.semanticSuggestion?.status === "suggested"
      ? [
        `- Candidate title: ${card.semanticSuggestion.candidate.title}`,
        `- Technical purpose: ${card.semanticSuggestion.candidate.technicalPurpose}`,
        `- Role: ${card.semanticSuggestion.candidate.role}`,
        `- Grouping: ${card.semanticSuggestion.candidate.grouping.label}`,
        `- Confidence: ${card.semanticSuggestion.confidence.level} (${card.semanticSuggestion.confidence.score})`,
        "- Knowledge class: derived-suggestion; human review is required.",
      ].join("\n")
      : `- Abstained: ${card.semanticSuggestion?.abstention?.reason || "No semantic suggestion is available."}`,
    "",
    "## Semantic suggestion feedback",
    "",
    card.semanticFeedback?.record
      ? [
        `- Status: ${card.semanticFeedback.status}`,
        `- Decision: ${card.semanticFeedback.record.decision}`,
        `- Reviewed by: ${card.semanticFeedback.record.reviewedBy}`,
        `- Reviewed at: ${card.semanticFeedback.record.createdAt}`,
        `- Trace linked: ${card.semanticFeedback.record.traceLink ? card.semanticFeedback.record.traceLink.operationId : "No"}`,
        "- This is feedback on derived guidance, not human flow verification.",
      ].join("\n")
      : `- ${card.semanticFeedback?.reason || "No semantic suggestion feedback exists."}`,
    "",
    "## Human verification",
    "",
    card.humanVerification
      ? [
        `- Status: ${card.humanVerification.status}`,
        `- Verified title: ${card.humanVerification.title}`,
        `- Verified by: ${card.humanVerification.verifiedBy}`,
        `- Verified at: ${card.humanVerification.verifiedAt}`,
        `- Source graph version: ${card.humanVerification.sourceGraphVersion}`,
        `- Owner: ${card.humanVerification.owner || "Not recorded"}`,
        `- Risk: ${card.humanVerification.risk}`,
        "",
        card.humanVerification.description,
      ].join("\n")
      : `- ${card.verification?.reason || "No flow-level human verification record exists."}`,
    "",
    "## Limitations",
    "",
    markdownList(card.limitations, (item) => item),
  ].join("\n");
}

function createContextPacket(card, format = "json") {
  if (format === "json") return { schemaVersion: CONTEXT_PACKET_SCHEMA, format: "json", card };
  if (format !== "markdown") throw new ContextRefError("unsupported-packet-format", "Context Packet format must be json or markdown.");
  if (!["node", "flow"].includes(card.kind)) throw new ContextRefError("unsupported-context-kind", `Context Packet kind '${card.kind}' is not supported.`);
  const markdown = card.kind === "flow" ? createFlowMarkdown(card) : createNodeMarkdown(card);
  return { schemaVersion: CONTEXT_PACKET_SCHEMA, format: "markdown", contextRef: card.contextRef, markdown };
}

function successorCandidates(graph, removedNode, delta) {
  if (!removedNode || !delta?.nodes?.added) return [];
  const addedIds = new Set(delta.nodes.added.map((node) => node.id));
  return graph.nodes
    .filter((node) => addedIds.has(node.id) && node.path === removedNode.path && node.kind === removedNode.kind && node.type === removedNode.type)
    .map((node) => ({ node: nodeSummary(node), confidence: "likely-static", reason: "The node was added in the same adjacent delta with the same source path, kind, and type." }));
}

function resolveNodeContextRef(graph, parsed, options, value) {
  const currentVersion = graph.state.graphVersion;
  const node = graph.nodes.find((candidate) => candidate.id === parsed.contextId);
  const detail = node ? options.getNodeDetails?.(graph, node.id) : null;
  const currentRef = node ? createContextRef(graph.project.projectId, "node", node.id, currentVersion) : null;
  if (node && parsed.graphVersion === currentVersion) return { status: "current", requestedRef: value, resolvedRef: currentRef, card: createNodeContextCard(graph, detail), successorCandidates: [] };
  if (node) {
    const delta = parsed.graphVersion + 1 === currentVersion ? options.readDelta?.(parsed.graphVersion, currentVersion) || null : null;
    return { status: "stale", requestedRef: value, resolvedRef: currentRef, card: createNodeContextCard(graph, detail), delta, successorCandidates: [], reason: "The node still exists, but the requested graph version is older than the current graph." };
  }
  const delta = options.readDelta?.(parsed.graphVersion, parsed.graphVersion + 1) || null;
  const removed = delta?.nodes?.removed?.find((candidate) => candidate.id === parsed.contextId) || null;
  const candidates = successorCandidates(graph, removed, delta);
  if (candidates.length) return { status: "successor-candidate", requestedRef: value, resolvedRef: null, card: null, successorCandidates: candidates, delta, reason: "The original node is absent. Candidate successors require human confirmation and are not automatically resolved." };
  if (removed) return { status: "historical", requestedRef: value, resolvedRef: null, card: null, successorCandidates: [], delta, historicalNode: removed, reason: "The node was removed in a retained adjacent delta. Its original full card is not retained." };
  return { status: "unresolved", requestedRef: value, resolvedRef: null, card: null, successorCandidates: [], reason: "The node is not present and no retained adjacent delta can establish its history.", code: "node-not-found" };
}

function resolveFlowContextRef(graph, parsed, options, value) {
  const currentVersion = graph.state.graphVersion;
  const card = options.getFlowContextCard?.(graph, parsed.contextId) || null;
  const currentRef = card ? createContextRef(graph.project.projectId, "flow", card.flow.id, currentVersion) : null;
  if (card && parsed.graphVersion === currentVersion) return { status: "current", requestedRef: value, resolvedRef: currentRef, card, successorCandidates: [] };
  if (card) {
    const delta = parsed.graphVersion + 1 === currentVersion ? options.readDelta?.(parsed.graphVersion, currentVersion) || null : null;
    return { status: "stale", requestedRef: value, resolvedRef: currentRef, card, delta, successorCandidates: [], reason: "The flow still exists, but the requested graph version is older than the current graph." };
  }
  const delta = options.readDelta?.(parsed.graphVersion, parsed.graphVersion + 1) || null;
  const removed = delta?.flows?.removed?.find((candidate) => candidate.id === parsed.contextId) || null;
  const comparison = delta?.flowComparisons?.items?.find((candidate) => candidate.flow.id === parsed.contextId) || null;
  if (removed || (comparison?.before && !comparison.current)) {
    return {
      status: "historical",
      requestedRef: value,
      resolvedRef: null,
      card: null,
      successorCandidates: [],
      delta,
      historicalFlow: removed || comparison.flow,
      historicalFlowLensSnapshot: comparison?.before || null,
      reason: "The flow was removed in a retained adjacent delta. Its bounded Flow Lens snapshot is returned when captured; a full historical Context Card is not reconstructed.",
    };
  }
  return { status: "unresolved", requestedRef: value, resolvedRef: null, card: null, successorCandidates: [], reason: "The flow is not present and no retained adjacent delta can establish its history.", code: "flow-not-found" };
}

function resolveContextRef(graph, value, options = {}) {
  let parsed;
  try {
    parsed = parseContextRef(value);
  } catch (error) {
    return { status: "unresolved", requestedRef: value, reason: error.message, code: error.code || "invalid-context-ref", card: null, successorCandidates: [] };
  }
  const currentVersion = graph?.state?.graphVersion;
  if (!graph?.project?.projectId || !Number.isSafeInteger(currentVersion)) return { status: "unresolved", requestedRef: value, reason: "Current graph identity is unavailable.", code: "missing-graph-identity", card: null, successorCandidates: [] };
  if (parsed.projectId !== graph.project.projectId) return { status: "unresolved", requestedRef: value, reason: "Context Ref belongs to a different Flowpeek project.", code: "wrong-project-id", card: null, successorCandidates: [] };
  if (!["node", "flow"].includes(parsed.kind)) return { status: "unresolved", requestedRef: value, reason: `Context kind '${parsed.kind}' is not implemented.`, code: "unsupported-context-kind", card: null, successorCandidates: [] };
  if (parsed.graphVersion > currentVersion) return { status: "unresolved", requestedRef: value, reason: "Context Ref targets a graph version newer than the local graph.", code: "future-graph-version", card: null, successorCandidates: [] };
  return parsed.kind === "flow"
    ? resolveFlowContextRef(graph, parsed, options, value)
    : resolveNodeContextRef(graph, parsed, options, value);
}

module.exports = {
  CONTEXT_CARD_SCHEMA,
  CONTEXT_PACKET_SCHEMA,
  ContextRefError,
  createContextPacket,
  createContextRef,
  createNodeContextCard,
  parseContextRef,
  resolveContextRef,
};
