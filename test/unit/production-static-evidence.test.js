"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

test("production static evidence remains pinned, complete, and explicit about its non-runtime boundary", () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "production-static-evidence.json"), "utf8"));
  assert.equal(evidence.schemaVersion, "flopeek-production-static-evidence/v1");
  assert.equal(evidence.flopeek.workingTree, "dirty");
  assert.equal(evidence.externalRelationshipAudit.manifest, "benchmarks/real-repository-corpus.json");
  assert.equal(evidence.externalRelationshipAudit.completedRepositories, evidence.externalRelationshipAudit.totalRepositories);
  assert.equal(evidence.externalRelationshipAudit.auditedRelationships, 92);
  assert.equal(evidence.externalRelationshipAudit.truePositives, 92);
  assert.equal(evidence.externalRelationshipAudit.falsePositives, 0);
  assert.equal(evidence.externalRelationshipAudit.falseNegatives, 0);
  assert.equal(evidence.externalRelationshipAudit.precision, 1);
  assert.equal(evidence.externalRelationshipAudit.recall, 1);
  assert.equal(evidence.djangoFrameworkEntryAudit.revision, "a3b1107a4955bdd994908efb4c6e1d03c281e69f");
  assert.equal(evidence.djangoFrameworkEntryAudit.supportedDjangoManagementCommands, 47);
  assert.equal(evidence.djangoFrameworkEntryAudit.frameworkCommandFlowLenses, 24);
  assert.equal(evidence.djangoFrameworkEntryAudit.checkedRelation.status, "passed");
  assert.ok(evidence.limitations.some((item) => item.includes("does not execute target applications")));
  assert.ok(evidence.limitations.some((item) => item.includes("not a general language-support score")));
});
