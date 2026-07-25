"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PRODUCT_PROOF_SCHEMA = "flopeek-product-proof/v1";
const PUBLIC_PROOF_EVIDENCE_PATH = path.join(__dirname, "..", "benchmarks", "public-proof.json");
const REAL_CORPUS_MANIFEST_PATH = path.join(__dirname, "..", "benchmarks", "real-repository-corpus.json");
const ORIENTATION_CASES_PATH = path.join(__dirname, "..", "benchmarks", "orientation-cases.json");
const ORIENTATION_BASELINE_PATH = path.join(__dirname, "..", "benchmarks", "orientation-baseline.json");
const ORIENTATION_FLOPEEK_PATH = path.join(__dirname, "..", "benchmarks", "orientation-flopeek.json");

function divide(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function divideOrientation(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function validatePublicEvidence(evidence, manifest) {
  if (evidence?.schemaVersion !== "flopeek-public-proof-evidence/v1") throw new Error("Public proof evidence has an unsupported schema.");
  if (evidence.relationshipAudit?.manifest !== "benchmarks/real-repository-corpus.json") throw new Error("Public proof evidence must name the pinned relationship manifest.");
  const repositories = manifest?.repositories || [];
  const scopes = repositories.flatMap((repository) => repository.focuses || []);
  const expectedRelationships = scopes.reduce((total, scope) => total + (scope.expectedTargets || []).length, 0);
  const audit = evidence.relationshipAudit;
  if (audit.repositories !== repositories.length || audit.auditedScopes !== scopes.length || audit.expectedRelationships !== expectedRelationships) throw new Error("Public proof relationship totals do not match the pinned audited manifest.");
  const predicted = audit.truePositives + audit.falsePositives;
  const expected = audit.truePositives + audit.falseNegatives;
  if (audit.precision !== divide(audit.truePositives, predicted) || audit.recall !== divide(audit.truePositives, expected)) throw new Error("Public proof precision or recall does not match its confusion counts.");
  if (!Array.isArray(evidence.incrementalPerformance?.rows) || !evidence.incrementalPerformance.rows.length) throw new Error("Public proof performance evidence requires at least one pinned row.");
  const seenRevisions = new Set();
  for (const row of evidence.incrementalPerformance.rows) {
    const repository = repositories.find((candidate) => candidate.revision === row.revision);
    if (!repository) throw new Error(`Public proof performance revision is not present in the pinned manifest for ${row.repository}.`);
    const normalizedUrl = String(row.url || "").replace(/\.git$/, "");
    if (normalizedUrl !== String(repository.url || "").replace(/\.git$/, "")) throw new Error(`Public proof repository URL does not match the pinned manifest for ${row.repository}.`);
    if (seenRevisions.has(row.revision)) throw new Error(`Public proof performance revision is duplicated for ${row.repository}.`);
    seenRevisions.add(row.revision);
    if (![row.sourceFiles, row.parsedFiles, row.fullMedianMs, row.incrementalMedianMs, row.speedup].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`Public proof timing row is incomplete for ${row.repository}.`);
    if (row.parsedFiles > row.sourceFiles) throw new Error(`Public proof parsed-file count exceeds source files for ${row.repository}.`);
    const calculated = Number((row.fullMedianMs / row.incrementalMedianMs).toFixed(2));
    if (row.speedup !== calculated) throw new Error(`Public proof speedup does not match timing medians for ${row.repository}.`);
  }
  return evidence;
}

function loadPublicProofEvidence() {
  return validatePublicEvidence(readJson(PUBLIC_PROOF_EVIDENCE_PATH), readJson(REAL_CORPUS_MANIFEST_PATH));
}

function validateOrientationReport(report, condition, definition = null) {
  if (report?.schemaVersion !== "flopeek-orientation-benchmark/v2" || report.condition !== condition) throw new Error(`Orientation proof requires a ${condition} flopeek-orientation-benchmark/v2 report.`);
  const repositories = report.repositories || [];
  const cases = repositories.flatMap((repository) => repository.cases || []);
  if (!cases.length || report.suite?.repositoryCount !== repositories.length || report.suite?.caseCount !== cases.length || report.summary?.caseCount !== cases.length) throw new Error(`Orientation ${condition} case totals are inconsistent.`);
  if (repositories.some((repository) => repository.sourcePin?.kind !== "tree-sha256" || repository.sourcePin?.verified !== true || typeof repository.sourcePin?.value !== "string" || repository.sourcePin.value.length !== 64)) throw new Error(`Orientation ${condition} repositories must retain verified tree-sha256 pins.`);
  if (definition) {
    if (definition.schemaVersion !== report.suite.casesSchemaVersion || definition.suiteId !== report.suite.id || definition.repositories?.length !== repositories.length) throw new Error(`Orientation ${condition} report does not match the declared case suite.`);
    for (const repository of repositories) {
      const declared = definition.repositories.find((item) => item.id === repository.id);
      if (!declared || declared.path !== repository.declaredPath || declared.sourcePin?.kind !== repository.sourcePin.kind || declared.sourcePin?.value !== repository.sourcePin.value) throw new Error(`Orientation ${condition} repository evidence does not match its declared source pin.`);
      const declaredCaseIds = (declared.cases || []).map((item) => item.id).sort();
      const reportCaseIds = (repository.cases || []).map((item) => item.id).sort();
      if (JSON.stringify(declaredCaseIds) !== JSON.stringify(reportCaseIds)) throw new Error(`Orientation ${condition} case identities do not match the declared suite.`);
    }
  }
  const expectedTargets = cases.reduce((total, item) => total + item.metrics.correctTargetRetrieval.expected, 0);
  const matchedTargets = cases.reduce((total, item) => total + item.metrics.correctTargetRetrieval.matched, 0);
  const expectedTests = cases.reduce((total, item) => total + item.metrics.relatedTests.expected, 0);
  const matchedTests = cases.reduce((total, item) => total + item.metrics.relatedTests.matched, 0);
  const measuredFlows = cases.filter((item) => item.metrics.flowSteps.status === "measured");
  const expectedFlowSteps = measuredFlows.reduce((total, item) => total + item.metrics.flowSteps.expected, 0);
  const matchedFlowSteps = measuredFlows.reduce((total, item) => total + item.metrics.flowSteps.matchedInExpectedOrder, 0);
  const exactFlowCases = measuredFlows.filter((item) => item.metrics.flowSteps.exactOrderMatch).length;
  const measuredStale = cases.filter((item) => item.metrics.staleContextDetection.status === "measured");
  const requestedStale = cases.reduce((total, item) => total + Number(item.metrics.staleContextDetection.requested || 0), 0);
  const detectedStale = measuredStale.reduce((total, item) => total + item.metrics.staleContextDetection.detected, 0);
  const contextFiles = cases.reduce((total, item) => total + item.metrics.context.filesInspected, 0);
  const contextCharacters = cases.reduce((total, item) => total + item.metrics.context.estimatedCharacters, 0);
  const contextTokens = cases.reduce((total, item) => total + item.metrics.context.estimatedTokens, 0);
  const preparationMilliseconds = Number(repositories.reduce((total, item) => total + item.timing.preparationMilliseconds, 0).toFixed(3));
  const retrievalMilliseconds = Number(cases.reduce((total, item) => total + item.metrics.timing.retrievalMilliseconds, 0).toFixed(3));
  const validationMilliseconds = Number(cases.reduce((total, item) => total + Number(item.metrics.timing.separateValidationMilliseconds || 0), 0).toFixed(3));
  const totalToUsefulContextMilliseconds = Number((preparationMilliseconds + retrievalMilliseconds).toFixed(3));
  if (report.summary.correctTargetRetrieval.expected !== expectedTargets || report.summary.correctTargetRetrieval.matched !== matchedTargets || report.summary.correctTargetRetrieval.recall !== divideOrientation(matchedTargets, expectedTargets)) throw new Error(`Orientation ${condition} target totals are inconsistent.`);
  if (report.summary.relatedTests.expected !== expectedTests || report.summary.relatedTests.matched !== matchedTests || report.summary.relatedTests.recall !== divideOrientation(matchedTests, expectedTests)) throw new Error(`Orientation ${condition} related-test totals are inconsistent.`);
  if (measuredFlows.length) {
    if (report.summary.flowSteps.status !== "measured" || report.summary.flowSteps.casesMeasured !== measuredFlows.length || report.summary.flowSteps.expected !== expectedFlowSteps || report.summary.flowSteps.matchedInExpectedOrder !== matchedFlowSteps || report.summary.flowSteps.recall !== divideOrientation(matchedFlowSteps, expectedFlowSteps) || report.summary.flowSteps.exactCaseMatches !== exactFlowCases) throw new Error(`Orientation ${condition} flow totals are inconsistent.`);
  } else if (report.summary.flowSteps.status !== "unavailable" || report.summary.flowSteps.casesMeasured !== 0 || report.summary.flowSteps.recall !== null) throw new Error(`Orientation ${condition} unavailable flow evidence is inconsistent.`);
  if (measuredStale.length) {
    if (report.summary.staleContextDetection.status !== "measured" || report.summary.staleContextDetection.requested !== measuredStale.length || report.summary.staleContextDetection.detected !== detectedStale || report.summary.staleContextDetection.rate !== divideOrientation(detectedStale, measuredStale.length)) throw new Error(`Orientation ${condition} stale-context totals are inconsistent.`);
  } else if (report.summary.staleContextDetection.status !== "unavailable" || report.summary.staleContextDetection.requested !== requestedStale || report.summary.staleContextDetection.detected !== null || report.summary.staleContextDetection.rate !== null) throw new Error(`Orientation ${condition} unavailable stale-context evidence is inconsistent.`);
  if (report.summary.context.filesInspected !== contextFiles || report.summary.context.estimatedCharacters !== contextCharacters || report.summary.context.estimatedTokens !== contextTokens || report.summary.context.tokenizerId !== "flopeek-char4-estimator/v1") throw new Error(`Orientation ${condition} context totals are inconsistent.`);
  if (report.summary.timing.repositoryPreparationMilliseconds !== preparationMilliseconds || report.summary.timing.caseRetrievalMilliseconds !== retrievalMilliseconds || report.summary.timing.totalTimeToUsefulContextMilliseconds !== totalToUsefulContextMilliseconds || report.summary.timing.separateValidationMilliseconds !== validationMilliseconds || report.summary.timing.coldTimeToUsefulContextMilliseconds !== totalToUsefulContextMilliseconds || report.summary.timing.warmTimeToUsefulContextMilliseconds !== retrievalMilliseconds || report.summary.timing.processStartupAndModuleLoad?.status !== "unavailable" || report.summary.timing.gating !== false) throw new Error(`Orientation ${condition} timing totals are inconsistent.`);
  if (cases.some((item) => item.metrics.unsupportedClaims?.status !== "no-claims-emitted" || item.metrics.unsupportedClaims?.evaluated !== 0 || item.metrics.unsupportedClaims?.unsupported !== 0 || item.metrics.unsupportedClaims?.rate !== null) || report.summary.unsupportedClaims?.status !== "no-claims-emitted" || report.summary.unsupportedClaims?.evaluated !== 0 || report.summary.unsupportedClaims?.unsupported !== 0 || report.summary.unsupportedClaims?.rate !== null) throw new Error(`Orientation ${condition} unsupported-claim evidence is inconsistent.`);
  if (report.studyEvidence?.humanStudy?.status !== "not-run" || report.studyEvidence?.agentStudy?.status !== "not-run") throw new Error(`Orientation ${condition} checked-in evidence must not imply an executed human or agent study.`);
  return report;
}

function loadOrientationProofEvidence() {
  const definition = readJson(ORIENTATION_CASES_PATH);
  const baseline = validateOrientationReport(readJson(ORIENTATION_BASELINE_PATH), "direct-repository", definition);
  const flopeek = validateOrientationReport(readJson(ORIENTATION_FLOPEEK_PATH), "flopeek", definition);
  if (baseline.suite.id !== flopeek.suite.id || baseline.suite.caseCount !== flopeek.suite.caseCount) throw new Error("Orientation proof reports must use the same suite.");
  return {
    schemaVersion: "flopeek-orientation-proof-summary/v1",
    suite: baseline.suite,
    baseline: { generatedAt: baseline.generatedAt, runEnvironment: baseline.runEnvironment, summary: baseline.summary },
    flopeek: { generatedAt: flopeek.generatedAt, runEnvironment: flopeek.runEnvironment, summary: flopeek.summary },
    artifacts: ["benchmarks/orientation-cases.json", "benchmarks/orientation-baseline.json", "benchmarks/orientation-flopeek.json"],
    evidenceClasses: { deterministicRetrieval: "measured", humanStudy: "not-run", agentStudy: "not-run" },
    limitation: "This is deterministic retrieval evidence on three pinned fixtures. It is not a human productivity result, AI-agent outcome, runtime proof, universal accuracy score, or universal speed claim.",
  };
}

function capabilityShowcase(graph) {
  const adapters = graph.analysis?.adapterCapabilities?.adapters || [];
  return [
    {
      id: "human-readable-flow-lens",
      title: "Human-readable bounded Flow Lens",
      outcome: "Move from an HTTP entry point to a focused technical explanation with transition evidence, branches, boundaries, and explicit truncation.",
      status: "current-http",
      proof: ["viewer: Flow Lens", "HTTP: /api/flow-lens", "MCP: get_flow_projection"],
      boundary: "Static technical evidence, not runtime sequence or business process proof."
    },
    {
      id: "shared-human-agent-context",
      title: "One context for people and coding agents",
      outcome: "Viewer, HTTP, and MCP resolve the same project ID, graph version, Context Refs, affected contexts, and before/current flow evidence.",
      status: "current",
      proof: ["HTTP: /api/agent-context", "MCP: get_agent_context", "MCP: resolve_context_ref"],
      boundary: "A resolved context can still be incomplete where parser coverage is limited."
    },
    {
      id: "live-change-explanation",
      title: "Live change explanation",
      outcome: "Incremental scans reuse unchanged parser facts, advance graph identity, identify affected contexts, and refresh the open local viewer.",
      status: "current",
      proof: ["SSE: /api/events", "HTTP: /api/changed-contexts", "MCP: refresh_graph"],
      boundary: "Graph-wide relationships are rebuilt from retained facts; this is not a fully incremental graph engine."
    },
    {
      id: "impact-and-tests",
      title: "Static impact and related-test guidance",
      outcome: "Map changed files to affected nodes, endpoints, dependencies, and directly related tests before editing or review.",
      status: "partial",
      proof: ["CLI: flopeek impact", "HTTP: /api/impact", "MCP: get_change_impact"],
      boundary: "Stored-edge traversal can miss dynamic behavior and can be conservatively broad."
    },
    {
      id: "source-safe-local-first",
      title: "Local-first and source-safe agent surface",
      outcome: "Scan locally without executing the target application; MCP exposes graph/context operations and bounded metadata appends without arbitrary shell or repository-source writes.",
      status: "current",
      proof: ["CLI: flopeek scan", "MCP: stdio", "Cache: .flopeek/graph.json"],
      boundary: "Optional local language helpers parse supplied source text; they do not execute the target application."
    },
    {
      id: "parser-adapter-breadth",
      title: "Parser-first multi-language evidence",
      outcome: `${adapters.length} registered adapters publish machine-readable capabilities, confidence, source ranges, and repository-specific parse coverage.`,
      status: "partial-by-adapter",
      proof: ["HTTP: /api/capabilities", "MCP: get_agent_context", "Document: SUPPORT.md"],
      boundary: "Adapter registration is not universal semantic coverage; unsupported constructs remain explicit."
    }
  ];
}

function createProductProof(graph, options = {}) {
  const publicEvidence = options.publicEvidence || loadPublicProofEvidence();
  const orientationEvidence = options.orientationEvidence || loadOrientationProofEvidence();
  const audit = publicEvidence.relationshipAudit;
  const rows = publicEvidence.incrementalPerformance.rows;
  const coverage = graph.analysis?.coverage?.summary || {};
  const localBenchmark = options.localBenchmark || null;
  return {
    schemaVersion: PRODUCT_PROOF_SCHEMA,
    generatedAt: options.generatedAt || new Date().toISOString(),
    title: "Why Flopeek",
    summary: "Flopeek turns repository structure into bounded, evidence-linked technical flows that people and coding agents can inspect from the same local graph state.",
    headlineMetrics: {
      auditedRepositories: audit.repositories,
      auditedScopes: audit.auditedScopes,
      auditedRelationships: audit.expectedRelationships,
      auditedTruePositives: audit.truePositives,
      auditedFalsePositives: audit.falsePositives,
      auditedFalseNegatives: audit.falseNegatives,
      boundedPrecision: audit.precision,
      boundedRecall: audit.recall,
      measuredIncrementalSpeedup: {
        minimum: Math.min(...rows.map((row) => row.speedup)),
        maximum: Math.max(...rows.map((row) => row.speedup)),
        repositories: rows.length
      },
      orientationRetrieval: {
        cases: orientationEvidence.suite.caseCount,
        expectedTargets: orientationEvidence.flopeek.summary.correctTargetRetrieval.expected,
        matchedTargets: orientationEvidence.flopeek.summary.correctTargetRetrieval.matched,
        expectedFlowSteps: orientationEvidence.flopeek.summary.flowSteps.expected,
        matchedFlowSteps: orientationEvidence.flopeek.summary.flowSteps.matchedInExpectedOrder,
        expectedRelatedTests: orientationEvidence.flopeek.summary.relatedTests.expected,
        matchedRelatedTests: orientationEvidence.flopeek.summary.relatedTests.matched,
        staleRefsRequested: orientationEvidence.flopeek.summary.staleContextDetection.requested,
        staleRefsDetected: orientationEvidence.flopeek.summary.staleContextDetection.detected,
        evidenceClass: "deterministic-retrieval"
      }
    },
    auditedRelationshipEvidence: audit,
    incrementalPerformanceEvidence: publicEvidence.incrementalPerformance,
    orientationRetrievalEvidence: orientationEvidence,
    capabilityShowcase: capabilityShowcase(graph),
    currentRepository: {
      projectId: graph.project?.projectId || null,
      graphVersion: graph.state?.graphVersion ?? null,
      sourceRevision: graph.state?.sourceRevision || null,
      sourceFiles: Number(graph.stats?.scannedFiles || 0),
      structurallyParsedFiles: Number(coverage.parsedFiles || 0),
      structuralParseRatio: divide(Number(coverage.parsedFiles || 0), Number(coverage.scannedFiles || 0)),
      nodes: Number(graph.stats?.nodes || 0),
      edges: Number(graph.stats?.edges || 0),
      endpoints: Number(graph.stats?.endpoints || 0),
      applicationFlows: Number(graph.flows?.length || 0),
      interpretation: "These counts describe the currently scanned static graph. They are not accuracy, business-value, runtime-coverage, or completeness scores."
    },
    localBenchmark: localBenchmark ? { status: "available", result: localBenchmark } : {
      status: "not-run",
      command: "flopeek proof <repository> --iterations 3",
      viewerAction: "Run local proof benchmark",
      reason: "Local timing is opt-in because it reparses the selected repository several times and varies by machine."
    },
    reproducibility: {
      local: ["flopeek proof <repository> --iterations 3 --format json", "flopeek benchmark <repository> --iterations 3 --format json", "flopeek evaluate orientation . --cases benchmarks/orientation-cases.json --format json"],
      externalAudit: "node src/real-repository-corpus.js --clone-directory <directory> --format json",
      documentation: ["BENCHMARKS.md", "SUPPORT.md", "docs/testing.md"]
    },
    claimBoundary: {
      globalAccuracy: false,
      universalSpeedup: false,
      runtimeCorrectness: false,
      businessIntentCorrectness: false,
      humanProductivityImprovement: false,
      agentOutcomeImprovement: false,
      releaseReadiness: false,
      statement: "Public proof is reproducible bounded evidence, not a universal product score."
    }
  };
}

function printProductProof(report) {
  const metrics = report.headlineMetrics;
  console.log(report.title);
  console.log(report.summary);
  console.log(`${metrics.auditedTruePositives}/${metrics.auditedRelationships} audited relationships across ${metrics.auditedRepositories} pinned repositories and ${metrics.auditedScopes} exact scopes.`);
  console.log(`Bounded precision/recall: ${(metrics.boundedPrecision * 100).toFixed(1)}% / ${(metrics.boundedRecall * 100).toFixed(1)}% (not global accuracy).`);
  console.log(`Published incremental speedup range: ${metrics.measuredIncrementalSpeedup.minimum.toFixed(2)}x-${metrics.measuredIncrementalSpeedup.maximum.toFixed(2)}x across ${metrics.measuredIncrementalSpeedup.repositories} pinned monorepos.`);
  console.log(`Orientation fixture: ${metrics.orientationRetrieval.matchedTargets}/${metrics.orientationRetrieval.expectedTargets} targets, ${metrics.orientationRetrieval.matchedFlowSteps}/${metrics.orientationRetrieval.expectedFlowSteps} ordered static steps, ${metrics.orientationRetrieval.matchedRelatedTests}/${metrics.orientationRetrieval.expectedRelatedTests} related tests, and ${metrics.orientationRetrieval.staleRefsDetected}/${metrics.orientationRetrieval.staleRefsRequested} stale refs across ${metrics.orientationRetrieval.cases} pinned cases.`);
  if (report.localBenchmark.status === "available") {
    const local = report.localBenchmark.result;
    console.log(`This repository: ${local.sourceFiles} source files, ${local.parsedFiles} structurally parsed, ${local.speedupVsFull.toFixed(2)}x local incremental/full median.`);
  }
  console.log(report.claimBoundary.statement);
}

module.exports = { PRODUCT_PROOF_SCHEMA, createProductProof, loadOrientationProofEvidence, loadPublicProofEvidence, printProductProof, validateOrientationReport, validatePublicEvidence };
