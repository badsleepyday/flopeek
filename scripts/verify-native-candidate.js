#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  NATIVE_CANDIDATE_METADATA_SCHEMA,
  buildChecksums,
  canonicalJson,
  sourceDigestForCommit,
  validateCandidateBundle,
  validateCandidateInputs,
} = require("./native-candidate-bundle");
const { sha256File } = require("./native-release-manifest");

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(__dirname, "..");
  const bundle = argument(argv, "--bundle");
  const sourceSha = argument(argv, "--source-sha");
  const packageVersion = argument(argv, "--package-version");
  const releaseChannel = argument(argv, "--release-channel");
  const workflowRunId = argument(argv, "--workflow-run-id");
  const expectedManifestSha256 = argument(argv, "--expected-manifest-sha256");
  const finalize = argv.includes("--finalize");
  const requirePlatformInstallEvidence = argv.includes("--require-platform-install-evidence");
  if (!bundle) {
    if (![sourceSha, packageVersion, releaseChannel].every(Boolean)) {
      throw new Error("Usage: verify-native-candidate --source-sha <sha> --package-version <version> --release-channel <channel>, or --bundle <directory> [--finalize --workflow-run-id <id>].");
    }
    const inputs = validateCandidateInputs({ sourceSha, packageVersion, channel: releaseChannel });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (manifest.version !== inputs.packageVersion) throw new Error("candidate package version does not match package.json.");
    process.stdout.write(`${JSON.stringify(inputs)}\n`);
    return inputs;
  }
  const bundleRoot = path.resolve(bundle);
  if (finalize) {
    if (![sourceSha, packageVersion, releaseChannel, workflowRunId].every(Boolean)) {
      throw new Error("candidate finalization requires source SHA, package version, release channel, and workflow run ID.");
    }
    validateCandidateInputs({ sourceSha, packageVersion, channel: releaseChannel });
    const releaseManifest = path.join(bundleRoot, "native-release-manifest.json");
    const metadata = {
      schemaVersion: NATIVE_CANDIDATE_METADATA_SCHEMA,
      sourceSha,
      sourceDigest: sourceDigestForCommit(root, sourceSha),
      workflowRunId: String(workflowRunId),
      packageVersion,
      releaseChannel,
      releaseManifestSha256: sha256File(releaseManifest),
      status: "candidate-ready",
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(bundleRoot, "candidate-metadata.json"), canonicalJson(metadata));
    fs.writeFileSync(path.join(bundleRoot, "checksums.json"), canonicalJson(buildChecksums(bundleRoot)));
  }
  const result = validateCandidateBundle(bundleRoot, {
    expectedManifestSha256,
    expectedChannel: releaseChannel || undefined,
    requirePlatformInstallEvidence,
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "flopeek-native-candidate-verification/v1",
    status: "verified",
    sourceSha: result.metadata.sourceSha,
    packageVersion: result.metadata.packageVersion,
    releaseManifestSha256: result.manifestSha256,
  }, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Candidate blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
