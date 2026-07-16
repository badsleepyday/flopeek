#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { verifyCleanRoomPackage, writeCleanRoomReport } = require("../src/clean-room-package");

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 && argv[index + 1] ? path.resolve(argv[index + 1]) : null;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const report = await verifyCleanRoomPackage(root);
  const output = outputArgument(process.argv.slice(2));
  if (output) writeCleanRoomReport(output, report);
  console.log(`Clean-room package verification: ${report.status}`);
  console.log(`${report.packageAudit.package.entries} files / ${report.artifact.packedBytes} packed bytes / ${report.packageAudit.package.unpackedBytes} unpacked bytes`);
  console.log(`Installed Flowpeek ${report.smoke.version.actual}; scanned ${report.smoke.scan.files} files and exposed ${report.smoke.mcp.toolCount} MCP tools.`);
  console.log(`Lifecycle scripts: disabled; target application executed: ${report.smoke.targetFixture.applicationExecuted}; publication attempted: ${report.publication.attempted}.`);
  if (output) console.log(`Evidence: ${output}`);
}

main().catch((error) => {
  console.error(`Clean-room package verification failed: ${error.message}`);
  if (error.report) console.error(JSON.stringify(error.report, null, 2));
  process.exitCode = 1;
});
