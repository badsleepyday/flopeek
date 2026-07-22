"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { evaluateSupportedLanguageDogfood } = require("../src/supported-language-dogfood");

test("supported-language dogfooding preserves audited static flow, semantic navigation, and Context Ref freshness boundaries", async () => {
  const report = await evaluateSupportedLanguageDogfood(path.resolve(__dirname, ".."));
  const checked = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "benchmarks", "supported-language-dogfood.json"), "utf8"));
  assert.deepEqual(report.outcomes.map((outcome) => outcome.language), ["TypeScript", "Python", "PHP"]);
  assert.deepEqual(checked.outcomes.map((outcome) => outcome.sourceDigest), report.outcomes.map((outcome) => outcome.sourceDigest));
  for (const outcome of report.outcomes) {
    assert.ok(outcome.relationshipAudit.precision >= 0.9, `${outcome.id}: precision`);
    assert.ok(outcome.relationshipAudit.recall >= 0.9, `${outcome.id}: recall`);
    assert.ok(outcome.supportedStaticEntry.displayedSteps >= 2, `${outcome.id}: flow steps`);
    assert.ok(Object.values(outcome.semanticLevels).every((count) => count >= 1), `${outcome.id}: semantic zoom`);
    assert.equal(outcome.mcp.contextRefResolved, true, `${outcome.id}: MCP Flow Context Ref`);
    assert.equal(outcome.contextResolution.before, "current");
    assert.equal(outcome.contextResolution.afterSourceOnlyEdit, "stale");
    assert.ok(outcome.refresh.toGraphVersion > outcome.refresh.fromGraphVersion, `${outcome.id}: graph version`);
    const checkedOutcome = checked.outcomes.find((candidate) => candidate.id === outcome.id);
    assert.equal(checkedOutcome.relationshipAudit.truePositives, outcome.relationshipAudit.truePositives, `${outcome.id}: checked audit`);
    assert.deepEqual(checkedOutcome.semanticLevels, outcome.semanticLevels, `${outcome.id}: checked semantic levels`);
  }
});
