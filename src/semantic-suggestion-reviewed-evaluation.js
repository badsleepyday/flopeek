"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DECISIONS } = require("./semantic-suggestion-feedback");

const REVIEWED_DATASET_SCHEMA = "flowpeek-semantic-suggestion-reviewed-dataset/v1";
const REVIEWED_EVALUATION_SCHEMA = "flowpeek-semantic-suggestion-reviewed-evaluation/v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TRACE_STATUSES = new Set(["passed", "failed", "not-run"]);
const DEFAULT_GATE = Object.freeze({
  minimumHeldOut: 20,
  minimumRepositories: 3,
  minimumReviewers: 2,
  minimumSuggested: 12,
  minimumAbstained: 4,
  minimumUsefulRate: 0.8,
  maximumRejectedRate: 0.1,
  minimumAbstentionCorrectRate: 0.9,
  minimumTraceLinkedRate: 0.7,
  minimumPassedTraceRate: 0.5,
});

class ReviewedEvaluationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReviewedEvaluationError";
    this.code = code;
  }
}

function validIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function assertExactKeys(value, keys, entity) {
  const unexpected = Object.keys(value).filter((key) => !keys.has(key));
  if (unexpected.length) throw new ReviewedEvaluationError("unexpected-field", `${entity} contains unsupported field(s): ${unexpected.join(", ")}.`);
}

function assertDataset(dataset) {
  if (!dataset || typeof dataset !== "object" || Array.isArray(dataset) || dataset.schemaVersion !== REVIEWED_DATASET_SCHEMA) {
    throw new ReviewedEvaluationError("invalid-schema", `Dataset schemaVersion must be ${REVIEWED_DATASET_SCHEMA}.`);
  }
  assertExactKeys(dataset, new Set(["schemaVersion", "datasetKind", "template", "datasetId", "privacy", "records"]), "Dataset");
  if (dataset.datasetKind !== "consented-human-review") throw new ReviewedEvaluationError("invalid-dataset-kind", "Only a consented-human-review dataset can be evaluated for the recommendation gate.");
  if (!validIdentifier(dataset.datasetId)) throw new ReviewedEvaluationError("invalid-dataset-id", "datasetId must be an opaque identifier, not a repository path or URL.");
  if (typeof dataset.template !== "boolean") throw new ReviewedEvaluationError("missing-template-marker", "Dataset must declare template: false before it can be used as a reviewed cohort.");
  const privacy = dataset.privacy;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) throw new ReviewedEvaluationError("privacy-contract", "Dataset privacy must be an object.");
  assertExactKeys(privacy, new Set(["consentConfirmed", "containsSourceContent", "containsPrompts", "containsCredentials", "containsRawLogs"]), "Dataset privacy");
  if (!privacy || privacy.consentConfirmed !== true || privacy.containsSourceContent !== false || privacy.containsPrompts !== false || privacy.containsCredentials !== false || privacy.containsRawLogs !== false) {
    throw new ReviewedEvaluationError("privacy-contract", "Dataset privacy must confirm consent and exclude source content, prompts, credentials, and raw logs.");
  }
  if (!Array.isArray(dataset.records) || !dataset.records.length) throw new ReviewedEvaluationError("empty-records", "Dataset requires at least one reviewed record.");
  const recordIds = new Set();
  const caseIds = new Set();
  for (const record of dataset.records) assertRecord(record, recordIds, caseIds);
  return dataset;
}

function assertRecord(record, recordIds, caseIds) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new ReviewedEvaluationError("invalid-record", "Each reviewed record must be an object.");
  assertExactKeys(record, new Set(["id", "caseId", "repositoryAlias", "reviewerId", "reviewedAt", "split", "suggestionStatus", "decision", "abstentionVerdict", "traceVerificationStatus"]), "Reviewed record");
  for (const field of ["id", "caseId", "repositoryAlias", "reviewerId"]) {
    if (!validIdentifier(record[field])) throw new ReviewedEvaluationError("invalid-identifier", `${field} must be an opaque identifier with no paths, URLs, or free text.`);
  }
  if (recordIds.has(record.id)) throw new ReviewedEvaluationError("duplicate-record-id", `Duplicate reviewed record id: ${record.id}.`);
  if (caseIds.has(record.caseId)) throw new ReviewedEvaluationError("duplicate-case-id", `Case ${record.caseId} appears more than once; this would leak a case across dataset splits.`);
  recordIds.add(record.id);
  caseIds.add(record.caseId);
  if (!validIsoTimestamp(record.reviewedAt)) throw new ReviewedEvaluationError("invalid-reviewed-at", "reviewedAt must be an ISO-compatible timestamp.");
  if (!new Set(["training", "held-out"]).has(record.split)) throw new ReviewedEvaluationError("invalid-split", "split must be training or held-out.");
  if (!new Set(["suggested", "abstained"]).has(record.suggestionStatus)) throw new ReviewedEvaluationError("invalid-suggestion-status", "suggestionStatus must be suggested or abstained.");
  if (!DECISIONS.has(record.decision)) throw new ReviewedEvaluationError("invalid-decision", "decision must be accepted, edited, rejected, or abstained.");
  if (record.suggestionStatus === "suggested" && !new Set(["accepted", "edited", "rejected"]).has(record.decision)) {
    throw new ReviewedEvaluationError("incompatible-decision", "Suggested cases may only be accepted, edited, or rejected.");
  }
  if (record.suggestionStatus === "abstained" && record.decision !== "abstained") throw new ReviewedEvaluationError("incompatible-decision", "Abstained cases must have an abstained decision.");
  if (record.suggestionStatus === "abstained" && !new Set(["appropriate", "unnecessary"]).has(record.abstentionVerdict)) {
    throw new ReviewedEvaluationError("missing-abstention-verdict", "Abstained cases require an appropriate or unnecessary abstentionVerdict.");
  }
  if (record.suggestionStatus !== "abstained" && record.abstentionVerdict !== undefined) throw new ReviewedEvaluationError("unexpected-abstention-verdict", "Only abstained cases may include abstentionVerdict.");
  if (record.traceVerificationStatus !== undefined && !TRACE_STATUSES.has(record.traceVerificationStatus)) {
    throw new ReviewedEvaluationError("invalid-trace-status", "traceVerificationStatus must be passed, failed, or not-run when supplied.");
  }
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function gateCheck(id, label, actual, comparison, expected, applicable = true) {
  const passed = applicable && comparison(actual, expected);
  return { id, label, actual, expected, applicable, passed };
}

function evaluateReviewedDataset(dataset, gate = DEFAULT_GATE) {
  assertDataset(dataset);
  const heldOut = dataset.records.filter((record) => record.split === "held-out");
  const suggested = heldOut.filter((record) => record.suggestionStatus === "suggested");
  const abstained = heldOut.filter((record) => record.suggestionStatus === "abstained");
  const useful = suggested.filter((record) => record.decision === "accepted" || record.decision === "edited");
  const rejected = suggested.filter((record) => record.decision === "rejected");
  const appropriateAbstentions = abstained.filter((record) => record.abstentionVerdict === "appropriate");
  const traceLinked = heldOut.filter((record) => record.traceVerificationStatus !== undefined);
  const passedTraces = heldOut.filter((record) => record.traceVerificationStatus === "passed");
  const repositories = new Set(heldOut.map((record) => record.repositoryAlias));
  const reviewers = new Set(heldOut.map((record) => record.reviewerId));
  const metrics = {
    totalRecords: dataset.records.length,
    heldOut: heldOut.length,
    repositories: repositories.size,
    reviewers: reviewers.size,
    suggested: suggested.length,
    accepted: suggested.filter((record) => record.decision === "accepted").length,
    edited: suggested.filter((record) => record.decision === "edited").length,
    rejected: rejected.length,
    abstained: abstained.length,
    appropriateAbstentions: appropriateAbstentions.length,
    traceLinked: traceLinked.length,
    passedTraces: passedTraces.length,
    usefulnessRate: ratio(useful.length, suggested.length),
    rejectionRate: ratio(rejected.length, suggested.length),
    abstentionCorrectRate: ratio(appropriateAbstentions.length, abstained.length),
    traceLinkedRate: ratio(traceLinked.length, heldOut.length),
    passedTraceRate: ratio(passedTraces.length, heldOut.length),
  };
  const checks = [
    gateCheck("non-template-dataset", "Dataset is not a template", dataset.template, (actual, expected) => actual === expected, false),
    gateCheck("minimum-held-out", "Held-out reviewed cases", metrics.heldOut, (actual, expected) => actual >= expected, gate.minimumHeldOut),
    gateCheck("minimum-repositories", "Distinct repository aliases", metrics.repositories, (actual, expected) => actual >= expected, gate.minimumRepositories),
    gateCheck("minimum-reviewers", "Distinct reviewer pseudonyms", metrics.reviewers, (actual, expected) => actual >= expected, gate.minimumReviewers),
    gateCheck("minimum-suggested", "Held-out suggested cases", metrics.suggested, (actual, expected) => actual >= expected, gate.minimumSuggested),
    gateCheck("minimum-abstained", "Held-out abstained cases", metrics.abstained, (actual, expected) => actual >= expected, gate.minimumAbstained),
    gateCheck("usefulness-rate", "Accepted-or-edited rate", metrics.usefulnessRate, (actual, expected) => actual !== null && actual >= expected, gate.minimumUsefulRate),
    gateCheck("rejection-rate", "Rejected rate", metrics.rejectionRate, (actual, expected) => actual !== null && actual <= expected, gate.maximumRejectedRate),
    gateCheck("abstention-correctness", "Appropriate abstention rate", metrics.abstentionCorrectRate, (actual, expected) => actual !== null && actual >= expected, gate.minimumAbstentionCorrectRate),
    gateCheck("trace-linked-rate", "Trace-linked rate", metrics.traceLinkedRate, (actual, expected) => actual !== null && actual >= expected, gate.minimumTraceLinkedRate),
    gateCheck("passed-trace-rate", "Passed-trace rate", metrics.passedTraceRate, (actual, expected) => actual !== null && actual >= expected, gate.minimumPassedTraceRate),
  ];
  return {
    schemaVersion: REVIEWED_EVALUATION_SCHEMA,
    dataset: { datasetId: dataset.datasetId, datasetKind: dataset.datasetKind, template: dataset.template, privacy: dataset.privacy },
    gate,
    metrics,
    checks,
    eligible: checks.every((check) => check.passed),
    limitation: "This gate evaluates declared, consented human-review labels. It does not prove business behavior, runtime correctness, reviewer identity, or generalization beyond the held-out sample.",
  };
}

function formatPercent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function parseArgs(args) {
  const options = { datasetPath: null, requireGate: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--dataset") options.datasetPath = args[++index] || null;
    else if (args[index] === "--require-gate") options.requireGate = true;
    else throw new ReviewedEvaluationError("invalid-argument", `Unknown argument: ${args[index]}`);
  }
  if (!options.datasetPath) throw new ReviewedEvaluationError("missing-dataset", "Usage: npm run evaluate:reviewed-feedback -- --dataset <private-reviewed-dataset.json> [--require-gate]");
  return options;
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const datasetPath = path.resolve(options.datasetPath);
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const result = evaluateReviewedDataset(dataset);
  console.log(`Held-out cases ${result.metrics.heldOut}; repositories ${result.metrics.repositories}; reviewers ${result.metrics.reviewers}`);
  console.log(`Useful ${formatPercent(result.metrics.usefulnessRate)}; rejected ${formatPercent(result.metrics.rejectionRate)}; appropriate abstentions ${formatPercent(result.metrics.abstentionCorrectRate)}`);
  console.log(`Trace-linked ${formatPercent(result.metrics.traceLinkedRate)}; passed trace ${formatPercent(result.metrics.passedTraceRate)}`);
  for (const check of result.checks) {
    const percentage = typeof check.expected === "number" && check.expected >= 0 && check.expected <= 1 && (check.id.includes("rate") || check.id.includes("correctness"));
    const actual = check.actual === null ? "n/a" : percentage ? formatPercent(check.actual) : check.actual;
    const expected = percentage ? formatPercent(check.expected) : check.expected;
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.id}: ${actual} (gate ${expected})`);
  }
  console.log(`Recommendation gate: ${result.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`);
  if (options.requireGate && !result.eligible) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_GATE,
  REVIEWED_DATASET_SCHEMA,
  REVIEWED_EVALUATION_SCHEMA,
  ReviewedEvaluationError,
  assertDataset,
  evaluateReviewedDataset,
  parseArgs,
};
