"use strict";

const { createHandoffContext } = require("./handoff-context");
const { sourceBasis } = require("./durable-brief");

const HANDOFF_QUALITY_SCHEMA = "flopeek-handoff-quality/v1";
const MAX_CASES = 50;
const HUMAN_HANDOFF_ROLES = new Set(["senior-developer", "inheriting-developer", "handoff-recipient", "agent-reviewer"]);

class HandoffQualityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HandoffQualityError";
    this.code = code;
    this.statusCode = 400;
  }
}

function stringList(value, field, limit = 100) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HandoffQualityError("invalid-quality-case", `${field} must be an array of at most ${limit} non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function normalizeCases(input = {}) {
  if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > MAX_CASES) {
    throw new HandoffQualityError("invalid-quality-cases", `cases must contain 1 to ${MAX_CASES} benchmark cases.`);
  }
  const ids = new Set();
  return input.cases.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HandoffQualityError("invalid-quality-case", `cases[${index}] must be an object.`);
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) || ids.has(id)) throw new HandoffQualityError("invalid-quality-case-id", `cases[${index}].id must be unique and portable.`);
    ids.add(id);
    const expected = item.expected || {};
    return {
      id,
      request: item.request || {},
      expected: {
        featureIds: stringList(expected.featureIds, `${id}.expected.featureIds`),
        flowTitles: stringList(expected.flowTitles, `${id}.expected.flowTitles`),
      },
      staleContextRefs: stringList(item.staleContextRefs, `${id}.staleContextRefs`, 20),
      agentTaskOutcome: item.agentTaskOutcome || null,
      humanHandoffObservation: item.humanHandoffObservation || null,
    };
  });
}

function contextRefs(value, refs = new Set()) {
  if (typeof value === "string") {
    if (value.startsWith("fp://local/")) refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) contextRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  for (const item of Object.values(value)) contextRefs(item, refs);
  return refs;
}

function normalizedAgentOutcome(value) {
  if (!value) return { status: "unavailable", evidenceClass: "unknown", result: null, reason: "No agent task outcome was supplied for this benchmark case." };
  const result = ["passed", "failed", "inconclusive"].includes(value.result) ? value.result : null;
  const evidenceClass = ["agent-declared", "human-verified", "runtime-evidence"].includes(value.evidenceClass) ? value.evidenceClass : null;
  if (!result || !evidenceClass) throw new HandoffQualityError("invalid-agent-task-outcome", "agentTaskOutcome requires result passed|failed|inconclusive and evidenceClass agent-declared|human-verified|runtime-evidence.");
  return {
    status: evidenceClass === "agent-declared" ? "declared" : "supplied-evidence",
    evidenceClass,
    result,
    evidenceRef: typeof value.evidenceRef === "string" && value.evidenceRef.startsWith("fp://local/") ? value.evidenceRef : null,
    limitation: evidenceClass === "agent-declared"
      ? "An agent-declared result is audit metadata, not independent proof of task correctness."
      : "The supplied evidence class and resolvable ref are auditable inputs; Flopeek does not infer that they prove task correctness.",
  };
}

function normalizedHumanHandoffObservation(value, resolveContextRef, graph) {
  if (!value) return { status: "unavailable", evidenceClass: "unknown", result: null, reason: "No consented human handoff observation was supplied for this benchmark case." };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["result", "evidenceClass", "consent", "participantRole", "observedDurationMs", "evidenceRef"].includes(key))) {
    throw new HandoffQualityError("invalid-human-handoff-observation", "humanHandoffObservation accepts only result, evidenceClass, consent, participantRole, observedDurationMs, and evidenceRef.");
  }
  if (!["located", "not-located", "inconclusive"].includes(value.result)) throw new HandoffQualityError("invalid-human-handoff-result", "humanHandoffObservation.result must be located, not-located, or inconclusive.");
  if (value.evidenceClass !== "human-observation") throw new HandoffQualityError("invalid-human-handoff-evidence", "humanHandoffObservation.evidenceClass must be human-observation.");
  if (value.consent !== "confirmed") throw new HandoffQualityError("missing-human-handoff-consent", "humanHandoffObservation requires consent: confirmed.");
  if (!HUMAN_HANDOFF_ROLES.has(value.participantRole)) throw new HandoffQualityError("invalid-human-handoff-role", `participantRole must be one of: ${[...HUMAN_HANDOFF_ROLES].join(", ")}.`);
  if (!Number.isSafeInteger(value.observedDurationMs) || value.observedDurationMs < 0 || value.observedDurationMs > 86_400_000) throw new HandoffQualityError("invalid-human-handoff-duration", "observedDurationMs must be an integer from 0 to 86400000.");
  if (typeof value.evidenceRef !== "string" || !value.evidenceRef.startsWith("fp://local/")) throw new HandoffQualityError("missing-human-handoff-evidence-ref", "humanHandoffObservation.evidenceRef must be a Flopeek Context Ref.");
  const evidenceRefStatus = resolveContextRef(graph, value.evidenceRef).status;
  if (!["current", "stale", "historical"].includes(evidenceRefStatus)) throw new HandoffQualityError("unresolved-human-handoff-evidence", "humanHandoffObservation.evidenceRef must resolve in the current project history.");
  return {
    status: "observed",
    evidenceClass: "human-observation",
    result: value.result,
    consent: "confirmed",
    participantRole: value.participantRole,
    observedDurationMs: value.observedDurationMs,
    evidenceRef: value.evidenceRef,
    evidenceRefStatus,
    limitation: "This is a consented, privacy-minimized human observation. It contains no participant identity and is not flow verification, runtime proof, or independent proof of task correctness.",
  };
}

function aggregate(cases) {
  const totalRefs = cases.reduce((sum, item) => sum + item.evidenceTraceability.total, 0);
  const resolvedRefs = cases.reduce((sum, item) => sum + item.evidenceTraceability.resolved, 0);
  const staleRequested = cases.reduce((sum, item) => sum + item.staleContextDetection.requested, 0);
  const staleDetected = cases.reduce((sum, item) => sum + item.staleContextDetection.detected, 0);
  const outcomes = cases.map((item) => item.agentTaskOutcome);
  const humanObservations = cases.map((item) => item.humanHandoffObservation);
  const observedHuman = humanObservations.filter((item) => item.status === "observed");
  const locatedDurations = observedHuman.filter((item) => item.result === "located").map((item) => item.observedDurationMs).sort((left, right) => left - right);
  const midpoint = locatedDurations.length ? Math.floor(locatedDurations.length / 2) : null;
  const medianDurationMs = !locatedDurations.length ? null : locatedDurations.length % 2 ? locatedDurations[midpoint] : (locatedDurations[midpoint - 1] + locatedDurations[midpoint]) / 2;
  return {
    caseCount: cases.length,
    retrievalOutcomes: {
      passed: cases.filter((item) => item.retrievalOutcome.status === "passed").length,
      failed: cases.filter((item) => item.retrievalOutcome.status === "failed").length,
      evidenceClass: "deterministic-fixture-oracle",
      limitation: "This measures retrieval against declared fixture expectations, not whether an AI changed code correctly.",
    },
    contextSize: {
      requestedTokens: cases.reduce((sum, item) => sum + item.contextSize.requestedTokenBudget, 0),
      estimatedTokens: cases.reduce((sum, item) => sum + item.contextSize.estimatedTokenCount, 0),
      withinBudget: cases.every((item) => item.contextSize.withinBudget),
      tokenizerIds: [...new Set(cases.map((item) => item.contextSize.tokenizerId))].sort(),
    },
    sourceEvidenceTraceability: { totalRefs, resolvedRefs, rate: totalRefs ? resolvedRefs / totalRefs : 1 },
    staleContextDetection: { requested: staleRequested, detected: staleDetected, rate: staleRequested ? staleDetected / staleRequested : null, status: staleRequested ? "measured" : "not-requested" },
    timing: {
      observedCompositionMilliseconds: Number(cases.reduce((sum, item) => sum + item.location.observedCompositionMilliseconds, 0).toFixed(3)),
      maximumDeterministicInspectionStages: Math.max(...cases.map((item) => item.location.deterministicInspectionStages)),
      gatePolicy: "Observed wall time is reported but is not a pass/fail gate because it depends on the host machine.",
    },
    agentTaskOutcomes: {
      suppliedEvidence: outcomes.filter((item) => item.status === "supplied-evidence").length,
      declared: outcomes.filter((item) => item.status === "declared").length,
      unavailable: outcomes.filter((item) => item.status === "unavailable").length,
      limitation: "Flopeek reports supplied outcomes and their evidence class; it does not infer an agent task result from context retrieval.",
    },
    humanHandoffObservations: {
      observed: observedHuman.length,
      unavailable: humanObservations.filter((item) => item.status === "unavailable").length,
      located: observedHuman.filter((item) => item.result === "located").length,
      notLocated: observedHuman.filter((item) => item.result === "not-located").length,
      inconclusive: observedHuman.filter((item) => item.result === "inconclusive").length,
      participantRoles: [...new Set(observedHuman.map((item) => item.participantRole))].sort(),
      timeToLocate: {
        status: locatedDurations.length ? "measured" : "unavailable",
        locatedObservationCount: locatedDurations.length,
        totalObservedMilliseconds: locatedDurations.reduce((sum, value) => sum + value, 0),
        meanObservedMilliseconds: locatedDurations.length ? Number((locatedDurations.reduce((sum, value) => sum + value, 0) / locatedDurations.length).toFixed(3)) : null,
        medianObservedMilliseconds: medianDurationMs,
        minimumObservedMilliseconds: locatedDurations[0] ?? null,
        maximumObservedMilliseconds: locatedDurations.at(-1) ?? null,
      },
      limitation: "Only explicitly consented, privacy-minimized human observations are counted. They are not participant identities, flow verification, runtime proof, or independent evidence of task correctness.",
    },
  };
}

function evaluateHandoffQuality(graph, input = {}, options = {}) {
  if (!graph?.project?.projectId || !Number.isSafeInteger(graph?.state?.graphVersion)) throw new HandoffQualityError("missing-graph-identity", "A current versioned graph is required.");
  if (typeof options.resolveContextRef !== "function") throw new HandoffQualityError("missing-context-resolver", "Quality evaluation requires the current Context Ref resolver.");
  if (input.requireHumanHandoffObservation !== undefined && typeof input.requireHumanHandoffObservation !== "boolean") throw new HandoffQualityError("invalid-human-handoff-requirement", "requireHumanHandoffObservation must be boolean when supplied.");
  const requireHumanHandoffObservation = input.requireHumanHandoffObservation === true;
  const cases = normalizeCases(input).map((benchmarkCase) => {
    const started = process.hrtime.bigint();
    const packet = createHandoffContext(graph, benchmarkCase.request);
    const observedCompositionMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
    const includedFeatureIds = new Set(packet.included.features.map((item) => item.id));
    const includedFlowTitles = new Set(packet.included.flows.map((item) => item.title));
    const missingFeatureIds = benchmarkCase.expected.featureIds.filter((id) => !includedFeatureIds.has(id));
    const missingFlowTitles = benchmarkCase.expected.flowTitles.filter((title) => !includedFlowTitles.has(title));
    const refs = [...contextRefs(packet)].sort();
    const refResults = refs.map((ref) => ({ ref, status: options.resolveContextRef(graph, ref).status }));
    const unresolvedRefs = refResults.filter((item) => !["current", "stale", "historical"].includes(item.status));
    const staleResults = benchmarkCase.staleContextRefs.map((ref) => ({ ref, status: options.resolveContextRef(graph, ref).status }));
    const undetectedStaleRefs = staleResults.filter((item) => !["stale", "historical", "successor-candidate"].includes(item.status));
    const withinBudget = packet.budget.status === "within-budget" && packet.budget.estimatedTokenCount <= packet.budget.requestedTokenBudget;
    const agentTaskOutcome = normalizedAgentOutcome(benchmarkCase.agentTaskOutcome);
    const humanHandoffObservation = normalizedHumanHandoffObservation(benchmarkCase.humanHandoffObservation, options.resolveContextRef, graph);
    if (agentTaskOutcome.status === "supplied-evidence" && !agentTaskOutcome.evidenceRef) {
      throw new HandoffQualityError("missing-agent-outcome-evidence", "Human-verified and runtime-evidence outcomes require a resolvable evidenceRef.");
    }
    if (agentTaskOutcome.evidenceRef) {
      agentTaskOutcome.evidenceRefStatus = options.resolveContextRef(graph, agentTaskOutcome.evidenceRef).status;
      if (!["current", "stale", "historical"].includes(agentTaskOutcome.evidenceRefStatus)) throw new HandoffQualityError("unresolved-agent-outcome-evidence", "agentTaskOutcome.evidenceRef must resolve in the current project history.");
    }
    const retrievalPassed = !missingFeatureIds.length && !missingFlowTitles.length && withinBudget && !unresolvedRefs.length && !undetectedStaleRefs.length;
    const deterministicInspectionStages = benchmarkCase.expected.flowTitles.length ? 3 : benchmarkCase.expected.featureIds.length ? 2 : 1;
    return {
      id: benchmarkCase.id,
      request: packet.request,
      location: {
        targetFound: !missingFeatureIds.length && !missingFlowTitles.length,
        deterministicInspectionStages,
        observedCompositionMilliseconds: Number(observedCompositionMilliseconds.toFixed(3)),
        missingFeatureIds,
        missingFlowTitles,
      },
      contextSize: {
        requestedTokenBudget: packet.budget.requestedTokenBudget,
        estimatedTokenCount: packet.budget.estimatedTokenCount,
        estimatedCharacterCount: packet.budget.estimatedCharacterCount,
        tokenizerId: packet.budget.tokenizerId,
        withinBudget,
      },
      evidenceTraceability: { total: refs.length, resolved: refs.length - unresolvedRefs.length, unresolved: unresolvedRefs },
      staleContextDetection: { requested: staleResults.length, detected: staleResults.length - undetectedStaleRefs.length, results: staleResults },
      retrievalOutcome: {
        status: retrievalPassed ? "passed" : "failed",
        evidenceClass: "deterministic-fixture-oracle",
        runtimeClaim: false,
        limitation: "A passing retrieval outcome proves only that declared bounded context expectations were found and traceable.",
      },
      agentTaskOutcome,
      humanHandoffObservation,
      packet,
    };
  });
  const summary = aggregate(cases);
  const criteria = {
    allExpectedTargetsLocated: summary.retrievalOutcomes.failed === 0,
    everyPacketWithinBudget: summary.contextSize.withinBudget,
    everyEvidenceRefTraceable: summary.sourceEvidenceTraceability.resolvedRefs === summary.sourceEvidenceTraceability.totalRefs,
    everyRequestedStaleRefDetected: summary.staleContextDetection.requested === summary.staleContextDetection.detected,
    everyCaseHasConsentedHumanObservation: !requireHumanHandoffObservation || summary.humanHandoffObservations.observed === cases.length,
  };
  return {
    schemaVersion: HANDOFF_QUALITY_SCHEMA,
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceBasis: sourceBasis(graph) },
    cases,
    summary,
    qualityGate: { status: Object.values(criteria).every(Boolean) ? "passed" : "failed", criteria },
    limitations: [
      "The benchmark does not execute repository code or claim runtime behavior.",
      "Observed composition time depends on the host and is not used as a deterministic gate.",
      "Retrieval success is not an AI coding-task outcome; agent outcomes remain separately declared, verified, or unavailable.",
      "Human handoff observations are opt-in, privacy-minimized inputs; Flopeek does not identify participants or promote an observation to verification or runtime behavior.",
    ],
  };
}

module.exports = { HANDOFF_QUALITY_SCHEMA, HandoffQualityError, evaluateHandoffQuality };
