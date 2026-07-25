#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { runPackageAudit } = require("../src/package-policy");

try {
  const { report } = runPackageAudit(path.resolve(__dirname, ".."), { dryRun: true });
  console.log(`Package audit: ${report.status}`);
  console.log(`${report.package.entries} files / ${report.package.packedBytes} packed bytes / ${report.package.unpackedBytes} unpacked bytes`);
  console.log(`Publishing approved by this audit: ${report.policy.releasePublishingApproved}`);
  if (report.errors.length) {
    for (const error of report.errors) console.error(`${error.code}: ${JSON.stringify(error.paths || error.actual || error)}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Package audit failed: ${error.message}`);
  process.exitCode = 1;
}
