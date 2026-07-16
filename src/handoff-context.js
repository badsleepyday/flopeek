"use strict";

const { createContextRef } = require("./context-card");
const { createDurableBrief, sourceBasis } = require("./durable-brief");
const { getFlowProjection } = require("./flow-lens");
const { readLatestGraphDelta } = require("./graph-state");
const { listHandoffWorkspaces } = require("./handoff-workspace");
const { runtimeEvidenceSummary } = require("./runtime-evidence");

const HANDOFF_CONTEXT_SCHEMA = "flowpeek-handoff-context/v1";
const TOKENIZER_ID = "flowpeek-char4-estimator/v1";
const MIN_TOKEN_BUDGET = 1024;
const MAX_TOKEN_BUDGET = 65536;
const DEPTH_LIMITS = Object.freeze({
  summary: { features: 2, flows: 3, tests: 1 },
  standard: { features: 5, flows: 8, tests: 4 },
  evidence: { features: 8, flows: 12, tests: 8 },
});

class HandoffContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HandoffContextError";
    this.code = code;
    this.statusCode = 400;
  }
}

function portablePath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) return null;
  return normalized;
}

function words(value) {
  return new Set(String(value || "").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) || []);
}

function overlapScore(left, right) {
  let score = 0;
  for (const token of left) if (right.has(token)) score += token.length > 3 ? 12 : 4;
  return score;
}

function featureKey(node) {
  return node.feature || node.domain || "project";
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function compactString(value, limit = 320) {
  if (typeof value !== "string" || value.length <= limit) return { value, truncated: false };
  return { value: `${value.slice(0, limit - 1)}…`, truncated: true };
}

function compactPathList(values, limit = 8) {
  const listed = values.slice(0, limit).map((value) => compactString(value, 200));
  return {
    total: values.length,
    items: listed.map((item) => item.value),
    itemsNotListed: Math.max(values.length - limit, 0),
    valuesTruncated: listed.filter((item) => item.truncated).length,
    reason: values.length > limit || listed.some((item) => item.truncated) ? "request-path-metadata-truncated-to-protect-the-context-budget" : null,
  };
}

function requestEnvelope(request) {
  const taskIntent = compactString(request.taskIntent);
  const targetFeature = compactString(request.targetFeature, 240);
  const targetFlow = compactString(request.targetFlow, 320);
  return {
    taskIntent: taskIntent.value,
    taskIntentCharacterCount: request.taskIntent.length,
    taskIntentTruncated: taskIntent.truncated,
    changedPaths: compactPathList(request.changedPaths),
    targetFeature: targetFeature.value,
    targetFeatureTruncated: targetFeature.truncated,
    targetFlow: targetFlow.value,
    targetFlowTruncated: targetFlow.truncated,
    tokenBudget: request.tokenBudget,
    desiredEvidenceDepth: request.desiredEvidenceDepth,
    tokenizerId: request.tokenizerId,
  };
}

function normalizeInput(input = {}) {
  const taskIntent = typeof input.taskIntent === "string" ? input.taskIntent.trim() : "";
  if (!taskIntent || taskIntent.length > 4000) throw new HandoffContextError("invalid-task-intent", "taskIntent must contain 1 to 4000 characters.");
  const tokenBudget = Number(input.tokenBudget ?? 4000);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < MIN_TOKEN_BUDGET || tokenBudget > MAX_TOKEN_BUDGET) {
    throw new HandoffContextError("invalid-token-budget", `tokenBudget must be an integer from ${MIN_TOKEN_BUDGET} to ${MAX_TOKEN_BUDGET}.`);
  }
  const desiredEvidenceDepth = input.desiredEvidenceDepth || input.evidenceDepth || "standard";
  if (!Object.hasOwn(DEPTH_LIMITS, desiredEvidenceDepth)) throw new HandoffContextError("invalid-evidence-depth", "desiredEvidenceDepth must be summary, standard, or evidence.");
  if (input.tokenizerId && input.tokenizerId !== TOKENIZER_ID) {
    throw new HandoffContextError("unsupported-tokenizer", `This build supports only the explicit deterministic estimator '${TOKENIZER_ID}'.`);
  }
  const changedInput = input.changedPaths === undefined ? [] : input.changedPaths;
  if (!Array.isArray(changedInput) || changedInput.length > 100) throw new HandoffContextError("invalid-changed-paths", "changedPaths must be an array with at most 100 repository-relative paths.");
  const normalizedPaths = changedInput.map(portablePath);
  if (normalizedPaths.some((item) => !item)) throw new HandoffContextError("unsafe-changed-path", "changedPaths must contain only safe repository-relative paths.");
  const changedPaths = uniqueSorted(normalizedPaths);
  const targetFeature = typeof input.targetFeature === "string" && input.targetFeature.trim() ? input.targetFeature.trim().replace(/^feature:/, "") : null;
  const targetFlow = typeof input.targetFlow === "string" && input.targetFlow.trim() ? input.targetFlow.trim() : null;
  if (targetFeature?.length > 2048 || targetFlow?.length > 4096) throw new HandoffContextError("invalid-target", "targetFeature or targetFlow exceeds the supported identifier length.");
  return { taskIntent, changedPaths, targetFeature, targetFlow, tokenBudget, desiredEvidenceDepth, tokenizerId: TOKENIZER_ID };
}

function featureCandidates(graph, request, intentWords, changedNodes) {
  const groups = new Map();
  for (const node of graph.nodes) {
    const key = featureKey(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return [...groups.entries()].map(([key, nodes]) => {
    let score = overlapScore(intentWords, words(`${key} ${nodes.map((node) => `${node.label} ${node.path || ""}`).join(" ")}`));
    const reasons = [];
    if (request.targetFeature === key) { score += 10000; reasons.push("exact-target-feature"); }
    const matchedPaths = uniqueSorted(nodes.filter((node) => changedNodes.has(node.id)).map((node) => node.path));
    if (matchedPaths.length) { score += 5000 + matchedPaths.length; reasons.push("contains-changed-path"); }
    if (score > 0 && !reasons.length) reasons.push("task-intent-token-overlap");
    return {
      id: `feature:${key}`,
      key,
      title: key.split("/").join(" · "),
      score,
      reasons,
      matchedPaths,
      nodeCount: nodes.length,
      endpointCount: nodes.filter((node) => node.kind === "endpoint").length,
      nodeIds: new Set(nodes.map((node) => node.id)),
    };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function flowCandidates(graph, request, intentWords, changedNodes, featuresByNode) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  return (graph.flows || []).map((flow) => {
    const stepIds = new Set((flow.steps || []).map((step) => step.id));
    stepIds.add(flow.entryId);
    const flowFeatures = uniqueSorted([...stepIds].map((id) => featuresByNode.get(id)));
    const labels = [...stepIds].map((id) => {
      const node = nodesById.get(id);
      return node ? `${node.label} ${node.path || ""}` : id;
    }).join(" ");
    let score = overlapScore(intentWords, words(`${flow.id} ${flow.title} ${flowFeatures.join(" ")} ${labels}`));
    const reasons = [];
    if (request.targetFlow === flow.id || request.targetFlow === flow.title) { score += 12000; reasons.push("exact-target-flow"); }
    if (request.targetFeature && flowFeatures.includes(request.targetFeature)) { score += 4000; reasons.push("target-feature-flow"); }
    const matchedPaths = uniqueSorted([...stepIds].filter((id) => changedNodes.has(id)).map((id) => nodesById.get(id)?.path));
    if (matchedPaths.length) { score += 6000 + matchedPaths.length; reasons.push("contains-changed-path"); }
    if (score > 0 && !reasons.length) reasons.push("task-intent-token-overlap");
    return { flow, score, reasons, matchedPaths, featureKeys: flowFeatures, stepIds };
  }).sort((left, right) => right.score - left.score || left.flow.id.localeCompare(right.flow.id));
}

function estimate(packet) {
  const estimatedCharacterCount = JSON.stringify(packet).length;
  return { estimatedCharacterCount, estimatedTokenCount: Math.ceil(estimatedCharacterCount / 4) };
}

function updateEstimate(packet) {
  for (let index = 0; index < 3; index += 1) Object.assign(packet.budget, estimate(packet));
  return packet;
}

function fits(packet, charLimit) {
  return JSON.stringify(packet).length <= charLimit - 256;
}

function omissionSummary(all, includedIds, reason) {
  const omitted = all.map((item) => item.id || item.flow?.id).filter((id) => !includedIds.has(id));
  return { total: all.length, included: includedIds.size, omitted: omitted.length, omittedIds: [], omittedIdsNotListed: omitted.length, reasons: omitted.length ? [reason] : [] };
}

function addReason(summary, reason) {
  if (!summary.reasons.includes(reason)) summary.reasons.push(reason);
}

function demoteIncludedItem(items, summary) {
  const item = items.pop();
  if (!item) return false;
  summary.included -= 1;
  summary.omitted += 1;
  summary.omittedIdsNotListed += 1;
  addReason(summary, "included-item-removed-to-respect-budget");
  addReason(summary, "omitted-id-list-truncated-to-respect-budget");
  return true;
}

function briefRef(graph, kind, id) {
  return createDurableBrief(graph, kind, id).briefRef;
}

function compactFlowTruncation(truncation) {
  if (!truncation) return null;
  const reasons = [truncation.displayTruncationReason, truncation.sourceTraversalTruncationReason];
  if (truncation.missingTransitionEvidence?.length) reasons.push("missing-transition-evidence");
  return {
    requestedMaxSteps: truncation.requestedMaxSteps,
    displayedSteps: truncation.displayedSteps,
    sourceFlowSteps: truncation.sourceFlowSteps,
    reasons: reasons.filter(Boolean),
  };
}

function flowItem(graph, candidate, depth) {
  const lens = getFlowProjection(graph, candidate.flow.id, "application") || getFlowProjection(graph, candidate.flow.id, "all");
  const confidenceReasons = [lens?.handlerEvidence?.binding || "static-flow-traversal"];
  if (lens?.handlerEvidence?.siblingHandlerContamination) confidenceReasons.push("sibling-handler-contamination");
  if (lens?.truncation?.sourceTraversalMayBeTruncated) confidenceReasons.push("source-traversal-truncated");
  const exactHandler = lens?.handlerEvidence?.binding === "exact-handler";
  const confidenceLevel = exactHandler && !lens.handlerEvidence.siblingHandlerContamination && !lens.truncation?.sourceTraversalMayBeTruncated
    ? "high"
    : lens?.handlerEvidence?.handlerId ? "medium" : "low";
  const evidenceRefs = [
    { kind: "flow-brief", ref: briefRef(graph, "flow", candidate.flow.id), evidenceClass: "deterministic-inference" },
    { kind: "entry-node", ref: createContextRef(graph.project.projectId, "node", candidate.flow.entryId, graph.state.graphVersion), evidenceClass: "static-parser-fact" },
  ];
  if (lens?.handlerEvidence?.handlerId) evidenceRefs.push({
    kind: "http-handler",
    ref: createContextRef(graph.project.projectId, "node", lens.handlerEvidence.handlerId, graph.state.graphVersion),
    evidenceClass: "static-parser-fact",
  });
  return {
    id: candidate.flow.id,
    title: candidate.flow.title,
    entryId: candidate.flow.entryId,
    featureKeys: candidate.featureKeys,
    relevance: { score: candidate.score, reasons: candidate.reasons },
    confidence: {
      level: confidenceLevel,
      reasons: confidenceReasons,
      runtimeClaim: false,
    },
    matchedPaths: candidate.matchedPaths,
    evidenceRefs: depth === "summary" ? evidenceRefs.slice(0, 1) : evidenceRefs,
    truncation: compactFlowTruncation(lens?.truncation),
  };
}

function featureItem(graph, candidate) {
  return {
    id: candidate.id,
    title: candidate.title,
    nodeCount: candidate.nodeCount,
    endpointCount: candidate.endpointCount,
    matchedPaths: candidate.matchedPaths,
    relevance: { score: candidate.score, reasons: candidate.reasons },
    evidenceRef: briefRef(graph, "feature", candidate.key),
  };
}

function relatedTests(graph, selectedFlows, selectedFeatures, intentWords) {
  const relevantNodeIds = new Set();
  const relevantFeatures = new Set(selectedFeatures.map((item) => item.key));
  for (const candidate of selectedFlows) for (const id of candidate.stepIds) relevantNodeIds.add(id);
  const connectedTests = new Set();
  for (const edge of graph.edges) {
    if (relevantNodeIds.has(edge.source)) connectedTests.add(edge.target);
    if (relevantNodeIds.has(edge.target)) connectedTests.add(edge.source);
  }
  return graph.nodes.filter((node) => node.type === "test" || node.kind === "test").map((node) => {
    let score = overlapScore(intentWords, words(`${node.label} ${node.path || ""}`));
    const reasons = [];
    if (connectedTests.has(node.id)) { score += 5000; reasons.push("direct-static-edge-to-selected-flow"); }
    if (relevantFeatures.has(featureKey(node))) { score += 1000; reasons.push("selected-feature"); }
    if (score > 0 && !reasons.length) reasons.push("task-intent-token-overlap");
    return { id: node.id, label: node.label, path: portablePath(node.path), score, reasons };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function packetConfidence(request, featureCandidatesList, flowCandidatesList, unmatchedPaths) {
  const reasons = [];
  if (request.targetFlow && flowCandidatesList.some((item) => item.reasons.includes("exact-target-flow"))) reasons.push("exact-target-flow");
  if (request.targetFeature && featureCandidatesList.some((item) => item.reasons.includes("exact-target-feature"))) reasons.push("exact-target-feature");
  if (request.changedPaths.length && unmatchedPaths.length === 0) reasons.push("all-changed-paths-matched");
  if (!reasons.length && (featureCandidatesList[0]?.score > 0 || flowCandidatesList[0]?.score > 0)) reasons.push("deterministic-token-overlap-only");
  if (unmatchedPaths.length) reasons.push("some-changed-paths-unmatched");
  const level = reasons.some((reason) => reason.startsWith("exact-") || reason === "all-changed-paths-matched")
    ? "high"
    : reasons.includes("deterministic-token-overlap-only") ? "medium" : "low";
  return { kind: "relevance-selection-confidence", level, reasons, evidenceClass: "deterministic-inference", runtimeClaim: false };
}

function createHandoffContext(graph, input = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new HandoffContextError("missing-graph-identity", "A current versioned graph is required.");
  const request = normalizeInput(input);
  const charLimit = request.tokenBudget * 4;
  const intentWords = words(request.taskIntent);
  const nodesByPath = new Map();
  const featuresByNode = new Map();
  for (const node of graph.nodes) {
    featuresByNode.set(node.id, featureKey(node));
    const nodePath = portablePath(node.path);
    if (!nodePath) continue;
    if (!nodesByPath.has(nodePath)) nodesByPath.set(nodePath, []);
    nodesByPath.get(nodePath).push(node);
  }
  const matchedPaths = request.changedPaths.filter((item) => nodesByPath.has(item));
  const unmatchedPaths = request.changedPaths.filter((item) => !nodesByPath.has(item));
  const changedNodes = new Set(matchedPaths.flatMap((item) => nodesByPath.get(item).map((node) => node.id)));
  const features = featureCandidates(graph, request, intentWords, changedNodes);
  const flows = flowCandidates(graph, request, intentWords, changedNodes, featuresByNode);
  const project = createDurableBrief(graph, "project");
  const runtimeEvidence = runtimeEvidenceSummary(graph.project.root, graph);
  const limits = DEPTH_LIMITS[request.desiredEvidenceDepth];
  const packet = {
    schemaVersion: HANDOFF_CONTEXT_SCHEMA,
    project: {
      projectIdentity: project.projectIdentity,
      name: project.title,
      sourceBasis: project.sourceBasis,
      graphVersion: project.graphVersion,
      freshnessStatus: project.freshnessStatus,
      evidenceClass: project.evidenceClass,
      summary: { stats: project.sections.parserFacts.stats, parserCoverage: project.sections.parserFacts.coverage },
      briefRef: project.briefRef,
    },
    request: requestEnvelope(request),
    confidence: packetConfidence(request, features, flows, unmatchedPaths),
    included: { handoffWorkspace: null, features: [], flows: [], tests: [], evidenceRefs: [], relevantDeltas: [] },
    omitted: { handoffWorkspace: { total: 0, included: 0, omitted: 0, reasons: ["no-local-handoff-workspace"] } },
    pathResolution: { matched: compactPathList(matchedPaths), unmatched: compactPathList(unmatchedPaths) },
    risks: ["Static parser facts and deterministic inference do not prove runtime behavior."],
    nextSafeInspectionSteps: ["Resolve the returned Context Refs against the current graph before changing code."],
    budget: {
      requestedTokenBudget: request.tokenBudget,
      tokenizerId: TOKENIZER_ID,
      tokenizerModel: null,
      estimation: "approximate-character-fallback",
      characterCountMethod: "javascript-string-length/v1",
      characterBudget: charLimit,
      estimatedCharacterCount: 0,
      estimatedTokenCount: 0,
      status: "within-budget",
    },
    limitations: ["No source-file body, credential, shell access, private reasoning, or machine-specific absolute path is included."],
  };

  const handoffWorkspaces = listHandoffWorkspaces(graph.project.root, graph);
  if (runtimeEvidence.status === "available") packet.included.runtimeEvidence = runtimeEvidence;
  if (handoffWorkspaces.status === "available" && handoffWorkspaces.current) {
    const workspace = handoffWorkspaces.current;
    const purpose = compactString(workspace.content.purpose?.text || null);
    packet.included.handoffWorkspace = {
      id: workspace.id,
      freshnessStatus: workspace.freshnessStatus,
      graphVersion: workspace.graphVersion,
      evidenceClass: workspace.evidenceClass,
      purpose: purpose.value,
      purposeTruncated: purpose.truncated,
      criticalFlowCount: workspace.content.criticalFlows.length,
      riskCount: workspace.content.risks.length,
      unresolvedQuestionCount: workspace.content.unresolvedQuestions.length,
      evidenceRefs: uniqueSorted([
        ...workspace.content.criticalFlows.flatMap((item) => item.selection.evidenceRefs || []),
        ...workspace.content.recommendedStartingPoints.flatMap((item) => item.evidenceRefs || []),
      ]).slice(0, 8),
    };
    packet.omitted.handoffWorkspace = { total: 1, included: 1, omitted: 0, reasons: [] };
    if (!fits(packet, charLimit)) {
      packet.included.handoffWorkspace = null;
      packet.omitted.handoffWorkspace = { total: 1, included: 0, omitted: 1, reasons: ["token-budget-limit"] };
    }
  } else if (handoffWorkspaces.status === "unavailable") {
    packet.omitted.handoffWorkspace.reasons = ["local-handoff-workspace-unavailable"];
  }

  const selectedFeatureCandidates = [];
  for (const candidate of features.slice(0, limits.features)) {
    const item = featureItem(graph, candidate);
    packet.included.features.push(item);
    if (!fits(packet, charLimit)) { packet.included.features.pop(); continue; }
    selectedFeatureCandidates.push(candidate);
  }
  const selectedFlowCandidates = [];
  for (const candidate of flows.slice(0, limits.flows)) {
    const item = flowItem(graph, candidate, request.desiredEvidenceDepth);
    packet.included.flows.push(item);
    if (!fits(packet, charLimit)) { packet.included.flows.pop(); continue; }
    selectedFlowCandidates.push(candidate);
  }
  const tests = relatedTests(graph, selectedFlowCandidates, selectedFeatureCandidates, intentWords);
  for (const candidate of tests.slice(0, limits.tests)) {
    const item = {
      id: candidate.id,
      label: candidate.label,
      path: candidate.path,
      relevance: { score: candidate.score, reasons: candidate.reasons },
      contextRef: createContextRef(graph.project.projectId, "node", candidate.id, graph.state.graphVersion),
      evidenceClass: "static-parser-fact",
    };
    packet.included.tests.push(item);
    if (!fits(packet, charLimit)) packet.included.tests.pop();
  }
  const refs = uniqueSorted([
    project.briefRef,
    ...packet.included.features.map((item) => item.evidenceRef),
    ...packet.included.flows.flatMap((item) => item.evidenceRefs.map((ref) => ref.ref)),
    ...packet.included.tests.map((item) => item.contextRef),
  ]);
  for (const ref of refs) {
    packet.included.evidenceRefs.push(ref);
    if (!fits(packet, charLimit)) packet.included.evidenceRefs.pop();
  }
  const delta = readLatestGraphDelta(graph.project.root, graph.state.graphVersion);
  if (delta) {
    packet.included.relevantDeltas.push({
      fromGraphVersion: delta.fromGraphVersion,
      toGraphVersion: delta.toGraphVersion,
      reason: delta.reason,
      sourceChanged: delta.sourceChanged,
      topologyChanged: delta.topologyChanged,
      changedPaths: (delta.changedPaths || []).filter((item) => !request.changedPaths.length || request.changedPaths.includes(item)),
      evidenceClass: "static-parser-fact",
    });
    if (!fits(packet, charLimit)) packet.included.relevantDeltas.pop();
  }

  const includedFeatureIds = new Set(packet.included.features.map((item) => item.id));
  const includedFlowIds = new Set(packet.included.flows.map((item) => item.id));
  const includedTestIds = new Set(packet.included.tests.map((item) => item.id));
  packet.omitted.features = omissionSummary(features, includedFeatureIds, "token-budget-or-evidence-depth-limit");
  packet.omitted.flows = omissionSummary(flows, includedFlowIds, "token-budget-or-evidence-depth-limit");
  packet.omitted.tests = omissionSummary(tests, includedTestIds, "token-budget-or-evidence-depth-limit");
  const omittedGroups = [
    [packet.omitted.features, features.map((item) => item.id).filter((id) => !includedFeatureIds.has(id))],
    [packet.omitted.flows, flows.map((item) => item.flow.id).filter((id) => !includedFlowIds.has(id))],
    [packet.omitted.tests, tests.map((item) => item.id).filter((id) => !includedTestIds.has(id))],
  ];
  for (const [summary, ids] of omittedGroups) {
    for (const id of ids) {
      summary.omittedIds.push(id);
      summary.omittedIdsNotListed -= 1;
      if (!fits(packet, charLimit)) { summary.omittedIds.pop(); summary.omittedIdsNotListed += 1; break; }
    }
    if (summary.omittedIdsNotListed > 0) summary.reasons.push("omitted-id-list-truncated-to-respect-budget");
  }
  if (unmatchedPaths.length) packet.risks.push("Some requested changed paths were not found in the current graph.");
  if (request.targetFeature && !features.some((item) => item.reasons.includes("exact-target-feature"))) packet.risks.push("The requested target feature was not found exactly; ranking uses weaker deterministic signals.");
  if (request.targetFlow && !flows.some((item) => item.reasons.includes("exact-target-flow"))) packet.risks.push("The requested target flow was not found exactly; ranking uses weaker deterministic signals.");
  if (packet.omitted.features.omitted || packet.omitted.flows.omitted || packet.omitted.tests.omitted) packet.risks.push("The packet is intentionally truncated; inspect omitted IDs progressively if needed.");
  if (sourceBasis(graph).kind === "unavailable") packet.risks.push("Source freshness cannot be established for this graph.");
  if (packet.included.flows.length) packet.nextSafeInspectionSteps.push("Start from the highest-ranked flow and inspect its exact entry and handler evidence refs.");
  if (packet.included.tests.length) packet.nextSafeInspectionSteps.push("Inspect the listed tests, then run the repository's own relevant verification after any change.");

  updateEstimate(packet);
  while (packet.budget.estimatedCharacterCount > charLimit) {
    if (packet.omitted.tests.omittedIds.length) {
      packet.omitted.tests.omittedIds.pop();
      packet.omitted.tests.omittedIdsNotListed += 1;
      addReason(packet.omitted.tests, "omitted-id-list-truncated-to-respect-budget");
    } else if (packet.omitted.flows.omittedIds.length) {
      packet.omitted.flows.omittedIds.pop();
      packet.omitted.flows.omittedIdsNotListed += 1;
      addReason(packet.omitted.flows, "omitted-id-list-truncated-to-respect-budget");
    } else if (packet.omitted.features.omittedIds.length) {
      packet.omitted.features.omittedIds.pop();
      packet.omitted.features.omittedIdsNotListed += 1;
      addReason(packet.omitted.features, "omitted-id-list-truncated-to-respect-budget");
    } else if (packet.included.evidenceRefs.length) packet.included.evidenceRefs.pop();
    else if (packet.included.relevantDeltas.length) packet.included.relevantDeltas.pop();
    else if (demoteIncludedItem(packet.included.tests, packet.omitted.tests)) {}
    else if (demoteIncludedItem(packet.included.flows, packet.omitted.flows)) {}
    else if (demoteIncludedItem(packet.included.features, packet.omitted.features)) {}
    else if (packet.included.handoffWorkspace) {
      packet.included.handoffWorkspace = null;
      packet.omitted.handoffWorkspace = { total: 1, included: 0, omitted: 1, reasons: ["included-item-removed-to-respect-budget"] };
    }
    else if (packet.nextSafeInspectionSteps.length > 1) packet.nextSafeInspectionSteps.pop();
    else if (packet.risks.length > 1) packet.risks.pop();
    else break;
    updateEstimate(packet);
  }
  packet.budget.status = packet.budget.estimatedCharacterCount <= charLimit ? "within-budget" : "minimum-envelope-exceeded";
  return updateEstimate(packet);
}

module.exports = {
  HANDOFF_CONTEXT_SCHEMA,
  HandoffContextError,
  MAX_TOKEN_BUDGET,
  MIN_TOKEN_BUDGET,
  TOKENIZER_ID,
  createHandoffContext,
  normalizeInput,
};
