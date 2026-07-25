"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseContextRef } = require("./context-card");
const { normalizeDefinition } = require("./orientation-benchmark");

const AGENT_COMPARISON_RUNS_SCHEMA = "flopeek-agent-comparison-runs/v1";
const AGENT_COMPARISON_REPORT_SCHEMA = "flopeek-agent-comparison-report/v1";
const CONDITIONS = new Set(["direct-repository", "flopeek"]);
const CLAIM_OUTCOMES = new Set(["supported", "unsupported", "unknown"]);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "not-run", "unknown"]);
const STALE_STATUSES = new Set(["stale", "historical", "successor-candidate"]);
const CONTEXT_STATUSES = new Set(["current", "stale", "historical", "successor-candidate", "unavailable", "unresolved", "expired"]);
const FLOPEEK_TOOLS = new Set(["cancel_scan", "find_nodes", "get_active_branch_git_evidence", "get_agent_bootstrap", "get_changed_contexts", "get_entry_flows", "get_flow_comparison", "get_flow_context_card", "get_flow_projection", "get_git_context_continuity", "get_handoff_context", "get_related_tests", "get_request_flows", "get_scan_status", "refresh_graph", "resolve_context_ref"]);
const TOKEN_ESTIMATOR = "flopeek-char4-estimator/v1";

class AgentComparisonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentComparisonError";
    this.code = code;
  }
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentComparisonError("invalid-object", `${field} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AgentComparisonError("unknown-field", `${field} contains unknown fields: ${unknown.join(", ")}.`);
  return value;
}

function boundedText(value, field, limit = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\n") || value.includes("\r") || value.includes("\0")) throw new AgentComparisonError("invalid-text", `${field} must be a non-empty single-line string of at most ${limit} characters.`);
  return value.trim();
}

function portablePath(value, field) {
  const text = boundedText(value, field, 500).split("\\").join("/");
  if (path.posix.isAbsolute(text) || path.win32.isAbsolute(text) || text.split("/").includes("..")) throw new AgentComparisonError("unsafe-path", `${field} must be repository-relative and cannot traverse upward.`);
  return text;
}

function uniqueList(value, field, itemParser, limit = 100, allowEmpty = true) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > limit) throw new AgentComparisonError("invalid-list", `${field} must contain ${allowEmpty ? "0 to" : "1 to"} ${limit} items.`);
  return [...new Set(value.map((item, index) => itemParser(item, `${field}[${index}]`)))];
}

function reference(value, field) {
  const text = boundedText(value, field, 2000);
  if (path.win32.isAbsolute(text) || text.includes("file://")) throw new AgentComparisonError("unsafe-reference", `${field} cannot contain a machine-local file reference.`);
  return text;
}

function nonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AgentComparisonError("invalid-number", `${field} must be a non-negative finite number.`);
  return value;
}

function normalizeProvider(value, field) {
  exactKeys(value, ["name", "model", "sessionId"], field);
  return {
    name: boundedText(value.name, `${field}.name`, 120),
    model: boundedText(value.model, `${field}.model`, 160),
    sessionId: boundedText(value.sessionId, `${field}.sessionId`, 240),
  };
}

function normalizeFlopeekContext(value, field) {
  exactKeys(value, ["projectId", "graphVersion", "contextRefs", "toolsUsed"], field);
  if (!Number.isSafeInteger(value.graphVersion) || value.graphVersion < 0) throw new AgentComparisonError("invalid-graph-version", `${field}.graphVersion must be a non-negative integer.`);
  const projectId = boundedText(value.projectId, `${field}.projectId`, 240);
  const toolsUsed = uniqueList(value.toolsUsed, `${field}.toolsUsed`, boundedText, 30, false);
  const unsupported = toolsUsed.filter((tool) => !FLOPEEK_TOOLS.has(tool));
  if (unsupported.length) throw new AgentComparisonError("unsupported-flopeek-tool", `${field}.toolsUsed contains unsupported tools: ${unsupported.join(", ")}.`);
  const contextRefs = uniqueList(value.contextRefs, `${field}.contextRefs`, (item, itemField) => {
    const contextRef = reference(item, itemField);
    let parsed;
    try {
      parsed = parseContextRef(contextRef);
    } catch (error) {
      throw new AgentComparisonError("invalid-context-ref", `${itemField} is not a valid Flopeek Context Ref: ${error.message}`);
    }
    if (parsed.projectId !== projectId) throw new AgentComparisonError("wrong-context-project", `${itemField} belongs to a different Flopeek project.`);
    if (!new Set(["node", "flow"]).has(parsed.kind)) throw new AgentComparisonError("unsupported-context-kind", `${itemField} must refer to a node or flow.`);
    if (parsed.graphVersion > value.graphVersion) throw new AgentComparisonError("future-context-version", `${itemField} cannot target a graph version newer than the declared run graph.`);
    return contextRef;
  }, 100, false);
  return {
    projectId,
    graphVersion: value.graphVersion,
    contextRefs,
    toolsUsed,
  };
}

function normalizeClaimReview(value, field) {
  exactKeys(value, ["id", "category", "outcome", "evidenceRefs"], field);
  const outcome = boundedText(value.outcome, `${field}.outcome`, 40);
  if (!CLAIM_OUTCOMES.has(outcome)) throw new AgentComparisonError("invalid-claim-outcome", `${field}.outcome must be supported, unsupported, or unknown.`);
  const evidenceRefs = uniqueList(value.evidenceRefs, `${field}.evidenceRefs`, reference, 30);
  if (outcome !== "unknown" && !evidenceRefs.length) throw new AgentComparisonError("missing-claim-review-evidence", `${field}.evidenceRefs is required for a supported or unsupported outcome.`);
  return {
    id: boundedText(value.id, `${field}.id`, 120),
    category: boundedText(value.category, `${field}.category`, 120),
    outcome,
    evidenceRefs,
  };
}

function normalizeExecution(value, index) {
  const field = `executions[${index}]`;
  exactKeys(value, ["id", "pairId", "caseId", "condition", "provider", "durationMilliseconds", "context", "answer", "verification", "cost"], field);
  const condition = boundedText(value.condition, `${field}.condition`, 40);
  if (!CONDITIONS.has(condition)) throw new AgentComparisonError("invalid-condition", `${field}.condition must be direct-repository or flopeek.`);
  exactKeys(value.context, ["inspectedPaths", "estimatedCharacters", "flopeek"], `${field}.context`);
  const flopeek = value.context.flopeek == null ? null : normalizeFlopeekContext(value.context.flopeek, `${field}.context.flopeek`);
  if (condition === "flopeek" && !flopeek) throw new AgentComparisonError("missing-flopeek-context", `${field} must declare the Flopeek graph and tools it used.`);
  if (condition === "direct-repository" && flopeek) throw new AgentComparisonError("contaminated-baseline", `${field} cannot declare Flopeek context in the direct-repository condition.`);
  exactKeys(value.answer, ["targetPaths", "flowStepIds", "relatedTestPaths", "staleContextStatuses", "claimReviews"], `${field}.answer`);
  exactKeys(value.verification, ["status", "evidenceRefs"], `${field}.verification`);
  const verificationStatus = boundedText(value.verification.status, `${field}.verification.status`, 40);
  if (!VERIFICATION_STATUSES.has(verificationStatus)) throw new AgentComparisonError("invalid-verification-status", `${field}.verification.status is invalid.`);
  let cost = null;
  if (value.cost != null) {
    exactKeys(value.cost, ["currency", "amount"], `${field}.cost`);
    cost = { currency: boundedText(value.cost.currency, `${field}.cost.currency`, 12).toUpperCase(), amount: nonNegativeNumber(value.cost.amount, `${field}.cost.amount`) };
  }
  const staleContextStatuses = uniqueList(value.answer.staleContextStatuses, `${field}.answer.staleContextStatuses`, boundedText, 20);
  const invalidStatuses = staleContextStatuses.filter((status) => !CONTEXT_STATUSES.has(status));
  if (invalidStatuses.length) throw new AgentComparisonError("invalid-context-status", `${field}.answer.staleContextStatuses contains invalid values: ${invalidStatuses.join(", ")}.`);
  const verificationEvidenceRefs = uniqueList(value.verification.evidenceRefs, `${field}.verification.evidenceRefs`, reference, 50);
  if (new Set(["passed", "failed"]).has(verificationStatus) && !verificationEvidenceRefs.length) throw new AgentComparisonError("missing-verification-evidence", `${field}.verification.evidenceRefs is required for passed or failed verification.`);
  const claimReviews = uniqueList(value.answer.claimReviews, `${field}.answer.claimReviews`, normalizeClaimReview, 100);
  const claimIds = claimReviews.map((claim) => claim.id);
  if (new Set(claimIds).size !== claimIds.length) throw new AgentComparisonError("duplicate-claim-id", `${field}.answer.claimReviews must use unique claim IDs.`);
  return {
    id: boundedText(value.id, `${field}.id`, 120),
    pairId: boundedText(value.pairId, `${field}.pairId`, 120),
    caseId: boundedText(value.caseId, `${field}.caseId`, 120),
    condition,
    provider: normalizeProvider(value.provider, `${field}.provider`),
    durationMilliseconds: nonNegativeNumber(value.durationMilliseconds, `${field}.durationMilliseconds`),
    context: {
      inspectedPaths: uniqueList(value.context.inspectedPaths, `${field}.context.inspectedPaths`, portablePath, 500),
      estimatedCharacters: nonNegativeNumber(value.context.estimatedCharacters, `${field}.context.estimatedCharacters`),
      flopeek,
    },
    answer: {
      targetPaths: uniqueList(value.answer.targetPaths, `${field}.answer.targetPaths`, portablePath, 100),
      flowStepIds: value.answer.flowStepIds === null ? null : uniqueList(value.answer.flowStepIds, `${field}.answer.flowStepIds`, reference, 200),
      relatedTestPaths: uniqueList(value.answer.relatedTestPaths, `${field}.answer.relatedTestPaths`, portablePath, 100),
      staleContextStatuses,
      claimReviews,
    },
    verification: { status: verificationStatus, evidenceRefs: verificationEvidenceRefs },
    cost,
  };
}

function normalizeRuns(input) {
  exactKeys(input, ["schemaVersion", "studyId", "status", "consent", "executions"], "runs");
  if (input.schemaVersion !== AGENT_COMPARISON_RUNS_SCHEMA) throw new AgentComparisonError("invalid-runs-schema", `runs.schemaVersion must be ${AGENT_COMPARISON_RUNS_SCHEMA}.`);
  const status = boundedText(input.status, "runs.status", 40);
  if (!new Set(["template", "completed"]).has(status)) throw new AgentComparisonError("invalid-study-status", "runs.status must be template or completed.");
  exactKeys(input.consent, ["explicit", "privacyReviewed", "source"], "runs.consent");
  const executions = uniqueList(input.executions, "runs.executions", normalizeExecution, 400);
  if (status === "template" && executions.length) throw new AgentComparisonError("template-has-executions", "A template cannot contain provider executions.");
  if (status === "completed" && !executions.length) throw new AgentComparisonError("completed-without-executions", "A completed study requires paired provider executions.");
  if (executions.length && (input.consent.explicit !== true || input.consent.privacyReviewed !== true || input.consent.source !== "operator-supplied")) throw new AgentComparisonError("missing-study-consent", "Measured executions require explicit operator-supplied consent and privacy review.");
  return {
    schemaVersion: AGENT_COMPARISON_RUNS_SCHEMA,
    studyId: boundedText(input.studyId, "runs.studyId", 120),
    status,
    consent: { explicit: input.consent.explicit === true, privacyReviewed: input.consent.privacyReviewed === true, source: boundedText(input.consent.source, "runs.consent.source", 80) },
    executions,
  };
}

function intersection(expected, actual) {
  const found = new Set(actual);
  return expected.filter((item) => found.has(item));
}

function orderedMatch(expected, actual) {
  const rows = Array.from({ length: expected.length + 1 }, () => Array(actual.length + 1).fill(0));
  for (let left = 1; left <= expected.length; left += 1) {
    for (let right = 1; right <= actual.length; right += 1) rows[left][right] = expected[left - 1] === actual[right - 1] ? rows[left - 1][right - 1] + 1 : Math.max(rows[left - 1][right], rows[left][right - 1]);
  }
  return rows[expected.length][actual.length];
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : null;
}

function scoreExecution(execution, benchmarkCase) {
  const targetMatches = intersection(benchmarkCase.expected.targetPaths, execution.answer.targetPaths).length;
  const testMatches = intersection(benchmarkCase.expected.relatedTestPaths, execution.answer.relatedTestPaths).length;
  const flowMeasured = Array.isArray(execution.answer.flowStepIds);
  const flowMatches = flowMeasured ? orderedMatch(benchmarkCase.expected.flowStepIds, execution.answer.flowStepIds) : null;
  const staleRequested = benchmarkCase.staleContext ? 1 : 0;
  const staleDetected = staleRequested ? Number(execution.answer.staleContextStatuses.some((status) => STALE_STATUSES.has(status))) : 0;
  const reviewedClaims = execution.answer.claimReviews.filter((claim) => claim.outcome !== "unknown");
  const unsupportedClaims = reviewedClaims.filter((claim) => claim.outcome === "unsupported").length;
  return {
    id: execution.id,
    pairId: execution.pairId,
    caseId: execution.caseId,
    condition: execution.condition,
    provider: {
      name: execution.provider.name,
      model: execution.provider.model,
      sessionFingerprint: crypto.createHash("sha256").update(execution.provider.sessionId).digest("hex").slice(0, 16),
    },
    correctness: {
      targets: { matched: targetMatches, expected: benchmarkCase.expected.targetPaths.length, recall: ratio(targetMatches, benchmarkCase.expected.targetPaths.length) },
      flowSteps: flowMeasured ? { status: "measured", matchedInExpectedOrder: flowMatches, expected: benchmarkCase.expected.flowStepIds.length, recall: ratio(flowMatches, benchmarkCase.expected.flowStepIds.length) } : { status: "unavailable", matchedInExpectedOrder: null, expected: benchmarkCase.expected.flowStepIds.length, recall: null },
      relatedTests: { matched: testMatches, expected: benchmarkCase.expected.relatedTestPaths.length, recall: ratio(testMatches, benchmarkCase.expected.relatedTestPaths.length) },
      staleContext: { requested: staleRequested, detected: staleRequested ? staleDetected : null, rate: staleRequested ? staleDetected : null },
    },
    context: {
      filesInspected: execution.context.inspectedPaths.length,
      estimatedCharacters: execution.context.estimatedCharacters,
      estimatedTokens: Math.ceil(execution.context.estimatedCharacters / 4),
      tokenizerId: TOKEN_ESTIMATOR,
      flopeek: execution.context.flopeek ? { projectId: execution.context.flopeek.projectId, graphVersion: execution.context.flopeek.graphVersion, contextRefCount: execution.context.flopeek.contextRefs.length, toolsUsed: execution.context.flopeek.toolsUsed } : null,
    },
    durationMilliseconds: execution.durationMilliseconds,
    claimReview: { reviewed: reviewedClaims.length, unsupported: unsupportedClaims, unknown: execution.answer.claimReviews.length - reviewedClaims.length, unsupportedRate: ratio(unsupportedClaims, reviewedClaims.length) },
    verification: execution.verification,
    cost: execution.cost,
  };
}

function aggregate(executions) {
  const sum = (selector) => executions.reduce((total, item) => total + selector(item), 0);
  const flow = executions.filter((item) => item.correctness.flowSteps.status === "measured");
  const targetsExpected = sum((item) => item.correctness.targets.expected);
  const testsExpected = sum((item) => item.correctness.relatedTests.expected);
  const staleRequested = sum((item) => item.correctness.staleContext.requested);
  const claimReviewed = sum((item) => item.claimReview.reviewed);
  const unsupported = sum((item) => item.claimReview.unsupported);
  const suppliedCosts = executions.filter((item) => item.cost);
  const currencies = [...new Set(suppliedCosts.map((item) => item.cost.currency))];
  return {
    executions: executions.length,
    targets: { matched: sum((item) => item.correctness.targets.matched), expected: targetsExpected, recall: ratio(sum((item) => item.correctness.targets.matched), targetsExpected) },
    flowSteps: flow.length ? { status: "measured", matchedInExpectedOrder: flow.reduce((total, item) => total + item.correctness.flowSteps.matchedInExpectedOrder, 0), expected: flow.reduce((total, item) => total + item.correctness.flowSteps.expected, 0), recall: ratio(flow.reduce((total, item) => total + item.correctness.flowSteps.matchedInExpectedOrder, 0), flow.reduce((total, item) => total + item.correctness.flowSteps.expected, 0)) } : { status: "unavailable", matchedInExpectedOrder: null, expected: null, recall: null },
    relatedTests: { matched: sum((item) => item.correctness.relatedTests.matched), expected: testsExpected, recall: ratio(sum((item) => item.correctness.relatedTests.matched), testsExpected) },
    staleContext: { requested: staleRequested, detected: staleRequested ? sum((item) => item.correctness.staleContext.detected || 0) : null, rate: staleRequested ? ratio(sum((item) => item.correctness.staleContext.detected || 0), staleRequested) : null },
    context: { filesInspected: sum((item) => item.context.filesInspected), estimatedTokens: sum((item) => item.context.estimatedTokens), tokenizerId: TOKEN_ESTIMATOR },
    timing: { totalMilliseconds: Number(sum((item) => item.durationMilliseconds).toFixed(3)), meanMilliseconds: executions.length ? Number((sum((item) => item.durationMilliseconds) / executions.length).toFixed(3)) : null },
    claimReview: { reviewed: claimReviewed, unsupported, unknown: sum((item) => item.claimReview.unknown), unsupportedRate: ratio(unsupported, claimReviewed), status: claimReviewed ? "measured-from-supplied-review" : "unavailable" },
    verification: { passed: executions.filter((item) => item.verification.status === "passed").length, failed: executions.filter((item) => item.verification.status === "failed").length, notRunOrUnknown: executions.filter((item) => new Set(["not-run", "unknown"]).has(item.verification.status)).length },
    cost: currencies.length === 1 ? { status: suppliedCosts.length === executions.length ? "supplied" : "partial", currency: currencies[0], amount: Number(sum((item) => item.cost?.amount || 0).toFixed(6)), executionsSupplied: suppliedCosts.length } : { status: currencies.length ? "not-comparable" : "unavailable", currency: null, amount: null, executionsSupplied: suppliedCosts.length },
  };
}

function delta(left, right) {
  return left === null || right === null ? null : Number((right - left).toFixed(6));
}

function validatePairs(executions, casesById) {
  const executionIds = new Set();
  const pairs = new Map();
  for (const execution of executions) {
    if (executionIds.has(execution.id)) throw new AgentComparisonError("duplicate-execution", `Duplicate execution id: ${execution.id}.`);
    executionIds.add(execution.id);
    if (!casesById.has(execution.caseId)) throw new AgentComparisonError("unknown-case", `Execution ${execution.id} references unknown case ${execution.caseId}.`);
    if (!pairs.has(execution.pairId)) pairs.set(execution.pairId, []);
    pairs.get(execution.pairId).push(execution);
  }
  for (const [pairId, items] of pairs) {
    if (items.length !== 2 || new Set(items.map((item) => item.condition)).size !== 2) throw new AgentComparisonError("incomplete-pair", `Pair ${pairId} requires exactly one direct-repository and one flopeek execution.`);
    if (new Set(items.map((item) => item.caseId)).size !== 1) throw new AgentComparisonError("pair-case-mismatch", `Pair ${pairId} must use one case.`);
    if (new Set(items.map((item) => `${item.provider.name}\0${item.provider.model}`)).size !== 1) throw new AgentComparisonError("pair-provider-mismatch", `Pair ${pairId} must use the same provider and model.`);
    if (new Set(items.map((item) => item.provider.sessionId)).size !== 2) throw new AgentComparisonError("reused-session", `Pair ${pairId} requires distinct provider sessions.`);
  }
  return pairs;
}

function evaluateAgentComparison(suiteRoot, casesDefinition, runsInput) {
  const definition = normalizeDefinition(casesDefinition, suiteRoot);
  const casesById = new Map(definition.repositories.flatMap((repository) => repository.cases).map((item) => [item.id, item]));
  const runs = normalizeRuns(runsInput);
  if (!runs.executions.length) {
    return {
      schemaVersion: AGENT_COMPARISON_REPORT_SCHEMA,
      studyId: runs.studyId,
      suite: { id: definition.suiteId, caseCount: casesById.size },
      status: "not-run",
      evidenceClass: "ai-provider-outcome",
      providerExecutionInvokedByFlopeek: false,
      summary: null,
      reason: "The checked artifact is a privacy-reviewed input template. No provider execution was supplied or inferred.",
      conclusionBoundary: "Harness availability is not evidence that Flopeek improves agent outcomes.",
    };
  }
  const pairs = validatePairs(runs.executions, casesById);
  const scored = runs.executions.map((execution) => scoreExecution(execution, casesById.get(execution.caseId)));
  const baseline = aggregate(scored.filter((item) => item.condition === "direct-repository"));
  const flopeek = aggregate(scored.filter((item) => item.condition === "flopeek"));
  return {
    schemaVersion: AGENT_COMPARISON_REPORT_SCHEMA,
    studyId: runs.studyId,
    suite: { id: definition.suiteId, caseCount: casesById.size, pairsMeasured: pairs.size },
    status: "measured-from-supplied-provider-executions",
    evidenceClass: "ai-provider-outcome-with-committed-oracle",
    providerExecutionInvokedByFlopeek: false,
    consent: runs.consent,
    independence: { distinctProviders: new Set(scored.map((item) => item.provider.name)).size, distinctModels: new Set(scored.map((item) => `${item.provider.name}\0${item.provider.model}`)).size, providerQuorumClaimed: false },
    executions: scored,
    summary: {
      directRepository: baseline,
      flopeek,
      pairedDelta: {
        targetRecall: delta(baseline.targets.recall, flopeek.targets.recall),
        flowStepRecall: delta(baseline.flowSteps.recall, flopeek.flowSteps.recall),
        relatedTestRecall: delta(baseline.relatedTests.recall, flopeek.relatedTests.recall),
        staleContextRate: delta(baseline.staleContext.rate, flopeek.staleContext.rate),
        meanDurationMilliseconds: delta(baseline.timing.meanMilliseconds, flopeek.timing.meanMilliseconds),
        filesInspected: flopeek.context.filesInspected - baseline.context.filesInspected,
        estimatedTokens: flopeek.context.estimatedTokens - baseline.context.estimatedTokens,
      },
    },
    limitations: [
      "Flopeek validates and scores operator-supplied execution metadata; it does not invoke an AI provider or target application.",
      "Provider outputs remain AI-provider outcome evidence even when deterministic scoring uses a committed fixture oracle.",
      "Unsupported-claim rates are available only for separately supplied claim-review labels; absence of labels is unavailable, not zero.",
      "Session identifiers are reduced to one-way fingerprints in the report; source bodies, raw prompts, raw logs, credentials, and machine-local paths are not accepted.",
      "One measured cohort cannot establish universal provider, repository, or productivity effects.",
    ],
    conclusionBoundary: "Any observed delta applies only to the supplied paired executions, provider/model, pinned cases, review labels, and verification evidence.",
  };
}

function loadAgentComparisonRuns(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new AgentComparisonError("invalid-runs-file", `Unable to read agent comparison runs ${file}: ${error.message}`); }
}

function agentComparisonSummary(report) {
  if (report.status === "not-run") return `Agent comparison: not run\n${report.reason}\n${report.conclusionBoundary}`;
  return [
    `Agent comparison: ${report.suite.pairsMeasured} supplied A/B pairs`,
    `Target recall: direct ${report.summary.directRepository.targets.recall ?? "unavailable"}, Flopeek ${report.summary.flopeek.targets.recall ?? "unavailable"}`,
    `Flow-step recall: direct ${report.summary.directRepository.flowSteps.recall ?? "unavailable"}, Flopeek ${report.summary.flopeek.flowSteps.recall ?? "unavailable"}`,
    `Related-test recall: direct ${report.summary.directRepository.relatedTests.recall ?? "unavailable"}, Flopeek ${report.summary.flopeek.relatedTests.recall ?? "unavailable"}`,
    `Mean duration delta (Flopeek - direct): ${report.summary.pairedDelta.meanDurationMilliseconds ?? "unavailable"} ms`,
    report.conclusionBoundary,
  ].join("\n");
}

module.exports = {
  AGENT_COMPARISON_REPORT_SCHEMA,
  AGENT_COMPARISON_RUNS_SCHEMA,
  AgentComparisonError,
  agentComparisonSummary,
  evaluateAgentComparison,
  loadAgentComparisonRuns,
  normalizeRuns,
};
