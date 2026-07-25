#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { assertNpmPublicationApproved } = require("../src/npm-publication-approval");

try {
  const approval = assertNpmPublicationApproved(path.resolve(__dirname, ".."));
  console.log(`npm publication approved for ${approval.packageName}@${approval.version} with dist-tag ${approval.distTag}.`);
} catch (error) {
  console.error(`npm publication blocked: ${error.message}`);
  process.exitCode = 1;
}
