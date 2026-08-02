"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { resolveBranchName, validateBranchName } = require("../../scripts/verify-branch-name");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "verify-branch-name.js");

test("branch policy accepts protected long-lived and typed short-lived SDLC branches", () => {
  for (const branch of [
    "main",
    "development",
    "feature/context-card-export",
    "fix/sse-readiness",
    "docs/public-beta",
    "release/v0.2.1-beta.2",
    "hotfix/registry-tag",
    "chore/branch-policy",
    "ci/platform-matrix",
    "test/package-contract",
  ]) {
    assert.equal(validateBranchName(branch).status, "passed", branch);
  }
});

test("branch policy rejects tool identity, personal, malformed, and permanent channel branches", () => {
  for (const branch of [
    "codex/branch-policy",
    "agent/branch-policy",
    "badsleepyday/branch-policy",
    "feature",
    "feature/",
    "feature/nested/change",
    "feature/Uppercase",
    "beta",
  ]) {
    assert.equal(validateBranchName(branch).status, "failed", branch);
  }
});

test("branch policy resolves pull-request heads, accepts tag events, and fails closed in CI", () => {
  assert.equal(resolveBranchName(["node", SCRIPT], { GITHUB_HEAD_REF: "fix/from-pr", GITHUB_REF_NAME: "merge" }), "fix/from-pr");
  assert.equal(resolveBranchName(["node", SCRIPT], { GITHUB_REF_NAME: "main" }), "main");
  assert.deepEqual(validateBranchName("", { refType: "tag" }), {
    status: "passed",
    branchName: null,
    reason: "tag-ref-not-a-branch",
  });

  const accepted = spawnSync(process.execPath, [SCRIPT, "chore/branch-policy"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Branch name accepted/);

  const rejected = spawnSync(process.execPath, [SCRIPT, "codex/branch-policy"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Tool, vendor, or agent identity prefixes/);
});
