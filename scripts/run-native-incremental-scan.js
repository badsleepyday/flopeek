"use strict";

const path = require("node:path");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { scanWithNativeIncremental } = require("../src/native-incremental-coordinator");

const root = path.resolve(process.argv[2] || ".");
const result = scanWithNativeIncremental(root);
process.stdout.write(`${JSON.stringify({
  schemaVersion: "flopeek-native-incremental-scan/v1",
  compatibilityDigest: createCoreCompatibilityDigest(result.graph),
  stats: result.graph.stats,
  native: result.native,
})}\n`);
