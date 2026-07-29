const VALID_MODES = new Set(["overview", "requests", "dependencies"]);
const VALID_SCOPES = new Set(["application", "runtime", "framework", "devtool", "all"]);
const VALID_VIEW_LEVELS = new Set(["domain", "feature", "component", "symbol"]);
const VIEW_PROJECTION_SCHEMA = "flopeek-view-projection/v2";
const DEFAULT_VIEW_MAX_NODES = 40;
const DEFAULT_VIEW_MAX_EDGES = 80;
const MAX_VIEW_NODES = 100;
const MAX_VIEW_EDGES = 200;
const MAX_AGENT_SEMANTIC_SUGGESTIONS = 12;
const { createWorkRecord: createStoredWorkRecord, getWorkTimeline: getStoredWorkTimeline, listWorkRecords: listStoredWorkRecords, recordWorkEvent: recordStoredWorkEvent, updateWorkPlan: updateStoredWorkPlan } = require("./delivery-graph");
const { createContinuationCheckpoint: createStoredContinuationCheckpoint, getContinuationCheckpoint: getStoredContinuationCheckpoint, listContinuationCheckpoints: listStoredContinuationCheckpoints } = require("./continuation-checkpoint");
const { createPlannedOverlay: createStoredPlannedOverlay, getPlannedOverlay: getStoredPlannedOverlay, listPlannedOverlays: listStoredPlannedOverlays, resolvePlanRef: resolveStoredPlanRef } = require("./planned-overlay");
const { getPlanReconciliation: getStoredPlanReconciliation, listPlanReconciliations: listStoredPlanReconciliations, recordPlanReconciliation: recordStoredPlanReconciliation } = require("./plan-reconciliation");
const { compareContinuation: compareStoredContinuation } = require("./continuation-comparison");
const { getCheckpointDivergence: getStoredCheckpointDivergence } = require("./continuation-divergence");
const { createContinuationContext: buildContinuationContext } = require("./continuation-context");
const { assignWorkflow: assignStoredWorkflow, getWorkDependencyStatus: getStoredWorkDependencyStatus, getWorkRecordWorkflow: getStoredWorkRecordWorkflow, listWorkDependencyStatuses: listStoredWorkDependencyStatuses, listWorkflows: listStoredWorkflows, saveWorkflow: saveStoredWorkflow, transitionWorkRecord: transitionStoredWorkRecord } = require("./workflow-engine");
const { createContextPacket, createContextRef, createNodeContextCard, parseContextRef, resolveContextRef: resolveStoredContextRef } = require("./context-card");
const { cacheHygiene, getOrCreateArtifact, listArtifactCacheAudit, pruneArtifactCache } = require("./artifact-cache");
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
const { listGraphDeltaHistory, readGraphDelta, readLatestGraphDelta } = require("./graph-state");
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
const { isSupportedFlowEntryNode } = require("./flow-entry");
const { getActiveBranchGitEvidence: buildActiveBranchGitEvidence } = require("./active-branch-git-evidence");
const { getGitContextContinuity: buildGitContextContinuity } = require("./git-context-continuity");
const { getGraphDelta } = require("./graph-delta");
const { getRelatedImplementations: buildRelatedImplementations } = require("./related-implementations");

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
  if (members.some((node) => node.kind === "command")) return "command";
  if (key.startsWith("data")) return "database";
  if (key.startsWith("runtime")) return "external";
  if (members.some((node) => node.type === "service")) return "service";
  if (members.some((node) => node.type === "repository")) return "repository";
  return "feature";
}

function aggregateProjection(graph, sourceNodes, mode, scope, keyForNode = featureKey, options = {}) {
  const groupMap = new Map();
  for (const node of sourceNodes) {
    const key = keyForNode(node);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(node);
  }
  const memberToSummary = new Map();
  const nodes = [...groupMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, members]) => {
    const id = options.idForKey ? options.idForKey(key) : `${options.idPrefix || "feature"}:${key}`;
    members.forEach((member) => memberToSummary.set(member.id, id));
    const types = [...new Set(members.map((member) => member.type))].sort();
    const typeCounts = Object.fromEntries(types.map((type) => [type, members.filter((member) => member.type === type).length]));
    return {
      id,
      kind: "summary",
      type: summaryType(members, key),
      label: options.labelForKey ? options.labelForKey(key) : featureLabel(key),
      feature: key,
      layer: "projection",
      memberCount: members.length,
      members: members.slice(0, 12).map(memberSummary),
      memberIds: members.map((member) => member.id),
      typeCounts,
      detectedResponsibility: `Feature summary of ${members.length} source node${members.length === 1 ? "" : "s"}.`,
      analysis: { parser: "flopeek-projection", status: "aggregate", confidence: "derived" },
      hierarchy: {
        level: options.level || "feature",
        key,
        parentId: options.parentIdForKey ? options.parentIdForKey(key) : null,
      },
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

function entrySourceNodes(graph, scope) {
  const visible = graph.nodes.filter((node) => isVisibleInScope(node, scope) && node.type !== "test");
  const visibleIds = new Set(visible.map((node) => node.id));
  const included = new Set(visible
    .filter(isSupportedFlowEntryNode)
    .map((node) => node.id));
  for (const edge of graph.edges) {
    if (edge.type === "handles" && included.has(edge.source) && visibleIds.has(edge.target)) included.add(edge.target);
    if (edge.type === "declares-command-target" && included.has(edge.source) && visibleIds.has(edge.target)) included.add(edge.target);
    if (edge.type === "schedules" && included.has(edge.source) && visibleIds.has(edge.target)) included.add(edge.target);
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
  const relatedEdges = graph.edges.filter((edge) => (edge.source === focus.id || edge.target === focus.id) && visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const included = new Set([focus.id]);
  relatedEdges.forEach((edge) => { included.add(edge.source); included.add(edge.target); });
  return {
    nodes: visible.filter((node) => included.has(node.id)),
    edges: relatedEdges,
    sourceNodeCount: included.size,
    focusId: focus.id,
  };
}

const HIERARCHY_SEPARATOR = "\u0000";

function domainKey(node) { return node.domain || "project"; }

function hierarchyId(level, ...parts) {
  return `${level}:${parts.map((part) => encodeURIComponent(String(part))).join(":")}`;
}

function hierarchyParts(value) {
  return String(value || "").split(HIERARCHY_SEPARATOR);
}

function hierarchyGroupKey(...parts) {
  return parts.join(HIERARCHY_SEPARATOR);
}

function featureGroupKey(node) {
  return hierarchyGroupKey(domainKey(node), featureKey(node));
}

function componentKey(node) {
  if (!node.path) return node.type || "external";
  const segments = node.path.split("/");
  segments.pop();
  return segments.length ? segments.join("/") : "root";
}

function componentGroupKey(node) {
  return hierarchyGroupKey(domainKey(node), featureKey(node), componentKey(node));
}

function semanticLabel(level, key) {
  if (level === "feature") return featureLabel(key);
  if (level === "domain") return humanizeSegment(key);
  const segments = key.split("/");
  const feature = segments.slice(0, 2).join("/");
  const component = segments.slice(2).join("/") || "root";
  return `${featureLabel(feature)} · ${component.split("/").map(humanizeSegment).join(" / ")}`;
}

function semanticHierarchyLabel(level, key) {
  const parts = hierarchyParts(key);
  if (level === "domain") return humanizeSegment(key);
  if (level === "feature") return featureLabel(parts[1] || parts[0]);
  const component = parts[2] || "root";
  return `${featureLabel(parts[1])} / ${component.split("/").map(humanizeSegment).join(" / ")}`;
}

function parentHierarchyId(level, key) {
  const parts = hierarchyParts(key);
  if (level === "feature") return hierarchyId("domain", parts[0]);
  if (level === "component") return hierarchyId("feature", parts[0], parts[1]);
  return null;
}

function parseHierarchyFocus(focusId) {
  if (!focusId) return null;
  const [level, ...encodedParts] = focusId.split(":");
  if (!encodedParts.length || !["domain", "feature", "component"].includes(level)) return null;
  try {
    return { level, parts: encodedParts.map((part) => decodeURIComponent(part)) };
  } catch {
    return null;
  }
}

function semanticFocusMatches(node, focusId) {
  if (!focusId) return true;
  const hierarchyFocus = parseHierarchyFocus(focusId);
  if (hierarchyFocus?.level === "domain") return domainKey(node) === hierarchyFocus.parts[0];
  if (hierarchyFocus?.level === "feature") return domainKey(node) === hierarchyFocus.parts[0] && featureKey(node) === hierarchyFocus.parts[1];
  if (hierarchyFocus?.level === "component") return domainKey(node) === hierarchyFocus.parts[0] && featureKey(node) === hierarchyFocus.parts[1] && componentKey(node) === hierarchyFocus.parts[2];
  // Legacy ids can still be resolved from a retained client/cache, but new
  // projections always use composite hierarchy ids so a child cannot escape
  // the selected domain or feature.
  if (focusId.startsWith("domain:")) return domainKey(node) === focusId.slice("domain:".length);
  if (focusId.startsWith("feature:")) return overviewFeatureKey(node) === focusId.slice("feature:".length) || featureKey(node) === focusId.slice("feature:".length);
  if (focusId.startsWith("component:")) return componentKey(node) === focusId.slice("component:".length);
  return node.id === focusId;
}

function semanticProjection(graph, mode, scope, level, focusId) {
  const candidates = mode === "requests" ? entrySourceNodes(graph, scope) : graph.nodes.filter((node) => isVisibleInScope(node, scope));
  const sourceNodes = candidates.filter((node) => semanticFocusMatches(node, focusId));
  if (level === "symbol") {
    const ids = new Set(sourceNodes.map((node) => node.id));
    return {
      nodes: sourceNodes.map((node) => ({
        ...node,
        hierarchy: { ...(node.hierarchy || {}), level: "symbol", parentId: focusId || null },
      })),
      edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
      sourceNodeCount: sourceNodes.length,
      mode,
      scope,
      focusId,
      hierarchy: { level, parentFocusId: focusId || null },
    };
  }
  const keyForNode = level === "domain" ? domainKey : level === "component" ? componentGroupKey : featureGroupKey;
  return {
    ...aggregateProjection(graph, sourceNodes, mode, scope, keyForNode, {
      idPrefix: level,
      idForKey: (key) => {
        const parts = hierarchyParts(key);
        return level === "domain" ? hierarchyId("domain", key) : hierarchyId(level, ...parts);
      },
      labelForKey: (key) => semanticHierarchyLabel(level, key),
      parentIdForKey: (key) => parentHierarchyId(level, key),
      level,
    }),
    focusId,
    hierarchy: { level, parentFocusId: focusId || null },
  };
}

function projectionLimit(value, fallback, maximum, label) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  return parsed;
}

function projectionNodeOrder(focusId) {
  return (left, right) => {
    if (left.id === focusId) return -1;
    if (right.id === focusId) return 1;
    return left.id.localeCompare(right.id);
  };
}

function boundedProjection(projection, options = {}) {
  const maxNodes = projectionLimit(optionValue(options, "maxNodes", null), DEFAULT_VIEW_MAX_NODES, MAX_VIEW_NODES, "maxNodes");
  const maxEdges = projectionLimit(optionValue(options, "maxEdges", null), DEFAULT_VIEW_MAX_EDGES, MAX_VIEW_EDGES, "maxEdges");
  const allNodes = [...projection.nodes].sort(projectionNodeOrder(projection.focusId));
  const nodes = allNodes.slice(0, maxNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const allEdges = projection.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((left, right) => String(left.id || `${left.source}\u0000${left.target}\u0000${left.type}`).localeCompare(String(right.id || `${right.source}\u0000${right.target}\u0000${right.type}`)));
  const edges = allEdges.slice(0, maxEdges);
  const omittedNodes = allNodes.slice(maxNodes).map((node) => node.id);
  const omittedEdges = allEdges.slice(maxEdges).map((edge) => edge.id || `${edge.source}\u0000${edge.target}\u0000${edge.type}`);
  const unavailableEdges = projection.edges.length - allEdges.length;
  const truncated = omittedNodes.length > 0 || omittedEdges.length > 0 || unavailableEdges > 0;
  return {
    ...projection,
    nodes,
    edges,
    display: {
      bounds: { maxNodes, maxEdges, hardMaxNodes: MAX_VIEW_NODES, hardMaxEdges: MAX_VIEW_EDGES },
      catalog: {
        nodes: { total: allNodes.length, returned: nodes.length, omitted: omittedNodes.length, sampleOmittedIds: omittedNodes.slice(0, 12) },
        edges: { total: projection.edges.length, eligible: allEdges.length, returned: edges.length, omitted: omittedEdges.length, omittedBecauseNodeBound: unavailableEdges, sampleOmittedIds: omittedEdges.slice(0, 12) },
        truncated,
        warning: truncated ? "This view is bounded. Use focus, scope, Flow Lens, or a smaller hierarchy level to inspect omitted static evidence." : null,
      },
    },
  };
}

function agentEntryInventory(graph) {
  const inventory = graph.analysis?.entryPoints;
  if (!inventory) return null;
  const reasonCounts = new Map();
  for (const entry of inventory.unsupported?.packageScripts || []) {
    reasonCounts.set(entry.reason, (reasonCounts.get(entry.reason) || 0) + 1);
  }
  const scheduleReasonCounts = new Map();
  for (const entry of inventory.unsupported?.nodeCronSchedules || []) {
    scheduleReasonCounts.set(entry.reason, (scheduleReasonCounts.get(entry.reason) || 0) + 1);
  }
  const frameworkCommandReasonCounts = new Map();
  for (const entry of inventory.unsupported?.djangoManagementCommands || []) {
    frameworkCommandReasonCounts.set(entry.reason, (frameworkCommandReasonCounts.get(entry.reason) || 0) + 1);
  }
  return {
    schemaVersion: inventory.schemaVersion || null,
    supported: {
      packageScripts: (inventory.supported?.packageScripts || []).map((entry) => ({
        id: entry.id,
        manifest: entry.manifest,
        scriptName: entry.scriptName,
        runner: entry.runner,
        targetPath: entry.targetPath,
        targetId: entry.targetId,
      })),
      djangoManagementCommands: (inventory.supported?.djangoManagementCommands || []).map((entry) => ({
        id: entry.id,
        path: entry.path,
        commandName: entry.commandName,
        targetPath: entry.targetPath,
        targetId: entry.targetId,
      })),
      nodeCronSchedules: (inventory.supported?.nodeCronSchedules || []).map((entry) => ({
        id: entry.id,
        path: entry.path,
        expression: entry.expression,
        taskName: entry.taskName,
        targetPath: entry.targetPath,
        targetId: entry.targetId,
      })),
    },
    unsupported: {
      packageScriptReasonCounts: Object.fromEntries([...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      djangoManagementCommandReasonCounts: Object.fromEntries([...frameworkCommandReasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      nodeCronScheduleReasonCounts: Object.fromEntries([...scheduleReasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
    limitations: inventory.limitations || [],
  };
}

function createAgentContextStatic(graph, projection, mode, scope, focusId) {
  const projectionMeaning = mode === "overview"
    ? "Each visible node is a feature summary that aggregates source nodes. It is not a source file, runtime service, or execution step."
    : mode === "requests"
      ? "Each visible node is a feature summary. Edges aggregate supported static entry, HTTP handler, static fetch, import, or usage facts; they do not prove command invocation or end-to-end runtime execution."
      : "Each visible node is an original graph node. Edges are direct parser facts for the selected node's neighborhood.";
  return {
    schemaVersion: "flopeek-agent-context/v1",
    mode,
    scope,
    level: projection.hierarchy?.level || (mode === "dependencies" ? "symbol" : "feature"),
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
      "Use get_entry_flows followed by get_flow_projection for a bounded static explanation of a supported HTTP/request, command, or scheduler entry; inspect a step Context Card before changing code.",
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
    entryPoints: agentEntryInventory(graph),
    repositoryScope: graph.analysis.repositoryScope,
    packageSelection: graph.analysis.packageSelection || graph.analysis.scanOutcome?.discovery?.selection || null,
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

// Local audit stores are intentionally outside the native graph authority.
// They enrich a static context already assembled by Rust (or by the JS core),
// but never select graph evidence, derive topology, or alter a projection.
function attachLocalAgentContext(graph, staticContext, scope) {
  const derivedCache = listArtifactCacheAudit(graph.project.root, graph);
  const derivedCacheEvents = (derivedCache.events || []).slice(0, 10);
  const derivedCacheEventTotal = derivedCache.eventCatalog?.total || derivedCacheEvents.length;
  const { trustAnalytics, productProof, ...staticEvidence } = staticContext;
  if (staticEvidence.cache === null && graph.analysis.cache === undefined) staticEvidence.cache = undefined;
  return {
    ...staticEvidence,
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
    trustAnalytics,
    productProof,
  };
}

function createAgentContext(graph, projection, mode, scope, focusId) {
  return attachLocalAgentContext(graph, createAgentContextStatic(graph, projection, mode, scope, focusId), scope);
}

function getAgentBootstrap(graph, options = {}) {
  return createAgentBootstrap(graph, options);
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
  const requestedLevel = optionValue(options, "level", "feature");
  const level = mode === "dependencies" ? "symbol" : VALID_VIEW_LEVELS.has(requestedLevel) ? requestedLevel : "feature";
  let projection;
  if (mode === "dependencies") projection = dependencyProjection(graph, scope, focusId);
  else projection = getOrCreateArtifact(graph.project.root, graph, "feature-summary", {
    mode,
    scope,
    level,
    focusId,
    // Hierarchy keys deliberately retain every selected ancestor. Keep cached
    // summaries from the earlier flat-key algorithm out of this projection.
    semanticHierarchyVersion: 2,
  }, () => semanticProjection(graph, mode, scope, level, focusId), { dependencyPaths: ["*"] }).value;
  projection = boundedProjection(projection, options);
  const aiContext = createAgentContext(graph, projection, mode, scope, focusId);
  const availableFlows = scope === "all" ? graph.diagnosticFlows || graph.flows : graph.flows;
  // Flow discovery is uncapped. If pagination is introduced later, this catalog
  // keeps the omission contract visible and deterministic.
  const flows = availableFlows;
  return {
    schemaVersion: VIEW_PROJECTION_SCHEMA,
    generatedAt: graph.generatedAt,
    project: graph.project,
    stats: graph.stats,
    nodes: projection.nodes,
    edges: projection.edges,
    flows,
    flowCatalog: flowCatalog(availableFlows, flows),
    basis: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceFingerprint: graph.state.sourceFingerprint },
    display: projection.display,
    view: { mode, scope, level, focusId, sourceNodeCount: projection.sourceNodeCount, emptyState: projection.emptyState || null, hierarchy: projection.hierarchy || { level, parentFocusId: null } },
    aiContext,
  };
}

function findNodes(graph, options = {}) {
  const text = String(optionValue(options, "q", optionValue(options, "query", ""))).trim().toLowerCase();
  if (!text) return { query: "", results: [] };
  const requestedScope = optionValue(options, "scope", "application");
  const scope = VALID_SCOPES.has(requestedScope) ? requestedScope : "application";
  const typeRank = { endpoint: 0, command: 1, schedule: 2, route: 3, controller: 4, service: 5, class: 6, function: 7, repository: 8, database: 9, queue: 10, module: 11 };
  const results = graph.nodes
    .filter((node) => isVisibleInScope(node, scope))
    .filter((node) => [node.label, node.path, node.feature, node.domain, node.type].filter(Boolean).join(" ").toLowerCase().includes(text))
    .sort((left, right) => (typeRank[left.type] ?? 99) - (typeRank[right.type] ?? 99) || left.label.localeCompare(right.label))
    .slice(0, 12)
    .map(memberSummary);
  return { query: text, scope, results };
}

function attachNodeExtensions(graph, detail) {
  if (!detail) return null;
  return {
    ...detail,
    agentEvidenceTraces: listStoredAgentEvidenceTraces(graph.project.root, graph, { contextId: detail.node.id, limit: 10 }),
  };
}

// The native core owns static projection selection, hierarchy aggregation,
// bounds, and flow catalog construction.  This adapter deliberately receives
// an already bounded public view and only attaches local audit/cache metadata
// that has no graph-authority equivalent in SQLite yet.
function attachNativeProjectOverview(graph, coreView) {
  if (!coreView || coreView.schemaVersion !== "flopeek-native-view-projection-core/v1" || !coreView.view || !coreView.display) {
    throw new TypeError("Native core returned an invalid view projection.");
  }
  const { agentContextCore, ...nativeView } = coreView;
  if (!agentContextCore || agentContextCore.schemaVersion !== "flopeek-agent-context/v1") {
    throw new TypeError("Native core returned no static agent context.");
  }
  const { mode, scope, focusId } = nativeView.view;
  const projection = {
    nodes: nativeView.nodes,
    edges: nativeView.edges,
    sourceNodeCount: nativeView.view.sourceNodeCount,
    hierarchy: nativeView.view.hierarchy,
    display: nativeView.display,
  };
  // Keep the established artifact-audit contract without recomputing the
  // projection.  The native result is the value persisted under the same key
  // that the former JavaScript projector used, so cache hits remain a local
  // transport optimization and never become a second graph authority.
  if (mode !== "dependencies") {
    getOrCreateArtifact(graph.project.root, graph, "feature-summary", {
      mode,
      scope,
      level: nativeView.view.level,
      focusId,
      semanticHierarchyVersion: 2,
    }, () => projection, { dependencyPaths: ["*"] });
  }
  const staticContext = agentContextCore;
  return {
    ...nativeView,
    schemaVersion: VIEW_PROJECTION_SCHEMA,
    aiContext: attachLocalAgentContext(graph, staticContext, scope),
  };
}

function getNodeDetails(graph, id) {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) return null;
  const byId = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const detailFor = (edge, nodeId) => ({ ...edge, node: byId.get(nodeId) });
  const incoming = graph.edges.filter((edge) => edge.target === node.id).map((edge) => detailFor(edge, edge.source)).filter((item) => item.node);
  const outgoing = graph.edges.filter((edge) => edge.source === node.id).map((edge) => detailFor(edge, edge.target)).filter((item) => item.node);
  return attachNodeExtensions(graph, {
    node,
    incoming,
    outgoing,
    relatedTests: [...incoming, ...outgoing].filter((item) => item.node.type === "test"),
  });
}

function getContextCard(graph, id, format = "json") {
  const detail = getNodeDetails(graph, id);
  if (!detail) return null;
  const card = createNodeContextCard(graph, detail);
  return createContextPacket(card, format);
}

// Extensions decorate an already-assembled static Flow Lens. Keeping this
// separate from buildFlowProjection lets the Rust core own the deterministic
// lens while legacy local metadata remains an adapter over the public graph.
function attachFlowExtensions(graph, lens) {
  if (!lens) return null;
  const semanticSuggestion = createSemanticFlowSuggestion(graph, lens);
  const semanticFeedback = resolveSemanticSuggestionFeedback(graph.project.root, graph, semanticSuggestion);
  const agentSemanticProposal = resolveAgentSemanticProposal(graph.project.root, graph, lens);
  const agentEvidenceTraces = listStoredAgentEvidenceTraces(graph.project.root, graph, { contextId: lens.flow.id, limit: 10 });
  const verification = resolveFlowVerification(graph.project.root, graph, lens, {
    readDelta: (fromVersion, toVersion) => availableGraphDelta(graph, fromVersion, toVersion),
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

// Rust owns the static Flow Context Card for the native core. This adapter
// intentionally adds only local human/agent metadata; it must not rebuild the
// Flow Lens, related-test selection, card bounds, or any graph-derived field.
function attachNativeFlowContextCard(graph, coreCard, lens) {
  if (!coreCard || coreCard.schemaVersion !== "flopeek-context/v1" || coreCard.kind !== "flow") {
    throw new TypeError("Native core returned an invalid Flow Context Card.");
  }
  if (!lens?.flow?.id || lens.flow.id !== coreCard.flow?.id) {
    throw new TypeError("Native core Flow Context Card does not match its Flow Lens.");
  }
  const verification = lens.verification || null;
  return {
    ...coreCard,
    semanticSuggestion: lens.semanticSuggestion || null,
    agentSemanticProposal: lens.agentSemanticProposal || null,
    semanticFeedback: lens.semanticFeedback || null,
    flowInterface: lens.flowInterface || null,
    verification,
    humanVerification: verification?.record ? {
      title: verification.record.title,
      description: verification.record.description,
      owner: verification.record.owner,
      risk: verification.record.risk,
      questions: verification.record.questions,
      verifiedBy: verification.record.verifiedBy,
      verifiedAt: verification.record.verifiedAt,
      sourceGraphVersion: verification.record.sourceGraphVersion,
      status: verification.status,
      knowledgeClass: "human-verified",
    } : null,
    unresolvedQuestions: lens.unresolvedQuestions,
  };
}

function resolveContextRef(graph, contextRef) {
  try {
    if (parseContextRef(contextRef).kind === "brief") return resolveDurableBriefRef(graph.project.root, graph, contextRef);
  } catch {}
  return resolveStoredContextRef(graph, contextRef, {
    getNodeDetails,
    getFlowContextCard: (current, flowId) => buildFlowContextCard(current, flowId, "all"),
    readDelta: (fromVersion, toVersion) => availableGraphDelta(graph, fromVersion, toVersion),
    deltaHistory: () => isPersistentGraphDeltaAvailable(graph) ? listGraphDeltaHistory(graph.project.root) : null,
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

function getCacheHygiene(graph) {
  return cacheHygiene(graph.project.root, graph);
}

function pruneDerivedArtifacts(graph, options = {}) {
  return pruneArtifactCache(graph.project.root, options);
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
  if (listed.status !== "available") return { schemaVersion: "flopeek-handoff-workspace-view/v1", status: "unavailable", workspace: null, notes: [], diagnostics: listed.diagnostics };
  const workspace = workspaceId ? listed.records.find((record) => record.id === workspaceId) : listed.current;
  if (!workspace) return { schemaVersion: "flopeek-handoff-workspace-view/v1", status: "missing", workspace: null, notes: [], diagnostics: [] };
  const notes = listStoredHandoffNotes(graph.project.root, graph, workspace.id);
  return { schemaVersion: "flopeek-handoff-workspace-view/v1", status: "available", workspace, notes: notes.records, diagnostics: notes.diagnostics };
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

function getEntryFlows(graph, entry = "", scope = "application") {
  const query = entry.trim().toLowerCase();
  const availableFlows = scope === "all" ? graph.diagnosticFlows || graph.flows : graph.flows;
  const flows = availableFlows.filter((flow) => !query || flow.title.toLowerCase().includes(query) || flow.entryId.toLowerCase().includes(query));
  const byFamily = {};
  for (const flow of flows) {
    const family = flow.entry?.family || "unknown";
    byFamily[family] = (byFamily[family] || 0) + 1;
  }
  return {
    query: entry || null,
    scope,
    flows,
    flowCatalog: flowCatalog(availableFlows, flows),
    entryFamilies: byFamily,
    limitation: "Flow steps are static graph traversal from supported detected entry facts. They do not prove command invocation, runtime order, dynamic execution, or business behavior.",
  };
}

function getRequestFlows(graph, endpoint = "", scope = "application") {
  return {
    ...getEntryFlows(graph, endpoint, scope),
    legacyAlias: "get_request_flows",
    limitation: "This legacy request-flow alias returns all supported static entry flows. Flow steps do not prove command invocation, runtime order, dynamic execution, or business behavior.",
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
        entry: entry ? { id: entry.id, label: entry.label, path: entry.path, evidence: entry.evidence || null, contextRef: lens.flow.entryContextRef, kind: lens.flow.entry?.kind || "unknown-static-entry" } : null,
        endpoint: entry?.kind === "endpoint" ? { id: entry.id, label: entry.label, path: entry.path, evidence: entry.evidence || null, contextRef: lens.flow.entryContextRef } : null,
        handler: handler ? { id: handler.id, label: handler.label, path: handler.path, evidence: handler.evidence || null } : null,
        handlerBinding: lens.handlerEvidence?.binding || "unknown",
      },
    };
  }).filter((item) => status === "all" || item.queueStatus === status)
    .sort((left, right) => left.flow.title.localeCompare(right.flow.title) || left.flow.id.localeCompare(right.flow.id));
  return {
    schemaVersion: "flopeek-semantic-review-queue/v1",
    status,
    endpointCount: graph.nodes.filter((node) => node.kind === "endpoint" && (node.sourceScope === "application" || !node.sourceScope)).length,
    entryCount: flows.length,
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
  return attachFlowExtensions(graph, lens);
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
    const resolution = resolveFlowVerification(graph.project.root, graph, lens, { readDelta: (fromVersion, toVersion) => availableGraphDelta(graph, fromVersion, toVersion) });
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
    schemaVersion: "flopeek-verified-semantic-memory/v1",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    storage: { kind: "verification-backed-index", relativePath: ".flopeek/flow-verifications.json", modelWeightsStored: false },
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

function createWorkRecord(graph, input) { return createStoredWorkRecord(graph.project.root, graph, input); }
function updateWorkPlan(graph, input) { return updateStoredWorkPlan(graph.project.root, graph, input); }
function recordWorkEvent(graph, input) { return recordStoredWorkEvent(graph.project.root, graph, input); }
function listWorkRecords(graph, options = {}) { return listStoredWorkRecords(graph.project.root, graph, options); }
function getWorkTimeline(graph, recordId = null) { return getStoredWorkTimeline(graph.project.root, graph, recordId); }
function listWorkflows(graph) { return listStoredWorkflows(graph.project.root); }
function saveWorkflow(graph, input) { return saveStoredWorkflow(graph.project.root, input); }
function assignWorkflow(graph, input) { return assignStoredWorkflow(graph.project.root, graph, input); }
function transitionWorkRecord(graph, input) { return transitionStoredWorkRecord(graph.project.root, graph, input); }
function getWorkRecordWorkflow(graph, recordId) { return getStoredWorkRecordWorkflow(graph.project.root, graph, recordId); }
function getWorkDependencyStatus(graph, recordId) { return getStoredWorkDependencyStatus(graph.project.root, graph, recordId); }
function listWorkDependencyStatuses(graph, options = {}) { return listStoredWorkDependencyStatuses(graph.project.root, graph, options); }
function createContinuationCheckpoint(graph, input) { return createStoredContinuationCheckpoint(graph.project.root, graph, input); }
function getContinuationCheckpoint(graph, checkpointId) { return getStoredContinuationCheckpoint(graph.project.root, graph, checkpointId); }
function listContinuationCheckpoints(graph) { return listStoredContinuationCheckpoints(graph.project.root, graph); }
function createPlannedOverlay(graph, input) {
  const result = createStoredPlannedOverlay(graph.project.root, graph, input);
  const projection = getStoredPlannedOverlay(graph.project.root, graph, result.overlay.id);
  return { ...result, overlay: projection.overlay, limitation: projection.limitation };
}
function getPlannedOverlay(graph, overlayId) { return getStoredPlannedOverlay(graph.project.root, graph, overlayId); }
function listPlannedOverlays(graph) { return listStoredPlannedOverlays(graph.project.root, graph); }
function resolvePlanRef(graph, planRef) { return resolveStoredPlanRef(graph.project.root, graph, planRef); }
function recordPlanReconciliation(graph, input) {
  const result = recordStoredPlanReconciliation(graph.project.root, graph, input);
  const projection = getStoredPlanReconciliation(graph.project.root, graph, result.reconciliation.id);
  return { ...result, reconciliation: projection.reconciliation, limitation: projection.limitation };
}
function getPlanReconciliation(graph, reconciliationId) { return getStoredPlanReconciliation(graph.project.root, graph, reconciliationId); }
function listPlanReconciliations(graph, options) { return listStoredPlanReconciliations(graph.project.root, graph, options); }
function getContinuationComparison(graph, options) { return compareStoredContinuation(graph.project.root, graph, options); }
function getCheckpointDivergence(graph, checkpointId) { return getStoredCheckpointDivergence(graph.project.root, graph, checkpointId); }
function getContinuationContext(graph, input) { return buildContinuationContext(graph.project.root, graph, input, { resolveContextRef: (contextRef) => resolveContextRef(graph, contextRef) }); }
function getActiveBranchGitEvidence(graph, contextRef, options = {}) {
  return buildActiveBranchGitEvidence(graph.project.root, graph, contextRef, {
    ...options,
    resolution: resolveContextRef(graph, contextRef),
  });
}
function getGitContextContinuity(graph, contextRef, options = {}) {
  return buildGitContextContinuity(graph.project.root, graph, contextRef, {
    ...options,
    resolution: resolveContextRef(graph, contextRef),
  });
}

function contextVersion(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isPersistentGraphDeltaAvailable(graph) {
  return Boolean(graph?.project?.projectId)
    && graph.analysis?.cacheState?.status !== "disabled"
    && graph.project?.identity?.source !== "session"
    && !String(graph.project.projectId).startsWith("session:");
}

function matchingGraphDelta(graph, delta) {
  return delta?.projectId === graph?.project?.projectId ? delta : null;
}

function availableGraphDelta(graph, fromGraphVersion, toGraphVersion) {
  const current = graph.analysis?.latestDelta;
  if (current?.projectId === graph.project.projectId
    && current.fromGraphVersion === fromGraphVersion
    && current.toGraphVersion === toGraphVersion) return current;
  if (!isPersistentGraphDeltaAvailable(graph)) return null;
  return matchingGraphDelta(graph, readGraphDelta(graph.project.root, fromGraphVersion, toGraphVersion));
}

function latestAvailableGraphDelta(graph) {
  const current = graph.analysis?.latestDelta;
  if (current?.projectId === graph.project.projectId
    && current.toGraphVersion === graph.state?.graphVersion) return current;
  if (!isPersistentGraphDeltaAvailable(graph)) return null;
  return matchingGraphDelta(graph, readLatestGraphDelta(graph.project.root, graph.state?.graphVersion));
}

function getChangedContexts(graph, options = {}) {
  const toGraphVersion = contextVersion(optionValue(options, "toVersion", graph.state.graphVersion), graph.state.graphVersion);
  const fromGraphVersion = contextVersion(optionValue(options, "fromVersion", toGraphVersion - 1), toGraphVersion - 1);
  const delta = availableGraphDelta(graph, fromGraphVersion, toGraphVersion);
  const base = {
    schemaVersion: "flopeek-changed-contexts/v1",
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
      limitation: "No retained adjacent delta exists for these graph versions. Flopeek does not reconstruct changed contexts from runtime behavior or arbitrary history.",
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
      changeScope: item.changeScope || (item.status === "source-changed" && (current || item.node).kind === "file" ? "file-content-only" : "node-structure"),
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
    limitation: "Changed contexts are bounded static evidence from one retained adjacent graph delta. A file-content-only context records an exact changed source file without claiming a declaration, static relationship, runtime behavior, or full historical Context Card.",
  };
}

function getRelatedImplementations(graph, contextRef, options = {}) {
  return buildRelatedImplementations(graph, contextRef, options);
}

function getFlowComparison(graph, flowId, options = {}) {
  const toGraphVersion = contextVersion(optionValue(options, "toVersion", graph.state.graphVersion), graph.state.graphVersion);
  const fromGraphVersion = contextVersion(optionValue(options, "fromVersion", toGraphVersion - 1), toGraphVersion - 1);
  const delta = availableGraphDelta(graph, fromGraphVersion, toGraphVersion);
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
  getActiveBranchGitEvidence,
  getGitContextContinuity,
  getArtifactCacheAudit,
  getCacheHygiene,
  getContextCard,
  getNodeDetails,
  attachNodeExtensions,
  getRelatedImplementations,
  getProjectHome,
  getProductProof,
  getHandoffQuality,
  getRuntimeEvidence,
  getTrustAnalytics,
  getRelatedTests,
  getChangeImpact,
  getGraphDelta,
  availableGraphDelta,
  latestAvailableGraphDelta,
  getChangedContexts,
  getFlowComparison,
  getFlowContextCard,
  attachNativeFlowContextCard,
  getFlowProjection,
  attachFlowExtensions,
  getFlowSuggestion,
  getFlowVerification,
  getVerifiedSemanticMemory,
  getTestRuns,
  createWorkRecord,
  updateWorkPlan,
  recordWorkEvent,
  listWorkRecords,
  getWorkTimeline,
  listWorkflows,
  saveWorkflow,
  assignWorkflow,
  transitionWorkRecord,
  getWorkRecordWorkflow,
  getWorkDependencyStatus,
  listWorkDependencyStatuses,
  createContinuationCheckpoint,
  getContinuationCheckpoint,
  listContinuationCheckpoints,
  createPlannedOverlay,
  getPlannedOverlay,
  listPlannedOverlays,
  resolvePlanRef,
  recordPlanReconciliation,
  getPlanReconciliation,
  listPlanReconciliations,
  getContinuationComparison,
  getCheckpointDivergence,
  getContinuationContext,
  getFlowVerificationHistory: getFlowVerificationHistoryForGraph,
  getDurableBrief,
  getHandoffContext,
  getHandoffWorkspace,
  getAgentEvidenceTraces,
  getAgentSemanticProposal,
  getSemanticSuggestionFeedback,
  getEntryFlows,
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
  attachNativeProjectOverview,
  attachLocalAgentContext,
  createAgentContextStatic,
  pruneDerivedArtifacts,
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
