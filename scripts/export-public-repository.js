#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { exportPublicRepository } = require("./lib/public-repository-policy");

const ROOT = path.resolve(__dirname, "..");
const POLICY = path.join(ROOT, "packaging", "public-repository-policy.json");
const index = process.argv.indexOf("--output");
const output = index >= 0 ? process.argv[index + 1] : null;

try {
  const result = exportPublicRepository(ROOT, POLICY, output);
  console.log(`Public repository candidate: ${result.output}`);
  console.log(`${result.report.candidate.files} files / version ${result.report.candidate.version}`);
  console.log(`Release readiness: ${result.report.releaseReadiness.technicalStatus}`);
  if (result.report.releaseReadiness.blockers.length) console.log(`Blockers: ${result.report.releaseReadiness.blockers.join(", ")}`);
  console.log("Git history copied: false; publication attempted: false; owner approval recorded: false");
} catch (error) {
  console.error(`Public repository export failed: ${error.message}`);
  process.exitCode = 1;
}
