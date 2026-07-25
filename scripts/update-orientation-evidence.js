"use strict";

const path = require("node:path");
const { atomicWriteJson } = require("../src/graph-cache");
const { evaluateOrientation, loadOrientationCases } = require("../src/orientation-benchmark");

const root = path.resolve(__dirname, "..");
const casesFile = path.join(root, "benchmarks", "orientation-cases.json");
const comparison = evaluateOrientation(root, loadOrientationCases(casesFile), { condition: "both" });
atomicWriteJson(path.join(root, "benchmarks", "orientation-baseline.json"), comparison.baseline);
atomicWriteJson(path.join(root, "benchmarks", "orientation-flowpeek.json"), comparison.flowpeek);
console.log(JSON.stringify({ baseline: comparison.baseline.summary.timing, flowpeek: comparison.flowpeek.summary.timing }, null, 2));
