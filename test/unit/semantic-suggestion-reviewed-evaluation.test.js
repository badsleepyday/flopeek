const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_GATE, REVIEWED_DATASET_SCHEMA, ReviewedEvaluationError, evaluateReviewedDataset, parseArgs } = require("../../src/semantic-suggestion-reviewed-evaluation");

function qualifyingDataset() {
  const records = [];
  for (let index = 0; index < 14; index += 1) {
    records.push({
      id: `suggested-${index}`,
      caseId: `case-s-${index}`,
      repositoryAlias: `repo-${(index % 3) + 1}`,
      reviewerId: `reviewer-${(index % 2) + 1}`,
      reviewedAt: "2026-07-14T00:00:00.000Z",
      split: "held-out",
      suggestionStatus: "suggested",
      decision: index === 13 ? "rejected" : index % 3 === 0 ? "edited" : "accepted",
      traceVerificationStatus: index < 10 ? "passed" : undefined,
    });
  }
  for (let index = 0; index < 6; index += 1) {
    records.push({
      id: `abstained-${index}`,
      caseId: `case-a-${index}`,
      repositoryAlias: `repo-${(index % 3) + 1}`,
      reviewerId: `reviewer-${(index % 2) + 1}`,
      reviewedAt: "2026-07-14T00:00:00.000Z",
      split: "held-out",
      suggestionStatus: "abstained",
      decision: "abstained",
      abstentionVerdict: "appropriate",
      traceVerificationStatus: index < 4 ? "passed" : undefined,
    });
  }
  return {
    schemaVersion: REVIEWED_DATASET_SCHEMA,
    datasetKind: "consented-human-review",
    template: false,
    datasetId: "review-batch-a",
    privacy: { consentConfirmed: true, containsSourceContent: false, containsPrompts: false, containsCredentials: false, containsRawLogs: false },
    records,
  };
}

test("held-out human-review gate reports a qualifying privacy-safe cohort", () => {
  const result = evaluateReviewedDataset(qualifyingDataset());
  assert.equal(result.eligible, true);
  assert.equal(result.metrics.heldOut, 20);
  assert.equal(result.metrics.repositories, 3);
  assert.equal(result.metrics.reviewers, 2);
  assert.equal(result.metrics.usefulnessRate, 13 / 14);
  assert.equal(result.metrics.rejectionRate, 1 / 14);
  assert.equal(result.metrics.abstentionCorrectRate, 1);
  assert.equal(result.metrics.traceLinkedRate, 14 / 20);
  assert.equal(result.metrics.passedTraceRate, 14 / 20);
  assert.deepEqual(result.gate, DEFAULT_GATE);
  assert.equal(result.checks.every((check) => check.passed), true);
});

test("reviewed evaluation rejects privacy violations, leakage, and unsupported command input", () => {
  const privacyViolation = qualifyingDataset();
  privacyViolation.privacy.containsSourceContent = true;
  assert.throws(() => evaluateReviewedDataset(privacyViolation), (error) => error instanceof ReviewedEvaluationError && error.code === "privacy-contract");

  const leakage = qualifyingDataset();
  leakage.records[1].caseId = leakage.records[0].caseId;
  assert.throws(() => evaluateReviewedDataset(leakage), (error) => error.code === "duplicate-case-id");

  const invalidAlias = qualifyingDataset();
  invalidAlias.records[0].repositoryAlias = "C:\\private-repo";
  assert.throws(() => evaluateReviewedDataset(invalidAlias), (error) => error.code === "invalid-identifier");

  const injectedContent = qualifyingDataset();
  injectedContent.records[0].sourceContent = "function secret() {}";
  assert.throws(() => evaluateReviewedDataset(injectedContent), (error) => error.code === "unexpected-field");
  assert.throws(() => parseArgs([]), (error) => error.code === "missing-dataset");
});

test("gate remains ineligible until every held-out evidence threshold is met", () => {
  const insufficient = qualifyingDataset();
  insufficient.records = insufficient.records.slice(0, 19);
  const result = evaluateReviewedDataset(insufficient);
  assert.equal(result.eligible, false);
  assert.equal(result.checks.find((check) => check.id === "minimum-held-out").passed, false);
});
