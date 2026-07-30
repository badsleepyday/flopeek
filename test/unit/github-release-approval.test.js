"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
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
const {
  NATIVE_RELEASE_MANIFEST_SCHEMA,
  canonicalReleaseManifestBytes,
} = require("../../scripts/native-release-manifest");
const { nativePlatformPackageNames } = require("../../src/native-platform-targets");

const ROOT = path.resolve(__dirname, "..", "..");

function approvedRelease(releaseManifestSha256 = "a".repeat(64)) {
  return {
    status: "approved",
    release: { tag: "v0.2.1-beta.1", channel: "beta", packageName: "flopeek", version: "0.2.1-beta.1", npmDistTag: "beta" },
    evidence: {
      brandDecisionReference: "https://example.test/brand-decision",
      manualViewerReviewReference: "https://example.test/manual-viewer-review",
      releaseManifestSha256,
      reviewArtifacts: RELEASE_ROLES.map((role, index) => ({ role, providerId: `provider-${index < 4 ? index : index - 2}`, runId: `run-${role.toLowerCase()}`, reference: `https://example.test/reviews/${role.toLowerCase()}`, status: "approved" })),
    },
    approval: { approvedBy: "repository-maintainer", approvedAt: "2026-07-25T00:00:00.000Z", decisionReference: "https://example.test/release-decision" },
  };
}

function releaseManifest() {
  return {
    schemaVersion: NATIVE_RELEASE_MANIFEST_SCHEMA,
    release: {
      packageName: "flopeek",
      version: "0.2.1-beta.1",
      tag: "v0.2.1-beta.1",
      repositoryRevision: "b".repeat(40),
      sourceDigest: "c".repeat(64),
    },
    artifacts: {
      main: { filename: "flopeek-0.2.1-beta.1.tgz", sha256: "d".repeat(64) },
      rolloutEvidence: { filename: "native-rollout-evidence.json", sha256: "e".repeat(64) },
      native: Object.fromEntries(nativePlatformPackageNames().map((packageName, index) => [packageName, {
        filename: `${index}.tgz`,
        tarballSha256: String(index + 1).repeat(64),
        binarySha256: String(index + 2).repeat(64),
        target: `target-${index}`,
      }])),
    },
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
  assert.deepEqual(assertPublishedRegistryVersion(approval, { execFileSync: () => JSON.stringify("0.2.1-beta.1") }), { checked: true, packageName: "flopeek", version: "0.2.1-beta.1", distTag: "beta" });
  approval.evidence.reviewArtifacts[1].providerId = "provider-0";
  approval.evidence.reviewArtifacts[5].providerId = "provider-0";
  assert.throws(() => validateReviewArtifacts(approval.evidence.reviewArtifacts), /at least four distinct provider IDs/);
});

test("registry verification fails closed when the dist-tag does not resolve to the approved version", () => {
  const approval = approvedRelease();
  assert.throws(() => assertPublishedRegistryVersion(approval, { execFileSync: () => JSON.stringify("0.2.1-beta.0") }), /does not resolve to the approved package version/);
  assert.throws(() => assertPublishedRegistryVersion(approval, { execFileSync: () => { throw new Error("not found"); } }), /does not expose/);
  approval.release = { tag: "v0.2.1-alpha.1", channel: "alpha", packageName: "flopeek", version: "0.2.1-alpha.1", npmDistTag: "alpha" };
  assert.deepEqual(assertPublishedRegistryVersion(approval), { checked: false, reason: "alpha-source-release" });
});

test("owner approval is bound to the exact validated release manifest bytes", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-release-approval-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "packaging"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "flopeek", version: "0.2.1-beta.1" }));
  const manifestFile = path.join(root, "release-manifest.json");
  const manifestBytes = canonicalReleaseManifestBytes(releaseManifest());
  fs.writeFileSync(manifestFile, manifestBytes);
  const digest = crypto.createHash("sha256").update(manifestBytes).digest("hex");
  fs.writeFileSync(path.join(root, "packaging", "github-release-approval.json"), JSON.stringify({
    schemaVersion: "flopeek-github-release-approval/v2",
    ...approvedRelease(digest),
  }));
  assert.doesNotThrow(() => assertGithubReleaseApproved(root, {
    tag: "v0.2.1-beta.1",
    releaseManifest: manifestFile,
  }));

  fs.appendFileSync(manifestFile, " ");
  assert.throws(() => assertGithubReleaseApproved(root, {
    tag: "v0.2.1-beta.1",
    releaseManifest: manifestFile,
  }), /not bound to the exact release manifest/);
  assert.throws(() => assertGithubReleaseApproved(root, {
    tag: "v0.2.1-beta.1",
  }), /release manifest must be a non-empty string/);
});
