"use strict";

const path = require("node:path");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { scanRepository } = require("../src/scanner");

const root = path.resolve(process.argv[2] || ".");
const graph = scanRepository(root);
process.stdout.write(`${JSON.stringify({ schemaVersion: "flopeek-js-core-scan/v1", compatibilityDigest: createCoreCompatibilityDigest(graph), stats: graph.stats })}\n`);
