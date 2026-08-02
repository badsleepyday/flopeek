"use strict";

const ALLOWED_LONG_LIVED_BRANCHES = new Set(["main", "development"]);
const ALLOWED_CHANGE_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "deps",
  "docs",
  "feature",
  "fix",
  "hotfix",
  "perf",
  "refactor",
  "release",
  "security",
  "test",
]);
const CHANGE_NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function validateBranchName(branchName, options = {}) {
  if (options.refType === "tag") {
    return { status: "passed", branchName: null, reason: "tag-ref-not-a-branch" };
  }
  if (typeof branchName !== "string" || !branchName.trim()) {
    return { status: "failed", branchName: null, reason: "branch-name-required" };
  }

  const normalized = branchName.trim();
  if (ALLOWED_LONG_LIVED_BRANCHES.has(normalized)) {
    return { status: "passed", branchName: normalized, reason: "allowed-long-lived-branch" };
  }

  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1 || normalized.indexOf("/", separator + 1) !== -1) {
    return { status: "failed", branchName: normalized, reason: "expected-sdlc-type-and-change-name" };
  }

  const type = normalized.slice(0, separator);
  const changeName = normalized.slice(separator + 1);
  if (!ALLOWED_CHANGE_TYPES.has(type)) {
    return { status: "failed", branchName: normalized, reason: "unsupported-sdlc-type" };
  }
  if (!CHANGE_NAME_PATTERN.test(changeName)) {
    return { status: "failed", branchName: normalized, reason: "invalid-change-name" };
  }
  return { status: "passed", branchName: normalized, reason: "allowed-short-lived-branch" };
}

function resolveBranchName(argv = process.argv, env = process.env) {
  return argv[2] || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "";
}

if (require.main === module) {
  const result = validateBranchName(resolveBranchName(), { refType: process.env.GITHUB_REF_TYPE });
  if (result.status === "failed") {
    console.error(
      `Branch name rejected (${result.reason}): ${result.branchName || "<missing>"}. ` +
      `Use <type>/<change-name> with one of: ${[...ALLOWED_CHANGE_TYPES].join(", ")}. ` +
      "Tool, vendor, or agent identity prefixes such as codex/ and agent/ are not allowed.",
    );
    process.exitCode = 1;
  } else {
    console.log(result.branchName ? `Branch name accepted: ${result.branchName}.` : "Tag ref accepted; branch-name policy not applicable.");
  }
}

module.exports = {
  ALLOWED_CHANGE_TYPES,
  ALLOWED_LONG_LIVED_BRANCHES,
  CHANGE_NAME_PATTERN,
  resolveBranchName,
  validateBranchName,
};
