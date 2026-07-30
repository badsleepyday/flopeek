"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  NATIVE_PROMOTION_APPROVAL_SCHEMA,
  buildChecksums,
  buildPromotionAttestation,
  validateCandidateInputs,
  validateChecksums,
} = require("../../scripts/native-candidate-bundle");

test("candidate inputs bind an exact commit, semantic version, and matching channel", () => {
  const sourceSha = "a".repeat(40);
  assert.deepEqual(validateCandidateInputs({
    sourceSha,
    packageVersion: "1.2.3-beta.4",
    channel: "beta",
  }), { sourceSha, packageVersion: "1.2.3-beta.4", channel: "beta" });
  assert.throws(() => validateCandidateInputs({
    sourceSha: "main",
    packageVersion: "1.2.3-beta.4",
    channel: "beta",
  }), /exact lowercase 40-character/);
  assert.throws(() => validateCandidateInputs({
    sourceSha,
    packageVersion: "1.2.3-beta.4",
    channel: "latest",
  }), /does not match package version channel/);
  assert.throws(() => validateCandidateInputs({
    sourceSha,
    packageVersion: "1.2",
    channel: "latest",
  }), /exact supported semantic version/);
});

test("candidate checksums cover every regular file and reject tampering and omission", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-candidate-checksums-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "profiles"));
  fs.writeFileSync(path.join(root, "artifact.tgz"), "artifact");
  fs.writeFileSync(path.join(root, "profiles", "profile.json"), "{}\n");
  const checksums = buildChecksums(root);
  assert.deepEqual(Object.keys(checksums), ["artifact.tgz", "profiles/profile.json"]);
  assert.doesNotThrow(() => validateChecksums(root, checksums));
  fs.appendFileSync(path.join(root, "artifact.tgz"), "tampered");
  assert.throws(() => validateChecksums(root, checksums), /checksum mismatch/);
  assert.throws(() => validateChecksums(root, { "artifact.tgz": checksums["artifact.tgz"] }), /missing fields/);
});

test("promotion attestation is generated from exact approved candidate identity", () => {
  const value = buildPromotionAttestation({
    candidateRunId: "12345",
    releaseManifestSha256: "b".repeat(64),
    sourceSha: "a".repeat(40),
    packageVersion: "1.2.3",
    channel: "latest",
    promotedBy: "octocat",
    promotedAt: "2026-07-30T00:00:00.000Z",
    result: "dry-run-verified",
  });
  assert.equal(value.schemaVersion, NATIVE_PROMOTION_APPROVAL_SCHEMA);
  assert.equal(value.result, "dry-run-verified");
  assert.throws(() => buildPromotionAttestation({
    ...value,
    releaseManifestSha256: "not-a-digest",
  }), /lowercase SHA-256/);
  assert.throws(() => buildPromotionAttestation({
    ...value,
    candidateRunId: "0",
  }), /GitHub Actions run/);
});
