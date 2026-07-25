#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { assertGithubReleaseApproved, assertPublishedRegistryVersion } = require("../src/github-release-approval");

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : null;

try {
  const approval = assertGithubReleaseApproved(path.resolve(__dirname, ".."), { tag });
  const registry = assertPublishedRegistryVersion(approval);
  console.log(registry.checked
    ? `GitHub release approved for ${approval.release.tag}; npm ${registry.distTag} resolves to ${registry.version}.`
    : `GitHub alpha source release approved for ${approval.release.tag}; npm publication is not required for alpha.`);
} catch (error) {
  console.error(`GitHub release blocked: ${error.message}`);
  process.exitCode = 1;
}
