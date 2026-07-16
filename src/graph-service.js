const VALID_MODES = new Set(["overview", "requests", "dependencies"]);
const VALID_SCOPES = new Set(["application", "runtime", "framework", "devtool", "all"]);
const MAX_AGENT_SEMANTIC_SUGGESTIONS = 12;
const { createContextPacket, createContextRef, createNodeContextCard, parseContextRef, resolveContextRef: resolveStoredContextRef } = require("./context-card");
const { getOrCreateArtifact, listArtifactCacheAudit } = require("./artifact-cache");
const { DURABLE_BRIEF_SCHEMA, createDurableBriefPacket, listDurableBriefManifests: listStoredDurableBriefManifests, materializeDurableBrief: materializeStoredDurableBrief, resolveDurableBriefRef } = require("./durable-brief");
const { createHandoffContext: buildHandoffContext } = require("./handoff-context");
const { evaluateHandoffQuality } = require("./handoff-quality");
const { HANDOFF_WORKSPACE_SCHEMA, exportHandoffWorkspace: buildHandoffExport, importHandoffWorkspace: importStoredHandoffWorkspace, listHandoffNotes: listStoredHandoffNotes, listHandoffWorkspaces: listStoredHandoffWorkspaces, listImportedHandoffs: listStoredImportedHandoffs, saveHandoffNote: saveStoredHandoffNote, saveHandoffWorkspace: saveStoredHandoffWorkspace } = require("./handoff-workspace");
const { projectHome: buildProjectHome } = require("./project-home");
const { listRuntimeEvidence: listStoredRuntimeEvidence, runtimeEvidenceSummary, saveRuntimeEvidence: saveStoredRuntimeEvidence } = require("./runtime-evidence");
const { flowComparisonResult } = require("./flow-comparison");
const { createFlowContextCard } = require("./flow-context-card");
const { getFlowProjection: buildFlowProjection } = require("./flow-lens");
const { DEFAULT_FLOW_LENS_MAX_STEPS, validateFlowLensMaxSteps } = require("./flow-lens-options");
const { readGraphDelta } = require("./graph-state");
const { FlowVerificationError, getFlowVerificationHistory, resolveDetachedFlowVerification, resolveFlowVerification, saveFlowVerification } = require("./flow-verification");
const { createSemanticFlowSuggestion, semanticSuggestionPolicy } = require("./semantic-flow-suggestion");
const { agentEvidenceTracePolicy, listAgentEvidenceTraces: listStoredAgentEvidenceTraces, saveAgentEvidenceTrace } = require("./agent-evidence-trace");
const { listSemanticSuggestionFeedback: listStoredSemanticSuggestionFeedback, resolveSemanticSuggestionFeedback, saveSemanticSuggestionFeedback, semanticSuggestionFeedbackPolicy } = require("./semantic-suggestion-feedback");
const { resolveAgentSemanticProposal, saveAgentSemanticProposal } = require("./agent-semantic-proposal");
const { createFlowInterface } = require("./flow-interface");
const { listTestRuns: listStoredTestRuns, saveTestRunEvent } = require("./test-run-journal");
const { TRUST_ANALYTICS_SCHEMA, buildTrustAnalytics } = require("./trust-analytics");
const { PRODUCT_PROOF_SCHEMA, createProductProof } = require("./product-proof");
const { createAgentBootstrap } = require("./agent-bootstrap");

function optionValue(options, key, fallback = null) {
  if (options && typeof options.get === "function") return options.get(key) || fallback;
  return options?.[key] ?? fallback;
}

function scopeLayers(scope) {
  if (scope === "all") return new Set(["application", "runtime", "framework", "devtool", "package", "test", "fixture", "generated"]);
  if (scope === "runtime") return new Set(["application", "runtime"]);
  if (scope === "framework") return new Set(["application", "framework"]);
  if (scope === "devtool") return new Set(["application", "devtool"]);
  return new Set(["application"]);
}

function isVisibleInScope(node, scope) {
  return scopeLayers(scope).has(node.layer);
}

function capitalise(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function humanizeSegment(value) {
  if (value === "api") return "API";
  return value.split("-").map(capitalise).join(" ");
}

function featureKey(node) {
  if (node.feature) return node.feature;
  if (node.kind === "external") return `${node.layer}/${node.label.toLowerCase()}`;
  return node.domain || "project";
}

function featureLabel(key) {
  const overviewLabels = {
    "overview/http-api": "HTTP API",
    "overview/ui": "UI Components",
    "overview/pages": "Application Pages",
    "overview/library": "Shared Library",
    "overview/data": "Data Layer",
    "overview/server-actions": "Server Actions",
    "overview/hooks": "Hooks",
    "overview/types": "Types",
    "overview/project": "Application Core",
  };
  if (overviewLabels[key]) return overviewLabels[key];
  return key.split("/").map(humanizeSegment).join(" · ");
}

function overviewFeatureKey(node) {
  const primary = featureKey(node).split("/")[0];
  if (primary === "api") return "overview/http-api";
  if (primary === "ui") return "overview/ui";
  if (primary === "pages") return "overview/pages";
  if (primary === "library") return "overview/library";
  if (primary === "data") return "overview/data";
  if (primary === "server-actions") return "overview/server-actions";
  if (primary === "hooks") return "overview/hooks";
  if (primary === "types") return "overview/types";
  return "overview/project";
}

function memberSummary(node) {
  return { id: node.id, label: node.label, type: node.type, kind: node.kind, path: node.path };
}

function summaryType(members, key) {
  if (members.some((node) => node.kind === "endpoint")) return "endpoint";
  if (key.startsWith("data")) return "database";
  if (key.startsWith("runtime")) return "external";
  if (members.some((node) => node.type === "service")) return "service";
  if (members.some((node) => node.type === "repository")) return "repository";
  return "feature";
}

function aggregateProjection(graph, sourceNodes, mode, scope, keyForNode = featureKey) {
  const groupMap = new Map();
  for (const node of sourceNodes) {
    const key = keyForNode(node);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(node);
  }
  const memberToSummary = new Map();
  const nodes = [...groupMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, members]) => {
    const id = `feature:${key}`;
    members.forEach((member) => memberToSummary.set(member.id, id));
    const types = [...new Set(members.map((member) => member.type))].sort();
    const typeCounts = Object.fromEntries(types.map((type) => [type, members.filter((member) => member.type === type).length]));
    return {
      id,
      kind: "summary",
      type: summaryType(members, key),
      label: featureLabel(key),
      feature: key,
      layer: "projection",
      memberCount: members.length,
      members: members.slice(0, 12).map(memberSummary),
      memberIds: members.map((member) => member.id),
      typeCounts,
      detectedResponsibility: `Feature summary of ${members.length} source node${members.length === 1 ? "" : "s"}.`,
      analysis: { parser: "flowpeek-projection", status: "aggregate", confidence: "derived" },
    };
  });
  const edgeMap = new Map();
  for (const edge of graph.edges) {
    const source = memberToSummary.get(edge.source);
    const target = memberToSummary.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = `${source}|${target}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { source, target, typeCounts: new Map(), sourceEdgeCount: 0 });
    const aggregate = edgeMap.get(key);
    aggregate.sourceEdgeCount += 1;
    aggregate.typeCounts.set(edge.type, (aggregate.typeCounts.get(edge.type) || 0) + 1);
  }
  const edges = [...edgeMap.values()].map((edge) => {
    const types = [...edge.typeCounts.keys()].sort();
    return {
      id: `${edge.source}|${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: types.length === 1 ? types[0] : "mixed",
      types,
      count: edge.sourceEdgeCount,
      label: `${edge.sourceEdgeCount} ${edge.sourceEdgeCount === 1 ? "relationship" : "relationships"}`,
      confidence: "derived",
      evidence: { kind: "aggregate", sourceEdgeCount: edge.sourceEdgeCount },
    };
  });
  return { nodes, edges, sourceNodeCount: sourceNodes.length, mode, scope };
}

function requestSourceNodes(graph, scope) {
  const visible = graph.nodes.filter((node) => isVisibleInScope(node, scope) && node.type !== "test");
  const visibleIds = new Set(visible.map((node) => node.id));
  const included = new Set(visible.filter((node) => node.kind === "endpoint").map((node) => node.id));
  for (const edge of graph.edges) {
    if (edge.type === "handles" && included.has(edge.source) && visibleIds.has(edge.target)) included.add(edge.target);
    if (edge.type === "requests" && included.has(edge.target) && visibleIds.has(edge.source)) included.add(edge.source);
  }
  for (const edge of graph.edges) {
    if (included.has(edge.source) && ["imports", "uses", "contains", "calls"].includes(edge.type) && visibleIds.has(edge.target)) included.add(edge.target);
  }
  return visible.filter((node) => included.has(node.id));
}

function dependencyProjection(graph, scope, focusId) {
  const visible = graph.nodes.filter((node) => isVisibleInScope(node, scope));
  const visibleIds = new Set(visible.map((node) => node.id));
  const focus = visible.find((node) => node.id === focusId);
  if (!focus) return { nodes: [], edges: [], sourceNodeCount: 0, emptyState: "Search for a file, endpoint, or service, then select it to inspect direct dependencies." };
  const relatedEdges = graph.edges.filter((edge) => (edge.source === focus.id || edge.target === focus.id) && visibleIds.has(edge.source) && visibleIds.has(edge.target)).slice(0, 36);
  const included = new Set([focus.id]);
  relatedEdges.forEach((edge) => { included.add(edge.source); included.add(edge.target); });
  return {
    nodes: visible.filter((node) => included.has(node.id)),
    edges: relatedEdges,
    sourceNodeCount: included.size,
    focusId: focus.id,
  };
}

function createAgentContext(graph, projection, mode, scope, focusId) {
  const derivedCache = listArtifactCacheAudit(graph.project.root, graph);
  const derivedCacheEvents = (derivedCache.events || []).slice(0, 10);
  const derivedCacheEventTotal = derivedCache.eventCatalog?.total || derivedCacheEvents.length;
  const projectionMeaning = mode === "overview"
    ? "Each visible node is a feature summary that aggregates source nodes. It is not a source file, runtime service, or execution step."
    : mode === "requests"
      ? "Each visible node is a feature summary. Edges aggregate detected HTTP handler, static fetch, import, or usage facts; they do not prove end-to-end runtime execution."
      : "Each visible node is an original graph node. Edges are direct parser facts for the selected node's neighborhood.";
  return {
    schemaVersion: "flowpeek-agent-context/v1",
    mode,
    scope,
    focusId: focusId || null,
    projection: {
      meaning: projectionMeaning,
      visibleNodes: projection.nodes.length,
      visibleEdges: projection.edges.length,
      sourceNodesRepresented: projection.sourceNodeCount,
      aggregation: mode !== "dependencies",
    },
    evidencePolicy: {
      codeInterpretation: graph.analysis.codeInterpretation,
      unparsedPolicy: graph.analysis.unparsedPolicy,
      rawFacts: "Raw AST relationships use their stored parser, source range, and confidence. Aggregate feature edges are labelled derived.",
    },
    interpretationRules: [
      "Do not treat a feature summary as a source file, service boundary, or runtime call trace.",
      "Do not infer business intent or runtime order from import relationships.",
      "Use get_request_flows followed by get_flow_projection for a bounded static HTTP/request explanation; inspect a step Context Card before changing code.",
      "Use get_flow_context_card to copy or hand off one versioned bounded flow context; resolve its Context Ref before reusing it after a graph refresh.",
      "Flow Lens roles, boundaries, branches, and truncation are derived static metadata, not runtime control flow or side-effect proof.",
      "Semantic flow suggestions are deterministic derived candidates with evidence and abstention; they never constitute or create human verification.",
      "Semantic suggestion feedback is immutable local human labeling. It can accept, edit, reject, or confirm abstention, but it never creates human verification or model-quality proof by itself.",
      "Use record_agent_evidence_trace after an agent action to append its Context Ref, declared action, changed paths, and verification result. This is audit metadata, not private reasoning or human verification.",
      "After refresh_graph advances the graph version, use get_changed_contexts with the adjacent versions before relying on an earlier Flow Lens or Context Card. Its affected statuses are bounded static delta evidence; historical items do not reconstruct a full Context Card.",
      "Use get_flow_comparison only for a flow captured in the retained adjacent delta. Its before/current sides are bounded static snapshots, not reconstructed runtime history.",
      "Use a raw node tool before proposing a code change.",
      "Files marked inventory-only have no inferred dependencies or flows.",
    ],
    adapterCapabilities: graph.analysis.adapterCapabilities,
    capabilities: graph.analysis.capabilities,
    calls: graph.analysis.calls,
    resolution: graph.analysis.resolution,
    coverage: graph.analysis.coverage,
    repositoryScope: graph.analysis.repositoryScope,
    project: graph.project,
    graphState: graph.state,
    latestDelta: graph.analysis.latestDelta || null,
    cache: graph.analysis.cache,
    cacheState: graph.analysis.cacheState || null,
    durableBriefs: {
      schemaVersion: DURABLE_BRIEF_SCHEMA,
      kinds: ["project", "feature", "flow", "node"],
      evidenceClasses: ["static-parser-fact", "deterministic-inference", "human-authored", "human-verified", "runtime-evidence"],
      derivedEvidenceCeiling: "deterministic-inference",
      freshnessFields: ["projectIdentity", "sourceBasis", "graphVersion", "evidenceClass", "freshnessStatus"],
      compositionSurface: "get_handoff_context",
    },
    handoffWorkspace: {
      schemaVersion: HANDOFF_WORKSPACE_SCHEMA,
      compositionSurface: "get_handoff_context",
      localVersioning: "immutable-supersession",
      humanNotes: "append-only-attributed-supersession",
      portableFormats: ["json", "markdown"],
      foreignImport: { access: "read-only", trust: "foreign-unverified", automaticAdoption: false },
    },
    runtimeEvidence: runtimeEvidenceSummary(graph.project.root, graph),
    derivedCache: {
      schemaVersion: derivedCache.schemaVersion,
      status: derivedCache.status,
      graphVersion: derivedCache.graphVersion || graph.state.graphVersion,
      sourceBasis: derivedCache.sourceBasis || null,
      counts: derivedCache.counts || { hits: 0, misses: 0, invalidated: 0, retainedUnaffected: 0 },
      totalArtifacts: derivedCache.totalArtifacts || 0,
      latestEvents: derivedCacheEvents,
      eventCatalog: {
        total: derivedCacheEventTotal,
        returned: derivedCacheEvents.length,
        omitted: Math.max(derivedCacheEventTotal - derivedCacheEvents.length, 0),
        truncated: derivedCacheEventTotal > derivedCacheEvents.length,
        warning: derivedCacheEventTotal > derivedCacheEvents.length ? "Only the ten newest cache events are included in agent context; use /api/cache-artifacts for the bounded retained audit." : null,
      },
      policy: derivedCache.policy || { staleReuse: "never-silent" },
    },
    semanticSuggestions: semanticSuggestionsForGraph(graph, scope),
    semanticSuggestionFeedback: semanticSuggestionFeedbackPolicy(graph.project.root, graph),
    agentEvidenceTrace: agentEvidenceTracePolicy(graph.project.root, graph),
    trustAnalytics: {
      schemaVersion: TRUST_ANALYTICS_SCHEMA,
      httpEndpoint: "/api/trust-analytics",
      mcpTool: "get_trust_analytics",
      purpose: "Inspect evidence availability, provenance, and freshness without collapsing unlike evidence classes into a truth score.",
      compositeScore: false,
    },
    productProof: {
      schemaVersion: PRODUCT_PROOF_SCHEMA,
      httpEndpoint: "/api/product-proof",
      mcpTool: "get_product_proof",
      purpose: "Inspect bounded public benchmark evidence, current-repository facts, feature proof surfaces, reproduction commands, and claim boundaries.",
    },
  };
}

function getAgentBootstrap(graph) {
  return createAgentBootstrap(graph);
}

function semanticSuggestionsForGraph(graph, scope = "application") {
  const policy = semanticSuggestionPolicy();
  const availableFlows = scope === "all" ? graph.diagnosticFlows || graph.flows || [] : graph.flows || [];
  const flows = availableFlows.slice(0, MAX_AGENT_SEMANTIC_SUGGESTIONS);
  const items = flows.map((flow) => createSemanticFlowSuggestion(graph, buildFlowProjection(graph, flow.id, scope)));
  return {
    ...policy,
    totalDetectedFlows: availableFlows.length,
    returnedSuggestions: items.length,
    omittedFlowIds: availableFlows.slice(flows.length).map((flow) => flow.id),
    suggested: items.filter((item) => item.status === "suggested").length,
    abstained: items.filter((item) => item.status === "abstained").length,
    truncated: availableFlows.length > items.length,
    warning: availableFlows.length > items.length ? `${availableFlows.length - items.length} detected flow suggestion(s) are omitted from this bounded agent-context sample.` : null,
    items,
  };
}

function flowCatalog(availableFlows, returnedFlows = availableFlows) {
  const returnedIds = new Set(returnedFlows.map((flow) => flow.id));
  const omittedFlowIds = availableFlows.filter((flow) => !returnedIds.has(flow.id)).map((flow) => flow.id);
  return {
    total: availableFlows.length,
    returned: returnedFlows.length,
    omittedFlowIds,
    truncated: omittedFlowIds.length > 0,
    warning: omittedFlowIds.length ? `${omittedFlowIds.length} detected Flow Lens item(s) are not included in this response.` : null,
  };
}

function projectView(graph, options = {}) {
  const requestedMode = optionValue(options, "mode", "overview");
  const mode = VALID_MODES.has(requestedMode) ? requestedMode : "overview";
  const requestedScope = optionValue(options, "scope", "application");
  const scope = VALID_SCOPES.has(requestedScope) ? requestedScope : "application";
  const focusId = optionValue(options, "focus", null);
  let projection;
  if (mode === "dependencies") projection = dependencyProjection(graph, scope, focusId);
  else projection = getOrCreateArtifact(graph.project.root, graph, "feature-summary", { mode, scope }, () => mode === "requests"
    ? aggregateProjection(graph, requestSourceNodes(graph, scope), mode, scope, overviewFeatureKey)
    : aggregateProjection(graph, graph.nodes.filter((node) => isVisibleInScope(node, scope)), mode, scope, overviewFeatureKey), { dependencyPaths: ["*"] }).value;
  const aiContext = createAgentContext(graph, projection, mode, scope, focusId);
  const availableFlows = scope === "all" ? graph.diagnosticFlows || graph.flows : graph.flows;
  // Flow discovery is uncapped. If pagination is introduced later, this catalog
  // keeps the omission contract visible and deterministic.
  const flows = availableFlows;
  return {
    generatedAt: graph.generatedAt,
    project: graph.project,
    stats: graph.stats,
    nodes: projection.nodes,
    edges: projection.edges,
    flows,
    flowCatalog: flowCatalog(availableFlows, flows),
    view: { mode, scope, focusId, sourceNodeCount: projection.sourceNodeCount, emptyState: projection.emptyState || null },
    aiContext,
  };
}

function findNodes(graph, options = {}) {
  const text = String(optionValue(options, "q", optionValue(options, "query", ""))).trim().toLowerCase();
  if (!text) return { query: "", results: [] };
  const requestedScope = optionValue(options, "scope", "application");
  const scope = VALID_SCOPES.has(requestedScope) ? requestedScope : "application";
  const typeRank = { endpoint: 0, route: 1, controller: 2, service: 3, class: 4, function: 5, repository: 6, database: 7, queue: 8, module: 9 };
  const results = graph.nodes
    .filter((node) => isVisibleInScope(node, scope))
    .filter((node) => [node.label, node.path, node.feature, node.domain, node.type].filter(Boolean).join(" ").toLowerCase().includes(text))
    .sort((left, right) => (typeRank[left.type] ?? 99) - (typeRank[right.type] ?? 99) || left.label.localeCompare(right.label))
    .slice(0, 12)
    .map(memberSummary);
  return { query: text, scope, results };
}

function getNodeDetails(graph, id) {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) return null;
  const byId = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const detailFor = (edge, nodeId) => ({ ...edge, node: byId.get(nodeId) });
  const incoming = graph.edges.filter((edge) => edge.target === node.id).map((edge) => detailFor(edge, edge.source)).filter((item) => item.node);
  const outgoing = graph.edges.filter((edge) => edge.source === node.id).map((edge) => detailFor(edge, edge.target)).filter((item) => item.node);
  return {
    node,
    incoming,
    outgoing,
    relatedTests: [...incoming, ...outgoing].filter((item) => item.node.type === "test"),
    agentEvidenceTraces: listStoredAgentEvidenceTraces(graph.project.root, graph, { contextId: node.id, limit: 10 }),
  };
}

function getContextCard(graph, id, format = "json") {
  const detail = getNodeDetails(graph, id);
  if (!detail) return null;
  const card = createNodeContextCard(graph, detail);
  return createContextPacket(card, format);
}

function attachFlowVerification(graph, lens) {
  if (!lens) return null;
  const semanticSuggestion = createSemanticFlowSuggestion(graph, lens);
  const semanticFeedback = resolveSemanticSuggestionFeedback(graph.project.root, graph, semanticSuggestion);
  const agentSemanticProposal = resolveAgentSemanticProposal(graph.project.root, graph, lens);
  const agentEvidenceTraces = listStoredAgentEvidenceTraces(graph.project.root, graph, { contextId: lens.flow.id, limit: 10 });
  const verification = resolveFlowVerification(graph.project.root, graph, lens, {
    readDelta: (fromVersion, toVersion) => readGraphDelta(graph.project.root, fromVersion, toVersion),
  });
  const flowInterface = createFlowInterface(graph, lens);
  const testRuns = listStoredTestRuns(graph.project.root, graph, { flowId: lens.flow.id, limit: 5 });
  const questions = verification.record?.questions || [];
  return {
    ...lens,
    semanticSuggestion,
    semanticFeedback,
    agentSemanticProposal,
    agentEvidenceTraces,
    verification,
    flowInterface,
    testRuns,
    unresolvedQuestions: questions.length ? questions : verification.status === "unverified"
      ? ["No flow-level human verification record exists."]
      : [],
  };
}

function buildFlowContextCard(graph, flowId, scope = "application", options = {}) {
  const lens = getFlowProjection(graph, flowId, scope, options);
  return lens ? createFlowContextCard(graph, lens) : null;
}

function getFlowContextCard(graph, flowId, format = "json", scope = "application", options = {}) {
  const card = buildFlowContextCard(graph, flowId, scope, options);
  return card ? createContextPacket(card, format) : null;
}

function resolveContextRef(graph, contextRef) {
  try {
    if (parseContextRef(contextRef).kind === "brief") return resolveDurableBriefRef(graph.project.root, graph, contextRef);
  } catch {}
  return resolveStoredContextRef(graph, contextRef, {
    getNodeDetails,
    getFlowContextCard: (current, flowId) => buildFlowContextCard(current, flowId, "all"),
    readDelta: (fromVersion, toVersion) => readGraphDelta(graph.project.root, fromVersion, toVersion),
  });
}

function getDurableBrief(graph, kind, id = null, format = "json") {
  return createDurableBriefPacket(graph, kind, id, format);
}

function materializeDurableBrief(graph, kind, id = null) {
  return materializeStoredDurableBrief(graph.project.root, graph, kind, id);
}

function listDurableBriefManifests(graph, options = {}) {
  return listStoredDurableBriefManifests(graph.project.root, graph, options);
}

function getHandoffContext(graph, input = {}) {
  const workspaceId = listStoredHandoffWorkspaces(graph.project.root, graph).current?.id || null;
  return getOrCreateArtifact(graph.project.root, graph, "context-packet", { input, workspaceId }, () => buildHandoffContext(graph, input), { dependencyPaths: ["*"] }).value;
}

function getArtifactCacheAudit(graph) {
  return listArtifactCacheAudit(graph.project.root, graph);
}

function getProjectHome(graph, options = {}) {
  return buildProjectHome(graph, { ...options, reviewImpact: getReviewImpact(graph) });
}

function getHandoffQuality(graph, input = {}) {
  return evaluateHandoffQuality(graph, input, { resolveContextRef });
}

function getRuntimeEvidence(graph, options = {}) {
  return listStoredRuntimeEvidence(graph.project.root, graph, options);
}

function getTrustAnalytics(graph) {
  return buildTrustAnalytics(graph, {
    artifactCache: listArtifactCacheAudit(graph.project.root, graph),
    runtimeEvidence: runtimeEvidenceSummary(graph.project.root, graph),
    reviewImpact: getReviewImpact(graph),
    semanticFeedback: listStoredSemanticSuggestionFeedback(graph.project.root, graph, { limit: 100 }),
    agentEvidenceTraces: listStoredAgentEvidenceTraces(graph.project.root, graph, { limit: 100 }),
    testRuns: listStoredTestRuns(graph.project.root, graph, { limit: 100 }),
  });
}

function getProductProof(graph, options = {}) {
  return createProductProof(graph, options);
}

function recordRuntimeEvidence(graph, input = {}) {
  return saveStoredRuntimeEvidence(graph.project.root, graph, input);
}

function getHandoffWorkspace(graph, workspaceId = null) {
  const listed = listStoredHandoffWorkspaces(graph.project.root, graph);
  if (listed.status !== "available") return { schemaVersion: "flowpeek-handoff-workspace-view/v1", status: "unavailable", workspace: null, notes: [], diagnostics: listed.diagnostics };
  const workspace = workspaceId ? listed.records.find((record) => record.id === workspaceId) : listed.current;
  if (!workspace) return { schemaVersion: "flowpeek-handoff-workspace-view/v1", status: "missing", workspace: null, notes: [], diagnostics: [] };
  const notes = listStoredHandoffNotes(graph.project.root, graph, workspace.id);
  return { schemaVersion: "flowpeek-handoff-workspace-view/v1", status: "available", workspace, notes: notes.records, diagnostics: notes.diagnostics };
}

function listHandoffWorkspaces(graph) {
  return listStoredHandoffWorkspaces(graph.project.root, graph);
}

function saveHandoffWorkspace(graph, input) {
  return saveStoredHandoffWorkspace(graph.project.root, graph, input);
}

function saveHandoffNote(graph, input) {
  return saveStoredHandoffNote(graph.project.root, graph, input);
}

function exportHandoffWorkspace(graph, options = {}) {
  return buildHandoffExport(graph.project.root, graph, options);
}

function importHandoffWorkspace(graph, input) {
  return importStoredHandoffWorkspace(graph.project.root, graph, input);
}

function listImportedHandoffs(graph) {
  return listStoredImportedHandoffs(graph.project.root, graph);
}

function getRelatedTests(graph, id) {
  const detail = getNodeDetails(graph, id);
  if (!detail) return null;
  return {
    id,
    node: memberSummary(detail.node),
    relatedTests: detail.relatedTests.map((item) => ({ edge: { id: item.id, type: item.type, confidence: item.confidence, evidence: item.evidence }, test: memberSummary(item.node) })),
    limitation: "Only direct parser relationships to test files are reported. Absence does not prove that no behavioral test exists.",
  };
}

function getRequestFlows(graph, endpoint = "", scope = "application") {
  const query = endpoint.trim().toLowerCase();
  const availableFlows = scope === "all" ? graph.diagnosticFlows || graph.flows : graph.flows;
  const flows = availableFlows.filter((flow) => !query || flow.title.toLowerCase().includes(query) || flow.entryId.toLowerCase().includes(query));
  return {
    query: endpoint || null,
    scope,
    flows,
    flowCatalog: flowCatalog(availableFlows, flows),
    limitation: "Flow steps are static graph traversal from detected entry points. They do not prove runtime order or dynamic execution.",
  };
}

function getSemanticReviewQueue(graph, options = {}) {
  const requestedStatus = optionValue(options, "status", "suggested");
  const status = ["suggested", "agent-proposed", "edited", "rejected", "all"].includes(requestedStatus) ? requestedStatus : "suggested";
  const flows = graph.flows || [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const items = flows.map((flow) => {
    const lens = buildFlowProjection(graph, flow.id, "application");
    const suggestion = createSemanticFlowSuggestion(graph, lens);
    const feedback = resolveSemanticSuggestionFeedback(graph.project.root, graph, suggestion);
    const agentProposal = resolveAgentSemanticProposal(graph.project.root, graph, lens);
    const decision = feedback.record?.decision || null;
    const queueStatus = decision || (agentProposal.status === "current" ? "agent-proposed" : suggestion.status === "suggested" ? "suggested" : "abstained");
    const entry = nodeById.get(flow.entryId);
    const boundNode = lens.handlerEvidence?.handlerId ? nodeById.get(lens.handlerEvidence.handlerId) : null;
    const handler = boundNode?.kind === "symbol" ? boundNode : null;
    return {
      flow: { id: flow.id, title: flow.title, contextRef: lens.flow.contextRef },
      queueStatus,
      suggestion: { status: suggestion.status, confidence: suggestion.confidence, candidate: suggestion.candidate, abstention: suggestion.abstention },
      agentProposal: { status: agentProposal.status, candidate: agentProposal.record?.candidate || null, proposedBy: agentProposal.record?.proposedBy || null, provider: agentProposal.record?.provider || null, rationale: agentProposal.record?.rationale || null },
      feedback: { status: feedback.status, decision, reviewedBy: feedback.record?.reviewedBy || null, editedCandidate: feedback.record?.editedCandidate || null, reason: feedback.record?.reason || null },
      sourceEvidence: {
        endpoint: entry ? { id: entry.id, label: entry.label, path: entry.path, evidence: entry.evidence || null, contextRef: lens.flow.entryContextRef } : null,
        handler: handler ? { id: handler.id, label: handler.label, path: handler.path, evidence: handler.evidence || null } : null,
        handlerBinding: lens.handlerEvidence?.binding || "unknown",
      },
    };
  }).filter((item) => status === "all" || item.queueStatus === status)
    .sort((left, right) => left.flow.title.localeCompare(right.flow.title) || left.flow.id.localeCompare(right.flow.id));
  return {
    schemaVersion: "flowpeek-semantic-review-queue/v1",
    status,
    endpointCount: graph.nodes.filter((node) => node.kind === "endpoint" && (node.sourceScope === "application" || !node.sourceScope)).length,
    flowCatalog: flowCatalog(flows, flows),
    totalMatched: items.length,
    items,
    limitation: "Queue status is local human feedback about deterministic static suggestions. It is separate from human flow verification and never proves runtime behavior.",
  };
}

function getFlowProjection(graph, flowId, scope = "application", options = {}) {
  const maxSteps = validateFlowLensMaxSteps(options.maxSteps ?? DEFAULT_FLOW_LENS_MAX_STEPS);
  const lens = getOrCreateArtifact(graph.project.root, graph, "flow-projection", { flowId, scope, maxSteps }, () => buildFlowProjection(graph, flowId, scope, { maxSteps }), {
    dependencyPaths: (value) => (value?.steps || []).map((step) => step.node?.path).filter(Boolean),
  }).value;
  return attachFlowVerification(graph, lens);
}

function recordAgentEvidenceTrace(graph, input) {
  const resolution = resolveContextRef(graph, input?.contextRef);
  return saveAgentEvidenceTrace(graph.project.root, graph, input, { resolution });
}

function getAgentEvidenceTraces(graph, options = {}) {
  return listStoredAgentEvidenceTraces(graph.project.root, graph, options);
}

function recordSemanticSuggestionFeedback(graph, flowId, input, scope = "application") {
  const lens = buildFlowProjection(graph, flowId, scope);
  if (!lens) return null;
  return saveSemanticSuggestionFeedback(graph.project.root, graph, createSemanticFlowSuggestion(graph, lens), input);
}

function recordAgentSemanticProposal(graph, flowId, input, scope = "application") {
  const lens = buildFlowProjection(graph, flowId, scope);
  if (!lens) return null;
  return saveAgentSemanticProposal(graph.project.root, graph, lens, createSemanticFlowSuggestion(graph, lens), input);
}

function getAgentSemanticProposal(graph, flowId, scope = "application") {
  const lens = buildFlowProjection(graph, flowId, scope);
  return lens ? resolveAgentSemanticProposal(graph.project.root, graph, lens) : null;
}

function getSemanticSuggestionFeedback(graph, flowId, scope = "application") {
  const lens = buildFlowProjection(graph, flowId, scope);
  return lens ? resolveSemanticSuggestionFeedback(graph.project.root, graph, createSemanticFlowSuggestion(graph, lens)) : null;
}

function listSemanticSuggestionFeedback(graph, options = {}) {
  return listStoredSemanticSuggestionFeedback(graph.project.root, graph, options);
}

function getFlowSuggestion(graph, flowId, scope = "application") {
  return getOrCreateArtifact(graph.project.root, graph, "semantic-suggestion", { flowId, scope }, () => {
    const lens = buildFlowProjection(graph, flowId, scope);
    return lens ? createSemanticFlowSuggestion(graph, lens) : null;
  }, {
    dependencyPaths: () => {
      const lens = buildFlowProjection(graph, flowId, scope);
      return (lens?.steps || []).map((step) => step.node?.path).filter(Boolean);
    },
  }).value;
}

function getFlowVerification(graph, flowId, scope = "application") {
  const lens = getFlowProjection(graph, flowId, scope);
  if (!lens) {
    const verification = resolveDetachedFlowVerification(graph.project.root, graph, flowId);
    return verification.record ? {
      ...verification,
      flow: { id: flowId, title: null, contextRef: null },
      limitation: "Human verification is local metadata attached to historical bounded static flow evidence. The flow is absent from the current graph, so no current Flow Lens is implied.",
    } : null;
  }
  return {
    ...lens.verification,
    flow: { id: lens.flow.id, title: lens.flow.title, contextRef: lens.flow.contextRef },
    limitation: "Human verification is local metadata attached to bounded static flow evidence. It does not prove runtime behavior, business purpose, approval outside this local store, or test success.",
  };
}

function getReviewImpact(graph) {
  const counts = { current: 0, compatible: 0, stale: 0, detached: 0, unavailable: 0, missing: 0 };
  const items = [];
  for (const flow of graph.flows || []) {
    const resolution = getFlowVerification(graph, flow.id);
    const status = resolution?.status || "missing";
    counts[status] = (counts[status] || 0) + 1;
    if (["stale", "detached", "unavailable"].includes(status)) items.push({ id: flow.id, title: flow.title, status, reason: resolution?.reason || null });
  }
  return { status: items.length ? "available" : "unavailable", evidenceClass: "human-verification", freshnessStatus: items.length ? "stale" : "current", total: (graph.flows || []).length, counts, items, reason: items.length ? "These human-verification records require review against the current static Flow Lens evidence." : "No stale or unavailable human-verification record exists for current application flows." };
}

function verifyFlow(graph, flowId, input, scope = "application") {
  const lens = buildFlowProjection(graph, flowId, scope);
  if (!lens) return null;
  if (input?.expectedGraphVersion !== undefined && input.expectedGraphVersion !== graph.state.graphVersion) {
    const error = new FlowVerificationError("stale-verification-draft", `Verification draft targets graph v${input.expectedGraphVersion}, but the current graph is v${graph.state.graphVersion}. Refresh the Flow Lens and review the latest evidence.`);
    error.statusCode = 409;
    throw error;
  }
  if (input?.expectedFlowContextRef !== undefined && input.expectedFlowContextRef !== lens.flow.contextRef) {
    const error = new FlowVerificationError("stale-verification-draft", "Verification draft targets an earlier Flow Context Ref. Refresh the Flow Lens and review the latest evidence.");
    error.statusCode = 409;
    throw error;
  }
  saveFlowVerification(graph.project.root, graph, lens, input);
  return getFlowVerification(graph, flowId, scope);
}

function getFlowVerificationHistoryForGraph(graph, flowId) {
  return getFlowVerificationHistory(graph.project.root, graph, flowId);
}

function getVerifiedSemanticMemory(graph, options = {}) {
  const query = String(optionValue(options, "query", "") || "").trim().toLowerCase();
  const requestedLimit = Number(optionValue(options, "limit", 20));
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 100 ? requestedLimit : 20;
  const includeStale = optionValue(options, "includeStale", false) === true || optionValue(options, "includeStale", "false") === "true";
  const records = [];
  const omittedByStatus = {};
  for (const flow of graph.flows || []) {
    const lens = buildFlowProjection(graph, flow.id, "application");
    if (!lens) continue;
    const resolution = resolveFlowVerification(graph.project.root, graph, lens, { readDelta: (fromVersion, toVersion) => readGraphDelta(graph.project.root, fromVersion, toVersion) });
    if (!resolution.record) continue;
    const reusable = ["current", "compatible"].includes(resolution.status);
    if (!reusable && !includeStale) {
      omittedByStatus[resolution.status] = (omittedByStatus[resolution.status] || 0) + 1;
      continue;
    }
    const record = resolution.record;
    const haystack = [record.title, record.description, record.owner, flow.id, flow.title, ...(record.questions || [])].filter(Boolean).join(" ").toLowerCase();
    if (query && !haystack.includes(query)) continue;
    records.push({
      flow: { id: flow.id, contextRef: lens.flow.contextRef, detectedTitle: flow.title },
      status: resolution.status,
      reusable,
      evidenceClass: "human-verified",
      graphVersion: record.sourceGraphVersion,
      technicalFingerprint: record.technicalFingerprint,
      semantics: { title: record.title, description: record.description, owner: record.owner, risk: record.risk, questions: record.questions },
      verifiedBy: record.verifiedBy,
      verifiedAt: record.verifiedAt,
      reason: resolution.reason,
    });
  }
  records.sort((left, right) => Number(right.reusable) - Number(left.reusable) || right.verifiedAt.localeCompare(left.verifiedAt) || left.flow.id.localeCompare(right.flow.id));
  return {
    schemaVersion: "flowpeek-verified-semantic-memory/v1",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    storage: { kind: "verification-backed-index", relativePath: ".flowpeek/flow-verifications.json", modelWeightsStored: false },
    query: query || null,
    totalMatched: records.length,
    returned: Math.min(records.length, limit),
    truncated: records.length > limit,
    omitted: { count: Object.values(omittedByStatus).reduce((sum, count) => sum + count, 0), byStatus: omittedByStatus, reason: "Non-current verification is excluded from reusable semantic memory unless includeStale is explicitly requested." },
    records: records.slice(0, limit),
    limitations: [
      "This is a bounded index of human verification metadata, not an embedded language model or model-training claim.",
      "Only current or compatible records are reusable by default; stale, detached, unavailable, and indeterminate records are never applied silently.",
      "A memory hit may prefill a proposal or draft but cannot create human verification for another flow.",
    ],
  };
}

function recordTestRunEvent(graph, flowId, input, scope = "application") {
  const lens = buildFlowProjection(graph, flowId, scope);
  if (!lens) return null;
  const { scope: _scope, ...eventInput } = input || {};
  return saveTestRunEvent(graph.project.root, graph, lens, { ...eventInput, flowId });
}

function getTestRuns(graph, options = {}) {
  return listStoredTestRuns(graph.project.root, graph, options);
}

function contextVersion(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getChangedContexts(graph, options = {}) {
  const toGraphVersion = contextVersion(optionValue(options, "toVersion", graph.state.graphVersion), graph.state.graphVersion);
  const fromGraphVersion = contextVersion(optionValue(options, "fromVersion", toGraphVersion - 1), toGraphVersion - 1);
  const delta = readGraphDelta(graph.project.root, fromGraphVersion, toGraphVersion);
  const base = {
    schemaVersion: "flowpeek-changed-contexts/v1",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    fromGraphVersion,
    toGraphVersion,
  };
  if (!delta) {
    return {
      ...base,
      available: false,
      nodes: [],
      flows: [],
      summary: { nodes: 0, flows: 0 },
      limitation: "No retained adjacent delta exists for these graph versions. Flowpeek does not reconstruct changed contexts from runtime behavior or arbitrary history.",
    };
  }
  const raw = delta.affectedContexts && !Array.isArray(delta.affectedContexts) ? delta.affectedContexts : { nodes: [], flows: [], truncated: false };
  const comparisonsByFlowId = new Map((delta.flowComparisons?.items || []).map((comparison) => [comparison.flow.id, comparison]));
  const currentNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const currentFlows = new Map(graph.flows.map((flow) => [flow.id, flow]));
  const flows = (raw.flows || []).map((item) => {
    const current = currentFlows.get(item.flow.id) || null;
    const flow = current || item.flow;
    const isHistorical = item.status === "removed" || !current;
    const entryVersion = isHistorical ? fromGraphVersion : graph.state.graphVersion;
    return {
      id: flow.id,
      title: flow.title,
      entryId: flow.entryId,
      status: item.status,
      changedStepIds: item.changedStepIds || [],
      graphVersion: isHistorical ? fromGraphVersion : graph.state.graphVersion,
      entryContextRef: createContextRef(graph.project.projectId, "node", flow.entryId, entryVersion),
      flowContextRef: createContextRef(graph.project.projectId, "flow", flow.id, entryVersion),
      flowProjectionId: isHistorical ? null : `lens:${flow.id}@${graph.state.graphVersion}`,
      flowComparisonId: comparisonsByFlowId.get(flow.id)?.id || null,
      flowComparisonAvailable: comparisonsByFlowId.has(flow.id),
      availability: isHistorical ? "historical" : "current",
      evidence: { kind: "adjacent-graph-delta", fromGraphVersion, toGraphVersion },
    };
  });
  const flowIdsByNode = new Map();
  for (const flow of flows) {
    for (const nodeId of flow.changedStepIds) {
      if (!flowIdsByNode.has(nodeId)) flowIdsByNode.set(nodeId, []);
      flowIdsByNode.get(nodeId).push(flow.id);
    }
  }
  const nodes = (raw.nodes || []).map((item) => {
    const current = currentNodes.get(item.node.id) || null;
    const isHistorical = item.status === "removed" || !current;
    const graphVersion = isHistorical ? fromGraphVersion : graph.state.graphVersion;
    return {
      ...memberSummary(current || item.node),
      status: item.status,
      graphVersion,
      contextRef: createContextRef(graph.project.projectId, "node", item.node.id, graphVersion),
      availability: isHistorical ? "historical" : "current",
      affectedFlowIds: flowIdsByNode.get(item.node.id) || [],
      evidence: { kind: "adjacent-graph-delta", fromGraphVersion, toGraphVersion },
    };
  });
  return {
    ...base,
    available: true,
    delta: { reason: delta.reason, sourceChanged: delta.sourceChanged, topologyChanged: delta.topologyChanged, changedPaths: delta.changedPaths, truncated: Boolean(delta.truncated || raw.truncated) },
    nodes,
    flows,
    summary: { nodes: nodes.length, flows: flows.length },
    limitation: "Changed contexts are bounded static evidence from one retained adjacent graph delta. A current context may have changed source without a topology change; historical entries do not reconstruct a full old Context Card or Flow Lens.",
  };
}

function getFlowComparison(graph, flowId, options = {}) {
  const toGraphVersion = contextVersion(optionValue(options, "toVersion", graph.state.graphVersion), graph.state.graphVersion);
  const fromGraphVersion = contextVersion(optionValue(options, "fromVersion", toGraphVersion - 1), toGraphVersion - 1);
  const delta = readGraphDelta(graph.project.root, fromGraphVersion, toGraphVersion);
  return flowComparisonResult(graph, delta, flowId);
}

function normaliseChangedPath(graph, value) {
  const path = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  const root = String(graph.project.root || "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (!path || path === "." || path.split("/").includes("..")) return null;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function impactNode(node, distance, relationship = distance === 0 ? "changed" : "dependent") {
  return { ...memberSummary(node), distance, relationship };
}

function dependencyNode(node, distance) {
  return { ...memberSummary(node), distance, relationship: distance === 0 ? "changed" : "dependency" };
}

function graphEdgeKey(edge) {
  return `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
}

function graphEdgeSummary(edge, nodesById) {
  return {
    type: edge.type,
    confidence: edge.confidence,
    source: memberSummary(nodesById.get(edge.source)),
    target: memberSummary(nodesById.get(edge.target)),
  };
}

function getGraphDelta(previousGraph, graph, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  if (!previousGraph) {
    return {
      available: false,
      limitation: "No previous in-process graph is available for comparison. Refresh once after the MCP server starts or after a prior refresh.",
    };
  }
  const previousNodes = new Map(previousGraph.nodes.map((node) => [node.id, node]));
  const currentNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previousGraph.edges.map((edge) => [graphEdgeKey(edge), edge]));
  const currentEdges = new Map(graph.edges.map((edge) => [graphEdgeKey(edge), edge]));
  const addedNodeIds = [...currentNodes.keys()].filter((id) => !previousNodes.has(id)).sort();
  const removedNodeIds = [...previousNodes.keys()].filter((id) => !currentNodes.has(id)).sort();
  const addedEdgeKeys = [...currentEdges.keys()].filter((key) => !previousEdges.has(key)).sort();
  const removedEdgeKeys = [...previousEdges.keys()].filter((key) => !currentEdges.has(key)).sort();
  return {
    available: true,
    compared: {
      projectId: graph.project?.projectId || null,
      previousGraphVersion: previousGraph.state?.graphVersion ?? null,
      graphVersion: graph.state?.graphVersion ?? null,
      previousGeneratedAt: previousGraph.generatedAt,
      generatedAt: graph.generatedAt,
    },
    summary: {
      addedNodes: addedNodeIds.length,
      removedNodes: removedNodeIds.length,
      addedEdges: addedEdgeKeys.length,
      removedEdges: removedEdgeKeys.length,
    },
    addedNodes: addedNodeIds.slice(0, limit).map((id) => memberSummary(currentNodes.get(id))),
    removedNodes: removedNodeIds.slice(0, limit).map((id) => memberSummary(previousNodes.get(id))),
    addedEdges: addedEdgeKeys.slice(0, limit).map((key) => graphEdgeSummary(currentEdges.get(key), currentNodes)),
    removedEdges: removedEdgeKeys.slice(0, limit).map((key) => graphEdgeSummary(previousEdges.get(key), previousNodes)),
    truncated: addedNodeIds.length > limit || removedNodeIds.length > limit || addedEdgeKeys.length > limit || removedEdgeKeys.length > limit,
    limitation: "This compares only Flowpeek graph topology in the current MCP process. Unchanged IDs can still have source edits, and this is not a source diff, Git diff, or runtime behavior diff.",
  };
}

function indexNodesByPath(graph) {
  const paths = new Map();
  for (const node of graph.nodes) {
    if (!node.path) continue;
    if (!paths.has(node.path)) paths.set(node.path, []);
    paths.get(node.path).push(node);
  }
  return paths;
}

function historicalDeletedDependents(previousGraph, deletedPaths, currentNodesById, currentNodesByPath, maxDepth) {
  if (!previousGraph || !Array.isArray(previousGraph.nodes) || !Array.isArray(previousGraph.edges)) return { deletedNodes: [], seeds: new Map() };
  const previousNodesById = new Map(previousGraph.nodes.map((node) => [node.id, node]));
  const previousNodesByPath = indexNodesByPath(previousGraph);
  const incoming = new Map();
  for (const edge of previousGraph.edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge);
  }
  const seeds = new Map();
  const deletedNodes = [];
  const queue = [];
  const visited = new Set();
  for (const path of deletedPaths) {
    for (const node of previousNodesByPath.get(path) || []) {
      if (node.kind === "file") deletedNodes.push(memberSummary(node));
      queue.push({ id: node.id, distance: 0 });
    }
  }
  while (queue.length && visited.size < 120) {
    const current = queue.shift();
    if (visited.has(current.id) || current.distance >= maxDepth) continue;
    visited.add(current.id);
    for (const edge of incoming.get(current.id) || []) {
      const dependent = previousNodesById.get(edge.source);
      if (!dependent) continue;
      const candidates = currentNodesById.has(dependent.id)
        ? [currentNodesById.get(dependent.id)]
        : dependent.path ? currentNodesByPath.get(dependent.path) || [] : [];
      for (const candidate of candidates) {
        const distance = current.distance + 1;
        if (!seeds.has(candidate.id) || seeds.get(candidate.id) > distance) seeds.set(candidate.id, distance);
      }
      queue.push({ id: dependent.id, distance: current.distance + 1 });
    }
  }
  return { deletedNodes: deletedNodes.sort((left, right) => left.path.localeCompare(right.path)), seeds, truncated: queue.length > 0 };
}

function buildChangeImpact(graph, changedPaths, options = {}) {
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 6, 0), 12);
  const paths = [...new Set((Array.isArray(changedPaths) ? changedPaths : [changedPaths])
    .map((value) => normaliseChangedPath(graph, value))
    .filter(Boolean))];
  const nodesByPath = new Map();
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    if (!node.path) continue;
    if (!nodesByPath.has(node.path)) nodesByPath.set(node.path, []);
    nodesByPath.get(node.path).push(node);
  }
  const matchedPaths = paths.filter((path) => nodesByPath.has(path));
  const previousGraph = options.previousGraph?.project?.root === graph.project?.root ? options.previousGraph : null;
  const previousNodesByPath = previousGraph ? indexNodesByPath(previousGraph) : new Map();
  const deletedPaths = paths.filter((path) => !nodesByPath.has(path) && previousNodesByPath.has(path));
  const unmatchedPaths = paths.filter((path) => !nodesByPath.has(path) && !previousNodesByPath.has(path));
  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of graph.edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge);
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  const impacted = new Map();
  const queue = [];
  const historicalDependentIds = new Set();
  for (const path of matchedPaths) {
    for (const node of nodesByPath.get(path)) {
      if (impacted.has(node.id)) continue;
      impacted.set(node.id, 0);
      queue.push({ id: node.id, distance: 0 });
    }
  }
  const historical = historicalDeletedDependents(previousGraph, deletedPaths, nodesById, nodesByPath, maxDepth);
  for (const [id, distance] of historical.seeds) {
    historicalDependentIds.add(id);
    if (impacted.has(id) && impacted.get(id) <= distance) continue;
    impacted.set(id, distance);
    queue.push({ id, distance });
  }
  while (queue.length && impacted.size < 120) {
    const current = queue.shift();
    if (current.distance >= maxDepth) continue;
    for (const edge of incoming.get(current.id) || []) {
      const dependent = nodesById.get(edge.source);
      if (!dependent || impacted.has(dependent.id)) continue;
      impacted.set(dependent.id, current.distance + 1);
      queue.push({ id: dependent.id, distance: current.distance + 1 });
    }
  }
  const nodes = [...impacted.entries()]
    .map(([id, distance]) => impactNode(nodesById.get(id), distance, historicalDependentIds.has(id) ? "historical-dependent" : undefined))
    .sort((left, right) => left.distance - right.distance || left.label.localeCompare(right.label));
  const recommendedTests = nodes.filter((node) => node.type === "test");
  const affectedEndpoints = nodes.filter((node) => node.kind === "endpoint");
  const dependencies = new Map();
  const dependencyQueue = [];
  for (const path of matchedPaths) {
    for (const node of nodesByPath.get(path)) {
      if (dependencies.has(node.id)) continue;
      dependencies.set(node.id, 0);
      dependencyQueue.push({ id: node.id, distance: 0 });
    }
  }
  while (dependencyQueue.length && dependencies.size < 120) {
    const current = dependencyQueue.shift();
    if (current.distance >= maxDepth) continue;
    for (const edge of outgoing.get(current.id) || []) {
      const dependency = nodesById.get(edge.target);
      if (!dependency || dependencies.has(dependency.id)) continue;
      dependencies.set(dependency.id, current.distance + 1);
      dependencyQueue.push({ id: dependency.id, distance: current.distance + 1 });
    }
  }
  const dependencyNodes = [...dependencies.entries()]
    .map(([id, distance]) => dependencyNode(nodesById.get(id), distance))
    .sort((left, right) => left.distance - right.distance || left.label.localeCompare(right.label));
  return {
    changedPaths: paths,
    matchedPaths,
    deletedPaths,
    unmatchedPaths,
    deletedNodes: historical.deletedNodes,
    historicalBaseline: Boolean(previousGraph),
    changedNodes: nodes.filter((node) => node.distance === 0),
    affectedNodes: nodes,
    affectedEndpoints,
    recommendedTests,
    dependencyNodes,
    truncated: impacted.size >= 120 || dependencies.size >= 120 || historical.truncated,
    limitation: "Impact is a traversal of stored static graph edges. It identifies direct and transitive dependents and dependencies, not runtime execution or dynamic loading. Deleted-file callers are historical evidence only when a matching prior graph is available; the prior graph can be stale.",
  };
}

function getChangeImpact(graph, changedPaths, options = {}) {
  if (options.previousGraph) return buildChangeImpact(graph, changedPaths, options);
  return getOrCreateArtifact(graph.project.root, graph, "impact-index", { changedPaths, maxDepth: options.maxDepth || 6 }, () => buildChangeImpact(graph, changedPaths, options), {
    dependencyPaths: (value) => [...(value.changedPaths || []), ...(value.affectedNodes || []).map((node) => node.path), ...(value.dependencyNodes || []).map((node) => node.path)].filter(Boolean),
  }).value;
}

module.exports = {
  VALID_MODES,
  VALID_SCOPES,
  findNodes,
  getAgentBootstrap,
  getArtifactCacheAudit,
  getContextCard,
  getNodeDetails,
  getProjectHome,
  getProductProof,
  getHandoffQuality,
  getRuntimeEvidence,
  getTrustAnalytics,
  getRelatedTests,
  getChangeImpact,
  getGraphDelta,
  getChangedContexts,
  getFlowComparison,
  getFlowContextCard,
  getFlowProjection,
  getFlowSuggestion,
  getFlowVerification,
  getVerifiedSemanticMemory,
  getTestRuns,
  getFlowVerificationHistory: getFlowVerificationHistoryForGraph,
  getDurableBrief,
  getHandoffContext,
  getHandoffWorkspace,
  getAgentEvidenceTraces,
  getAgentSemanticProposal,
  getSemanticSuggestionFeedback,
  getRequestFlows,
  getSemanticReviewQueue,
  listSemanticSuggestionFeedback,
  listHandoffWorkspaces,
  listImportedHandoffs,
  listDurableBriefManifests,
  materializeDurableBrief,
  exportHandoffWorkspace,
  importHandoffWorkspace,
  projectView,
  recordAgentEvidenceTrace,
  recordAgentSemanticProposal,
  recordRuntimeEvidence,
  recordTestRunEvent,
  recordSemanticSuggestionFeedback,
  saveHandoffNote,
  saveHandoffWorkspace,
  resolveContextRef,
  verifyFlow,
};
