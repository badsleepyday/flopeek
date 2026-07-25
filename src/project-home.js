"use strict";

const { createContextRef, parseContextRef } = require("./context-card");
const { createDurableBrief, sourceBasis } = require("./durable-brief");
const { readLatestGraphDelta } = require("./graph-state");
const { listHandoffWorkspaces } = require("./handoff-workspace");

const PROJECT_HOME_SCHEMA = "flowpeek-project-home/v1";
const CONCEPT_INDEX_SCHEMA = "flowpeek-concept-index/v1";
const CONCEPT_TERMS = Object.freeze({
  authentication: ["auth", "authentication", "login", "logout", "session", "signin", "signout", "me"],
  payments: ["payment", "payments", "pay", "settlement", "settle", "ledger", "transaction", "invoice"],
  invitation: ["invite", "invitation", "join", "redeem", "accept"],
  reconciliation: ["reconcile", "reconciliation", "balance", "settlement", "ledger"],
  notifications: ["notification", "notifications", "notify", "reminder", "remind", "email", "push", "pusher"],
});

function tokens(value) {
  return new Set(String(value || "").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) || []);
}

function nodeFeature(node) {
  return node.feature || node.domain || "project";
}

function applicationNodes(graph) {
  if (!graph.nodes.some((node) => node.sourceScope)) return graph.nodes;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const included = new Set(graph.nodes.filter((node) => node.sourceScope === "application").map((node) => node.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges || []) {
      for (const [knownId, candidateId] of [[edge.source, edge.target], [edge.target, edge.source]]) {
        const candidate = byId.get(candidateId);
        if (!included.has(knownId) || included.has(candidateId) || candidate?.sourceScope) continue;
        included.add(candidateId);
        changed = true;
      }
    }
  }
  return graph.nodes.filter((node) => included.has(node.id));
}

function boundedCatalog(items, returned, idOf = (item) => item.id) {
  const includedIds = returned.map(idOf);
  const omittedIds = items.slice(returned.length).map(idOf);
  return {
    total: items.length,
    returned: returned.length,
    omitted: omittedIds.length,
    includedIds,
    omittedIds,
    truncated: omittedIds.length > 0,
    reason: omittedIds.length ? `Returned ${returned.length} of ${items.length} deterministically ordered entries; omitted IDs are listed explicitly.` : null,
  };
}

function matchReasons(fields, terms) {
  const reasons = [];
  for (const [field, value] of Object.entries(fields)) {
    const fieldTokens = tokens(value);
    for (const term of terms) if (fieldTokens.has(term)) reasons.push(`matched '${term}' in ${field}`);
  }
  return [...new Set(reasons)].sort();
}

function conceptTagsBySubject(workspace) {
  const nodeTags = new Map();
  const flowTags = new Map();
  for (const item of workspace?.content?.conceptTags || []) {
    try {
      const parsed = parseContextRef(item.subjectRef);
      if (parsed.kind === "node") nodeTags.set(parsed.contextId, item.tags || []);
      if (parsed.kind === "flow") flowTags.set(parsed.contextId, item.tags || []);
    } catch {}
  }
  return { nodeTags, flowTags };
}

function conceptIndex(graph, tags = { nodeTags: new Map(), flowTags: new Map() }) {
  const concepts = Object.entries(CONCEPT_TERMS).map(([concept, terms]) => {
    const nodes = applicationNodes(graph).map((node) => {
      const reasons = matchReasons({ label: node.label, path: node.path, feature: nodeFeature(node), route: node.kind === "endpoint" ? node.label : null, humanTag: (tags.nodeTags.get(node.id) || []).join(" "), type: node.type }, terms);
      return reasons.length ? {
        kind: "node",
        id: node.id,
        label: node.label,
        path: node.path || null,
        score: reasons.length,
        reasons,
        evidenceClass: "static-parser-fact",
        freshnessStatus: "current",
        contextRef: createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion),
      } : null;
    }).filter(Boolean);
    const flows = (graph.flows || []).map((flow) => {
      const reasons = matchReasons({ title: flow.title, route: flow.title, id: flow.id, humanTag: (tags.flowTags.get(flow.id) || []).join(" ") }, terms);
      return reasons.length ? {
        kind: "flow",
        id: flow.id,
        label: flow.title,
        path: null,
        score: reasons.length,
        reasons,
        evidenceClass: "deterministic-inference",
        freshnessStatus: "current",
        contextRef: createContextRef(graph.project.projectId, "flow", flow.id, graph.state.graphVersion),
      } : null;
    }).filter(Boolean);
    const results = [...nodes, ...flows].sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    return { concept, terms, total: results.length, results };
  });
  return {
    schemaVersion: CONCEPT_INDEX_SCHEMA,
    evidenceClass: "deterministic-inference",
    graphVersion: graph.state.graphVersion,
    concepts,
    policy: "Results cover application-scoped nodes and flows, require exact deterministic token matches across parser labels, route/path metadata, and optional human-authored tags, and list every matched term and field. They do not infer business meaning or runtime behavior.",
  };
}

function selectedConcept(index, query) {
  if (!query) return null;
  const normalized = String(query).trim().toLocaleLowerCase("en-US");
  const exact = index.concepts.find((item) => item.concept === normalized);
  if (exact) return { ...exact, status: "available", matchMode: "canonical" };
  const queryTerms = [...tokens(normalized)];
  const matchedConcepts = index.concepts.filter((concept) => queryTerms.some((term) => concept.terms.includes(term)));
  if (matchedConcepts.length > 1) return { status: "abstained", matchMode: "ambiguous-alias", concept: normalized, terms: queryTerms, total: 0, results: [], matchingConcepts: matchedConcepts.map((item) => item.concept), reason: "The query maps to more than one deterministic concept; select a canonical concept instead." };
  const results = matchedConcepts.flatMap((concept) => concept.results.map((result) => ({ ...result, concept: concept.concept })))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return matchedConcepts.length
    ? { status: "available", matchMode: "exact-synonym", concept: normalized, terms: queryTerms, total: results.length, results }
    : { status: "unavailable", matchMode: "none", concept: normalized, terms: queryTerms, total: 0, results: [], reason: "The query is not in the deterministic concept vocabulary." };
}

function statementCard(statement, freshnessStatus) {
  if (!statement || statement.status !== "available") return { status: "unavailable", text: null, evidenceClass: "human-authored", freshnessStatus, graphVersion: statement?.graphVersion || null, evidenceRefs: [], reason: statement?.reason || "No human-authored statement has been recorded." };
  return { status: "available", text: statement.text, evidenceClass: statement.evidenceClass, freshnessStatus, graphVersion: statement.graphVersion, evidenceRefs: statement.evidenceRefs || [], author: statement.author, createdAt: statement.createdAt };
}

function featureMap(graph) {
  const groups = new Map();
  for (const node of applicationNodes(graph)) {
    const key = nodeFeature(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return [...groups.entries()].map(([key, nodes]) => {
    const sorted = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
    const evidenceRefs = sorted.slice(0, 8).map((node) => createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion));
    return {
      id: `feature:${key}`,
      title: key.split("/").join(" · "),
      nodeCount: nodes.length,
      endpointCount: nodes.filter((node) => node.kind === "endpoint").length,
      evidenceClass: "deterministic-inference",
      freshnessStatus: "current",
      briefRef: createDurableBrief(graph, "feature", key).briefRef,
      evidenceRefs,
      evidenceRefCatalog: { ...boundedCatalog(sorted, sorted.slice(0, 8)), reason: nodes.length > evidenceRefs.length ? "Feature card retains eight exact node refs; omitted node IDs are listed explicitly and the Feature Brief provides the bounded facts." : null },
    };
  }).sort((left, right) => right.endpointCount - left.endpointCount || right.nodeCount - left.nodeCount || left.id.localeCompare(right.id));
}

function readiness(workspace) {
  const checks = [
    ["purpose", workspace?.content.purpose?.status === "available"],
    ["architecture-summary", workspace?.content.architectureSummary?.status === "available"],
    ["critical-flows", Boolean(workspace?.content.criticalFlows?.length)],
    ["owners", Boolean(workspace?.content.owners?.length)],
    ["risks", Boolean(workspace?.content.risks?.length)],
    ["known-limitations", Boolean(workspace?.content.knownLimitations?.length)],
    ["related-tests", Boolean(workspace?.content.relatedTests?.length)],
    ["starting-points", Boolean(workspace?.content.recommendedStartingPoints?.length)],
  ].map(([id, complete]) => ({ id, complete }));
  const complete = checks.filter((item) => item.complete).length;
  return { label: "documentation-completeness", complete, total: checks.length, percentage: Math.round((complete / checks.length) * 100), checks, limitation: "This measures presence of handoff fields, not correctness, runtime coverage, team approval, or delivery readiness." };
}

function projectHome(graph, options = {}) {
  const workspaces = listHandoffWorkspaces(graph.project.root, graph);
  const workspace = workspaces.current;
  const freshnessStatus = workspace?.freshnessStatus || "unavailable";
  const delta = readLatestGraphDelta(graph.project.root, graph.state.graphVersion);
  const index = conceptIndex(graph, conceptTagsBySubject(workspace));
  const allFeatures = featureMap(graph);
  const coverageSummary = graph.analysis?.coverage?.summary || null;
  const scannedFiles = Number(coverageSummary?.scannedFiles || 0);
  const features = allFeatures.slice(0, 24);
  const criticalFlows = workspace?.content.criticalFlows || [];
  const changedFlows = (delta?.affectedContexts?.flows || []).map((item) => ({
    id: item.flow.id,
    title: item.flow.title,
    status: item.status,
    evidenceClass: "static-parser-fact",
    freshnessStatus: "current",
    graphVersion: graph.state.graphVersion,
    contextRef: createContextRef(graph.project.projectId, "flow", item.flow.id, item.status === "removed" ? delta.fromGraphVersion : graph.state.graphVersion),
  }));
  const workspaceStarts = workspace?.content.recommendedStartingPoints || [];
  const flowStartCandidates = [...(graph.flows || [])].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const startCandidates = flowStartCandidates.length
    ? flowStartCandidates.map((flow) => ({ kind: "flow", id: flow.id, title: flow.title, evidenceRef: createContextRef(graph.project.projectId, "flow", flow.id, graph.state.graphVersion) }))
    : allFeatures.map((feature) => ({ kind: "feature", id: feature.id, title: feature.title, evidenceRef: feature.evidenceRefs[0] })).filter((item) => item.evidenceRef);
  const deterministicStarts = workspaceStarts.length ? [] : startCandidates.slice(0, 5).map((candidate) => ({
    status: "available",
    text: candidate.kind === "flow" ? `Inspect detected application flow ${candidate.title}.` : `Start with the ${candidate.title} feature area.`,
    evidenceClass: "deterministic-inference",
    freshnessStatus: "current",
    graphVersion: graph.state.graphVersion,
    evidenceRefs: [candidate.evidenceRef],
    reason: `No human-authored starting point exists; this fallback is ordered deterministically by the current ${candidate.kind} catalog.`,
  }));
  return {
    schemaVersion: PROJECT_HOME_SCHEMA,
    projectIdentity: { projectId: graph.project.projectId },
    sourceBasis: sourceBasis(graph),
    graphVersion: graph.state.graphVersion,
    freshnessStatus: sourceBasis(graph).value ? "current" : "unavailable",
    purpose: statementCard(workspace?.content.purpose, freshnessStatus),
    architectureOverview: statementCard(workspace?.content.architectureSummary, freshnessStatus),
    featureMap: { status: "available", evidenceClass: "deterministic-inference", freshnessStatus: "current", total: allFeatures.length, returned: features.length, items: features, catalog: boundedCatalog(allFeatures, features) },
    criticalFlows: { status: criticalFlows.length ? "available" : "unavailable", evidenceClass: "human-authored", freshnessStatus, total: criticalFlows.length, items: criticalFlows, reason: criticalFlows.length ? null : "No human-authored critical-flow selection exists." },
    recentlyChangedFlows: { status: delta ? "available" : "unavailable", evidenceClass: "static-parser-fact", freshnessStatus: delta ? "current" : "unavailable", total: changedFlows.length, items: changedFlows, reason: delta ? null : "No retained adjacent graph delta is available." },
    reReviewImpact: options.reviewImpact || { status: "unavailable", evidenceClass: "human-verification", freshnessStatus: "unavailable", total: 0, counts: {}, items: [], reason: "Review impact is unavailable outside the graph service." },
    sourceAvailability: scannedFiles > 0
      ? { status: "available", evidenceClass: "static-parser-fact", freshnessStatus: "current", scannedFiles, reason: null }
      : { status: "unavailable", evidenceClass: "static-parser-fact", freshnessStatus: "current", scannedFiles: 0, reason: "No supported source files were detected within the configured repository scope; this empty graph is not evidence of an empty project." },
    parserCoverage: { status: scannedFiles > 0 ? "available" : "unavailable", evidenceClass: "static-parser-fact", freshnessStatus: "current", summary: coverageSummary, adapterRegistry: graph.analysis?.adapterCapabilities?.schemaVersion || null, reason: scannedFiles > 0 ? null : "No supported source files were detected within the configured repository scope." },
    trustBoundaries: {
      status: "available",
      evidenceClass: "deterministic-inference",
      freshnessStatus: "current",
      items: ["Static evidence does not prove runtime behavior.", "Semantic labels remain deterministic suggestions unless separately human-authored or verified.", "Imported handoffs remain foreign, read-only, and unverified.", "Stale derived cache artifacts are never silently reused.", ...(graph.project?.git?.availability === "unavailable" && graph.project.git.reason ? [graph.project.git.reason] : [])],
    },
    handoffReadiness: readiness(workspace),
    unresolvedQuestions: { status: workspace?.content.unresolvedQuestions?.length ? "available" : "unavailable", evidenceClass: "human-authored", freshnessStatus, items: workspace?.content.unresolvedQuestions || [] },
    recommendedStartingPoints: {
      status: workspaceStarts.length || deterministicStarts.length ? "available" : "unavailable",
      evidenceClass: workspaceStarts.length ? "human-authored" : "deterministic-inference",
      freshnessStatus: workspaceStarts.length ? freshnessStatus : "current",
      items: workspaceStarts.length ? workspaceStarts : deterministicStarts,
      catalog: workspaceStarts.length
        ? boundedCatalog(workspaceStarts, workspaceStarts, (item) => item.id || item.text)
        : { ...boundedCatalog(startCandidates, startCandidates.slice(0, deterministicStarts.length)), reason: startCandidates.length > deterministicStarts.length ? `Fallback starting recommendations retain five deterministic ${flowStartCandidates.length ? "flow" : "feature"} entries; omitted IDs are listed explicitly.` : null },
    },
    conceptIndex: index,
    conceptSearch: selectedConcept(index, options.concept),
  };
}

module.exports = { CONCEPT_INDEX_SCHEMA, CONCEPT_TERMS, PROJECT_HOME_SCHEMA, conceptIndex, projectHome };
