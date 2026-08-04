"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const GITHUB_RELEASE_APPROVAL_SCHEMA = "flopeek-github-release-approval/v1";
const RELEASE_ROLES = ["Azka", "Bono", "Cuna", "Dana", "Hadi", "Iris"];
const RELEASE_CHANNELS = new Map([["alpha", "alpha"], ["beta", "beta"], ["rc", "rc"]]);

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}.`);
  const missing = expected.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${field} is missing fields: ${missing.join(", ")}.`);
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function releaseChannelForTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$/u.exec(tag);
  if (!match) throw new Error("release tag must be v<major>.<minor>.<patch> or a supported alpha, beta, or rc prerelease tag.");
  return { channel: match[2] ? RELEASE_CHANNELS.get(match[2]) : "stable", version: `${match[1]}${match[2] ? `-${match[2]}.${match[3]}` : ""}` };
}

function validateReviewArtifacts(value) {
  if (!Array.isArray(value) || value.length < RELEASE_ROLES.length) throw new Error("release evidence must contain all required reviewer artifacts.");
  const roles = new Set();
  const providers = new Set();
  const runIds = new Set();
  for (const [index, artifact] of value.entries()) {
    exactKeys(artifact, ["role", "providerId", "runId", "reference", "status"], `review artifact ${index}`);
    if (!RELEASE_ROLES.includes(artifact.role)) throw new Error(`review artifact ${index} has an unsupported role.`);
    if (artifact.status !== "approved") throw new Error(`review artifact ${index} must be approved.`);
    requiredText(artifact.providerId, `review artifact ${index} providerId`);
    requiredText(artifact.runId, `review artifact ${index} runId`);
    requiredText(artifact.reference, `review artifact ${index} reference`);
    if (roles.has(artifact.role)) throw new Error(`release evidence duplicates reviewer role ${artifact.role}.`);
    if (runIds.has(artifact.runId)) throw new Error(`release evidence duplicates reviewer run ${artifact.runId}.`);
    roles.add(artifact.role);
    providers.add(artifact.providerId);
    runIds.add(artifact.runId);
  }
  for (const role of RELEASE_ROLES) if (!roles.has(role)) throw new Error(`release evidence is missing the ${role} review artifact.`);
  if (providers.size < 4) throw new Error("release evidence must record at least four distinct provider IDs.");
}

function validateApprovedRelease(approval) {
  exactKeys(approval.release, ["tag", "channel", "packageName", "version", "npmDistTag"], "release approval release");
  exactKeys(approval.evidence, ["brandDecisionReference", "manualViewerReviewReference", "reviewArtifacts"], "release approval evidence");
  exactKeys(approval.approval, ["approvedBy", "approvedAt", "decisionReference"], "release approval decision");
  const parsed = releaseChannelForTag(requiredText(approval.release.tag, "release approval tag"));
  if (approval.release.channel !== parsed.channel) throw new Error("release approval channel does not match the tag.");
  if (approval.release.version !== parsed.version) throw new Error("release approval version does not match the tag.");
  requiredText(approval.release.packageName, "release approval packageName");
  requiredText(approval.release.npmDistTag, "release approval npmDistTag");
  if (parsed.channel === "beta" && approval.release.npmDistTag !== "beta") throw new Error("a beta release must use the beta npm dist-tag.");
  if (parsed.channel === "stable" && approval.release.npmDistTag !== "latest") throw new Error("a stable release must use the latest npm dist-tag.");
  requiredText(approval.evidence.brandDecisionReference, "brand decision reference");
  requiredText(approval.evidence.manualViewerReviewReference, "manual Viewer review reference");
  validateReviewArtifacts(approval.evidence.reviewArtifacts);
  requiredText(approval.approval.approvedBy, "release approval approvedBy");
  requiredText(approval.approval.decisionReference, "release approval decisionReference");
  if (!Number.isFinite(Date.parse(requiredText(approval.approval.approvedAt, "release approval approvedAt")))) throw new Error("release approval approvedAt must be an ISO date-time.");
}

function loadGithubReleaseApproval(file) {
  const approval = JSON.parse(fs.readFileSync(file, "utf8"));
  exactKeys(approval, ["schemaVersion", "status", "release", "evidence", "approval"], "GitHub release approval");
  if (approval.schemaVersion !== GITHUB_RELEASE_APPROVAL_SCHEMA) throw new Error(`GitHub release approval must use ${GITHUB_RELEASE_APPROVAL_SCHEMA}.`);
  if (!["not-approved", "approved"].includes(approval.status)) throw new Error("GitHub release approval status must be not-approved or approved.");
  if (approval.status === "not-approved") {
    if (approval.release !== null || approval.evidence !== null || approval.approval !== null) throw new Error("a not-approved GitHub release record must not contain release evidence or approval.");
    return approval;
  }
  validateApprovedRelease(approval);
  return approval;
}

function assertGithubReleaseApproved(root, options = {}) {
  const tag = requiredText(options.tag, "release tag");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const approval = loadGithubReleaseApproval(path.join(root, "packaging", "github-release-approval.json"));
  if (approval.status !== "approved") throw new Error("GitHub release is not approved; record the owner decision and independent release evidence first.");
  if (approval.release.tag !== tag) throw new Error("GitHub release approval does not match the pushed tag.");
  if (approval.release.packageName !== packageJson.name || approval.release.version !== packageJson.version) throw new Error("GitHub release approval does not match the package identity.");
  const parsed = releaseChannelForTag(tag);
  if (approval.release.channel !== parsed.channel) throw new Error("GitHub release approval channel does not match the pushed tag.");
  return approval;
}

function assertPublishedRegistryVersion(approval, options = {}) {
  const release = approval.release;
  if (release.channel === "alpha") return { checked: false, reason: "alpha-source-release" };
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  let output;
  try {
    output = execFileSync("npm", ["view", `${release.packageName}@${release.npmDistTag}`, "version", "--json", "--registry=https://registry.npmjs.org"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`npm registry does not expose ${release.packageName}@${release.npmDistTag} for the approved release.`);
  }
  let version;
  try {
    version = JSON.parse(output);
  } catch {
    version = String(output).trim();
  }
  if (version !== release.version) throw new Error("npm registry dist-tag does not resolve to the approved package version.");
  return { checked: true, packageName: release.packageName, version, distTag: release.npmDistTag };
}

module.exports = {
  GITHUB_RELEASE_APPROVAL_SCHEMA,
  RELEASE_ROLES,
  releaseChannelForTag,
  validateReviewArtifacts,
  validateApprovedRelease,
  loadGithubReleaseApproval,
  assertGithubReleaseApproved,
  assertPublishedRegistryVersion,
};
