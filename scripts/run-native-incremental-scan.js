"use strict";

const path = require("node:path");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { scanWithNativeIncremental } = require("../src/native-incremental-coordinator");

async function main() {
  const root = path.resolve(process.argv[2] || ".");
  const result = await scanWithNativeIncremental(root);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "flopeek-native-incremental-scan/v1",
    compatibilityDigest: createCoreCompatibilityDigest(result.graph),
    stats: result.graph.stats,
    native: result.native,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
