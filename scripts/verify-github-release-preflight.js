#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { assertGithubReleaseApproved } = require("../src/github-release-approval");

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : null;

try {
  const approval = assertGithubReleaseApproved(path.resolve(__dirname, ".."), { tag });
  console.log(`GitHub release preflight approved for ${approval.release.tag}; registry state was not consulted.`);
} catch (error) {
  console.error(`GitHub release preflight blocked: ${error.message}`);
  process.exitCode = 1;
}
