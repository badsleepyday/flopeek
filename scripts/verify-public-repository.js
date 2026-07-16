#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { auditRepository } = require("./lib/public-repository-policy");

const ROOT = path.resolve(__dirname, "..");
const POLICY = path.join(ROOT, "packaging", "public-repository-policy.json");
const requireReleaseReady = process.argv.includes("--require-release-ready");

try {
  const { report } = auditRepository(ROOT, POLICY);
  console.log(`Public repository structure: ${report.structureStatus}`);
  console.log(`${report.candidate.files} files / ${report.candidate.bytes} bytes from ${report.source.revision || "unknown revision"}`);
  console.log(`Release readiness: ${report.releaseReadiness.technicalStatus}`);
  if (report.releaseReadiness.blockers.length) console.log(`Blockers: ${report.releaseReadiness.blockers.join(", ")}`);
  console.log("Public release approved by this audit: false");
  if (report.structureStatus !== "passed" || (requireReleaseReady && report.releaseReadiness.technicalStatus !== "eligible-for-owner-review")) process.exitCode = 1;
} catch (error) {
  console.error(`Public repository audit failed: ${error.message}`);
  process.exitCode = 1;
}
