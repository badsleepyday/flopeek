"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  RELEASE_ROLES,
  assertGithubReleaseApproved,
  assertPublishedRegistryVersion,
  releaseChannelForTag,
  validateApprovedRelease,
  validateReviewArtifacts,
} = require("../../src/github-release-approval");

const ROOT = path.resolve(__dirname, "..", "..");

function approvedRelease() {
  return {
    status: "approved",
    release: { tag: "v0.2.1-beta.1", channel: "beta", packageName: "flowpeek", version: "0.2.1-beta.1", npmDistTag: "beta" },
    evidence: {
      brandDecisionReference: "https://example.test/brand-decision",
      manualViewerReviewReference: "https://example.test/manual-viewer-review",
      reviewArtifacts: RELEASE_ROLES.map((role, index) => ({ role, providerId: `provider-${index < 4 ? index : index - 2}`, runId: `run-${role.toLowerCase()}`, reference: `https://example.test/reviews/${role.toLowerCase()}`, status: "approved" })),
    },
    approval: { approvedBy: "repository-maintainer", approvedAt: "2026-07-25T00:00:00.000Z", decisionReference: "https://example.test/release-decision" },
  };
}

test("GitHub releases require an explicit owner approval record", () => {
  assert.throws(() => assertGithubReleaseApproved(ROOT, { tag: "v0.2.1-beta.0" }), /GitHub release is not approved/);
});

test("release tags and approval evidence are exact and channel-aware", () => {
  assert.deepEqual(releaseChannelForTag("v1.2.3"), { channel: "stable", version: "1.2.3" });
  assert.deepEqual(releaseChannelForTag("v1.2.3-beta.4"), { channel: "beta", version: "1.2.3-beta.4" });
  assert.throws(() => releaseChannelForTag("v1.2.3-preview.1"), /supported alpha, beta, or rc/);
  const approval = approvedRelease();
  assert.doesNotThrow(() => validateApprovedRelease(approval));
  assert.deepEqual(assertPublishedRegistryVersion(approval, { execFileSync: () => JSON.stringify("0.2.1-beta.1") }), { checked: true, packageName: "flowpeek", version: "0.2.1-beta.1", distTag: "beta" });
  approval.evidence.reviewArtifacts[1].providerId = "provider-0";
  approval.evidence.reviewArtifacts[5].providerId = "provider-0";
  assert.throws(() => validateReviewArtifacts(approval.evidence.reviewArtifacts), /at least four distinct provider IDs/);
});

test("registry verification fails closed when the dist-tag does not resolve to the approved version", () => {
  const approval = approvedRelease();
  assert.throws(() => assertPublishedRegistryVersion(approval, { execFileSync: () => JSON.stringify("0.2.1-beta.0") }), /does not resolve to the approved package version/);
  assert.throws(() => assertPublishedRegistryVersion(approval, { execFileSync: () => { throw new Error("not found"); } }), /does not expose/);
  approval.release = { tag: "v0.2.1-alpha.1", channel: "alpha", packageName: "flowpeek", version: "0.2.1-alpha.1", npmDistTag: "alpha" };
  assert.deepEqual(assertPublishedRegistryVersion(approval), { checked: false, reason: "alpha-source-release" });
});
