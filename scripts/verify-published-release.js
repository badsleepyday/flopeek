#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { assertGithubReleaseApproved, assertPublishedRegistryVersion } = require("../src/github-release-approval");

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : null;
const manifestIndex = process.argv.indexOf("--manifest");
const releaseManifest = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : null;

try {
  const approval = assertGithubReleaseApproved(path.resolve(__dirname, ".."), { tag, releaseManifest });
  const registry = assertPublishedRegistryVersion(approval);
  console.log(registry.checked
    ? `Published release verified: npm ${registry.distTag} resolves to ${registry.packageName}@${registry.version}.`
    : `Published release verification is not required for ${approval.release.channel}.`);
} catch (error) {
  console.error(`Published release verification failed: ${error.message}`);
  process.exitCode = 1;
}
