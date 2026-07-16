"use strict";

const { getFlowProjection } = require("./flow-lens");
const { DEFAULT_FLOW_LENS_MAX_STEPS } = require("./flow-lens-options");

const TRUST_ANALYTICS_SCHEMA = "flowpeek-trust-analytics/v1";
const DEFAULT_TRUST_ANALYTICS_MAX_FLOWS = 200;

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function countBy(items, value) {
  const counts = {};
  for (const item of items || []) {
    const key = value(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function catalog(listing, recordsKey) {
  const records = listing?.[recordsKey] || [];
  return {
    status: listing?.status || "unavailable",
    total: Number(listing?.totalMatched ?? records.length),
    returned: Number(listing?.returned ?? records.length),
    truncated: Boolean(listing?.truncated),
    countScope: listing?.truncated ? "returned-records" : "complete-matched-catalog",
    byStatus: countBy(records, (record) => record.status),
  };
}

function testRelationships(graph) {
  const testIds = new Set((graph.nodes || [])
    .filter((node) => node.kind === "test" || node.type === "test" || node.sourceScope === "test")
    .map((node) => node.id));
  const relatedByNode = new Map();
  for (const edge of graph.edges || []) {
    if (testIds.has(edge.target)) {
      if (!relatedByNode.has(edge.source)) relatedByNode.set(edge.source, new Set());
      relatedByNode.get(edge.source).add(edge.target);
    }
    if (testIds.has(edge.source)) {
      if (!relatedByNode.has(edge.target)) relatedByNode.set(edge.target, new Set());
      relatedByNode.get(edge.target).add(edge.source);
    }
  }
  return relatedByNode;
}

function flowTestEvidence(flow, relatedByNode) {
  const related = new Set();
  for (const step of flow?.steps || []) {
    for (const testId of relatedByNode.get(step.id) || []) related.add(testId);
  }
  return related.size;
}

function parserCoverage(graph) {
  const summary = graph.analysis?.coverage?.summary || {};
  const scanned = Number(summary.scannedFiles ?? graph.stats?.scannedFiles ?? 0);
  const parsed = Number(summary.parsedFiles ?? graph.stats?.parsedFiles ?? 0);
  const parsedWithDiagnostics = Number(summary.parsedWithDiagnosticsFiles || 0);
  const inventoryOnly = Number(summary.inventoryOnlyFiles ?? graph.stats?.inventoryOnlyFiles ?? 0);
  const parseFailed = Number(summary.parseFailedFiles ?? graph.stats?.parseFailedFiles ?? 0);
  return {
    evidenceClass: "static-parser-coverage",
    scannedFiles: scanned,
    parsedFiles: parsed,
    parsedWithDiagnosticsFiles: parsedWithDiagnostics,
    inventoryOnlyFiles: inventoryOnly,
    parseFailedFiles: parseFailed,
    structuralParseRatio: ratio(parsed, scanned),
    byLanguage: graph.analysis?.coverage?.byLanguage || [],
    interpretation: "Structural parse coverage describes which scanned files produced syntax-tree facts. It is not relationship precision, runtime coverage, or business-flow coverage.",
  };
}

function flowEvidence(graph, options) {
  const maxSteps = options.maxSteps || DEFAULT_FLOW_LENS_MAX_STEPS;
  const flows = graph.flows || [];
  const maxFlows = Math.max(1, Math.min(Number(options.maxFlows) || DEFAULT_TRUST_ANALYTICS_MAX_FLOWS, 2_000));
  const evaluatedCatalog = flows.slice(0, maxFlows);
  const relatedTestsByNode = testRelationships(graph);
  let evaluatedFlows = 0;
  let displayedTransitions = 0;
  let directParserEvidenceTransitions = 0;
  let missingEvidenceTransitions = 0;
  let displayTruncatedFlows = 0;
  let sourceTraversalBoundedFlows = 0;
  let flowsWithDirectRelatedTests = 0;
  const byConfidence = {};

  for (const flow of evaluatedCatalog) {
    const lens = getFlowProjection(graph, flow.id, "application", { maxSteps });
    if (!lens) continue;
    evaluatedFlows += 1;
    byConfidence[lens.confidence] = (byConfidence[lens.confidence] || 0) + 1;
    if (lens.truncation?.displayTruncated) displayTruncatedFlows += 1;
    if (lens.truncation?.sourceTraversalMayBeTruncated) sourceTraversalBoundedFlows += 1;
    if (flowTestEvidence(flow, relatedTestsByNode) > 0) flowsWithDirectRelatedTests += 1;
    for (const step of lens.steps.slice(1)) {
      displayedTransitions += 1;
      if (step.transition?.evidence?.parser && step.transition?.evidence?.file) directParserEvidenceTransitions += 1;
      else missingEvidenceTransitions += 1;
    }
  }

  return {
    evidenceClass: "bounded-static-flow-evidence",
    applicationFlows: flows.length,
    evaluatedFlows,
    catalog: {
      total: flows.length,
      returned: evaluatedCatalog.length,
      omitted: Math.max(flows.length - evaluatedCatalog.length, 0),
      truncated: flows.length > evaluatedCatalog.length,
      maximumEvaluatedFlows: maxFlows,
    },
    requestedMaxStepsPerFlow: maxSteps,
    displayedTransitions,
    directParserEvidenceTransitions,
    missingEvidenceTransitions,
    directEvidenceRatio: ratio(directParserEvidenceTransitions, displayedTransitions),
    flowsWithDirectRelatedTests,
    directRelatedTestAvailabilityRatio: ratio(flowsWithDirectRelatedTests, evaluatedFlows),
    displayTruncatedFlows,
    sourceTraversalBoundedFlows,
    byConfidence,
    interpretation: "Counts cover the explicitly bounded evaluated subset of the current static Application Flow Lens catalog. Direct parser evidence supports a stored static relationship only; it does not prove runtime order, side effects, or business meaning.",
  };
}

function cacheFreshness(cache) {
  const records = cache?.records || [];
  const current = records.filter((record) => record.freshnessStatus === "current").length;
  const stale = records.filter((record) => record.freshnessStatus === "stale").length;
  const events = Number(cache?.counts?.hits || 0) + Number(cache?.counts?.misses || 0);
  return {
    status: cache?.status || "unavailable",
    currentArtifacts: current,
    staleArtifacts: stale,
    currentArtifactRatio: ratio(current, records.length),
    retainedArtifacts: records.length,
    events: cache?.counts || { hits: 0, misses: 0, invalidated: 0, retainedUnaffected: 0 },
    observedHitRatio: ratio(Number(cache?.counts?.hits || 0), events),
    eventCatalog: cache?.eventCatalog || { total: 0, returned: 0, omitted: 0, truncated: false },
    interpretation: "Cache ratios describe retained derived artifacts and bounded audit events. They are performance and freshness diagnostics, not correctness metrics.",
  };
}

function humanVerification(reviewImpact, totalFlows) {
  const counts = reviewImpact?.counts || { current: 0, compatible: 0, stale: 0, detached: 0, unavailable: 0, missing: totalFlows };
  const reusable = Number(counts.current || 0) + Number(counts.compatible || 0);
  return {
    evidenceClass: "human-verification-metadata",
    status: reviewImpact?.status || "unavailable",
    totalFlows,
    counts,
    reusableCurrentOrCompatible: reusable,
    reusableCoverageRatio: ratio(reusable, totalFlows),
    interpretation: "Current or compatible verification means a person reviewed the bounded static Flow Lens metadata. It does not prove runtime behavior, business approval, or test success.",
  };
}

function buildTrustAnalytics(graph, inputs = {}, options = {}) {
  const feedback = catalog(inputs.semanticFeedback, "records");
  feedback.byDecision = countBy(inputs.semanticFeedback?.records, (record) => record.decision);
  delete feedback.byStatus;
  const traces = catalog(inputs.agentEvidenceTraces, "records");
  traces.byVerificationStatus = countBy(inputs.agentEvidenceTraces?.records, (record) => record.verification?.status);
  delete traces.byStatus;
  const testRuns = catalog(inputs.testRuns, "runs");
  const runtime = inputs.runtimeEvidence || { status: "unavailable", evidenceClass: "runtime-evidence", reason: "No runtime evidence summary was supplied." };
  const flows = flowEvidence(graph, options);
  const coverage = parserCoverage(graph);
  const verification = humanVerification(inputs.reviewImpact, flows.applicationFlows);

  return {
    schemaVersion: TRUST_ANALYTICS_SCHEMA,
    generatedAt: options.generatedAt || new Date().toISOString(),
    project: {
      projectId: graph.project?.projectId || null,
      graphVersion: graph.state?.graphVersion ?? null,
      sourceRevision: graph.state?.sourceRevision || null,
      sourceFingerprint: graph.state?.sourceFingerprint || null,
      graphStatus: graph.state?.status || "unknown",
    },
    status: "available",
    inventory: {
      nodes: Number(graph.stats?.nodes ?? graph.nodes?.length ?? 0),
      edges: Number(graph.stats?.edges ?? graph.edges?.length ?? 0),
      services: Number(graph.stats?.services || 0),
      endpoints: Number(graph.stats?.endpoints || 0),
      tests: Number(graph.stats?.tests || 0),
    },
    parserCoverage: coverage,
    flowEvidence: flows,
    freshness: {
      graph: { status: graph.state?.status || "unknown", graphVersion: graph.state?.graphVersion ?? null, updatedAt: graph.state?.updatedAt || null },
      derivedArtifacts: cacheFreshness(inputs.artifactCache),
      humanVerification: verification,
    },
    evidenceAvailability: {
      runtime,
      testRuns,
      semanticFeedback: feedback,
      agentEvidenceTraces: traces,
    },
    qualityEvidence: {
      liveRepositoryAccuracy: {
        status: "unavailable",
        precision: null,
        recall: null,
        reason: "The active repository has no independent ground-truth relationship labels. Run the fixture or pinned external-corpus evaluation to obtain bounded benchmark results; never apply those benchmark numbers to this repository automatically.",
      },
    },
    readiness: {
      structuralGraphAvailable: Boolean((graph.nodes || []).length),
      applicationFlowsAvailable: flows.applicationFlows > 0,
      allScannedFilesStructurallyParsed: coverage.structuralParseRatio === 1,
      currentHumanVerificationAvailable: verification.reusableCurrentOrCompatible > 0,
      currentRuntimeEvidenceAvailable: runtime.status === "available" && Number(runtime.current || 0) > 0,
      completedTestEvidenceAvailable: Object.entries(testRuns.byStatus || {}).some(([status, count]) => status !== "running" && count > 0),
      interpretation: "These are independent evidence-availability signals. They are not release approval and are intentionally not collapsed into one score.",
    },
    overallScore: null,
    claimBoundary: {
      compositeTruthScore: false,
      runtimeCorrectness: false,
      businessIntentCorrectness: false,
      completeBehaviorCoverage: false,
      liveRepositoryPrecisionRecall: false,
      statement: "Flowpeek indexes bounded evidence with explicit provenance and freshness. It is not the project, runtime, business, or organizational source of truth by itself.",
    },
    limitations: [
      "Absence of stored evidence is not evidence that behavior, tests, or review do not exist.",
      "Static relationships may be incomplete around dependency injection, reflection, dynamic dispatch, generated code, callbacks, macros, and runtime-computed configuration.",
      "Human feedback, human verification, agent-declared traces, test-run events, and runtime observations remain separate evidence classes and are never promoted silently.",
    ],
  };
}

module.exports = { DEFAULT_TRUST_ANALYTICS_MAX_FLOWS, TRUST_ANALYTICS_SCHEMA, buildTrustAnalytics, ratio };
