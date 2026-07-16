"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DECISIONS, feedbackMetrics } = require("./semantic-suggestion-feedback");

function evaluationRecord(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !DECISIONS.has(item.decision)) {
    throw new Error("Invalid semantic suggestion feedback evaluation record.");
  }
  if (item.traceVerificationStatus !== undefined && (typeof item.traceVerificationStatus !== "string" || !item.traceVerificationStatus)) {
    throw new Error(`Invalid trace verification status for ${item.id}.`);
  }
  return {
    id: item.id,
    decision: item.decision,
    traceLink: item.traceVerificationStatus ? { verificationStatus: item.traceVerificationStatus } : null,
  };
}

function evaluateSemanticSuggestionFeedbackCorpus(corpus) {
  if (corpus?.schemaVersion !== "flowpeek-semantic-suggestion-feedback-evaluation/v1" || !Array.isArray(corpus.records) || !corpus.expected) {
    throw new Error("Invalid semantic suggestion feedback evaluation corpus.");
  }
  const metrics = feedbackMetrics(corpus.records.map(evaluationRecord));
  const mismatches = [];
  for (const key of ["total", "traceLinked"]) {
    if (metrics[key] !== corpus.expected[key]) mismatches.push(`${key}: expected ${corpus.expected[key]}, received ${metrics[key]}`);
  }
  for (const [decision, expected] of Object.entries(corpus.expected.decisions || {})) {
    if (metrics.decisions[decision] !== expected) mismatches.push(`decision ${decision}: expected ${expected}, received ${metrics.decisions[decision]}`);
  }
  for (const [status, expected] of Object.entries(corpus.expected.traceVerificationStatuses || {})) {
    if (metrics.traceVerificationStatuses[status] !== expected) mismatches.push(`trace ${status}: expected ${expected}, received ${metrics.traceVerificationStatuses[status]}`);
  }
  return {
    schemaVersion: corpus.schemaVersion,
    passed: mismatches.length === 0,
    metrics,
    mismatches,
    interpretation: corpus.interpretation,
  };
}

function main() {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "benchmarks", "semantic-suggestion-feedback-contract.json"), "utf8"));
  const result = evaluateSemanticSuggestionFeedbackCorpus(corpus);
  console.log(`${result.metrics.total} synthetic feedback metric records evaluated`);
  console.log(`Accepted ${result.metrics.decisions.accepted}; edited ${result.metrics.decisions.edited}; rejected ${result.metrics.decisions.rejected}; abstained ${result.metrics.decisions.abstained}`);
  console.log(`Trace-linked ${result.metrics.traceLinked}/${result.metrics.total}; ${result.passed ? "contract matched" : "contract mismatch"}`);
  if (!result.passed) {
    for (const mismatch of result.mismatches) console.error(mismatch);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { evaluateSemanticSuggestionFeedbackCorpus, evaluationRecord };
