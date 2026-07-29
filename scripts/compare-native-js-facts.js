"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { stableJson } = require("../src/core-compatibility");
const { createRepositoryScanner } = require("../src/scanner");
const { prepareStructuralFactBatch } = require("../src/structural-fact-adapter-host");

const ROOT = path.resolve(__dirname, "..");
const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "js-core-baseline.json"), "utf8"));
const SUPPORTED_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx"]);

const STRUCTURAL_FIELDS = Object.freeze([
  "imports", "symbols", "calls", "endpoints", "requests", "integrations",
  "runtimeActions", "schedules", "unsupportedSchedules", "methods", "analysis",
]);

function oracleProjection(record) {
  const result = record.result || {};
  return Object.fromEntries(STRUCTURAL_FIELDS.map((field) => [field,
    field === "analysis" ? result.analysis || null : Array.isArray(result[field]) ? result[field] : [],
  ]));
}

function nativeProjection(facts) {
  const structural = facts?.structural || {};
  return Object.fromEntries(STRUCTURAL_FIELDS.map((field) => [field,
    field === "analysis" ? structural.analysis || null : Array.isArray(structural[field]) ? structural[field] : [],
  ]));
}

function compareProjection(expected, actual) {
  const fields = {};
  for (const field of STRUCTURAL_FIELDS) {
    const status = stableJson(expected[field]) === stableJson(actual[field]) ? "exact" : "mismatch";
    fields[field] = status === "exact" ? { status } : { expected: expected[field], actual: actual[field], status };
  }
  return {
    status: Object.values(fields).every((field) => field.status === "exact") ? "exact" : "mismatch",
    fields,
  };
}

function resolutionProjection(value = {}) {
  return {
    resolvedImports: Array.isArray(value.resolvedImports) ? value.resolvedImports : [],
    resolvedPackages: Array.isArray(value.resolvedPackages) ? value.resolvedPackages : [],
    externalImports: Array.isArray(value.externalImports) ? value.externalImports : [],
  };
}

function compareResolution(expected, actual) {
  const fields = Object.fromEntries(Object.keys(expected).map((field) => {
    const status = stableJson(expected[field]) === stableJson(actual[field]) ? "exact" : "mismatch";
    return [field, status === "exact" ? { status } : { expected: expected[field], actual: actual[field], status }];
  }));
  return { status: Object.values(fields).every((field) => field.status === "exact") ? "exact" : "mismatch", fields };
}

function compareRecord(expected, actual) {
  const status = stableJson(expected) === stableJson(actual) ? "exact" : "mismatch";
  return status === "exact" ? { status } : { status, expected, actual };
}

function buildNativeBinary() {
  // One Cargo freshness check is sufficient for the complete fixture run.
  // Reusing only that just-built artifact keeps the gate reproducible without
  // paying process/build resolution overhead once per fixture.
  execFileSync("cargo", ["build", "--quiet", "--manifest-path", path.join(ROOT, "native", "flopeek-core", "Cargo.toml")], { cwd: ROOT, stdio: "inherit" });
  return path.join(ROOT, "native", "flopeek-core", "target", "debug", process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core");
}

function nativeFacts(binary, root) {
  return JSON.parse(execFileSync(binary, ["--native-js-facts", root], { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }));
}

function compareRoot(binary, root, id = path.basename(root)) {
  const scanner = createRepositoryScanner(root);
  const { prepared, batch } = prepareStructuralFactBatch(scanner);
  const native = nativeFacts(binary, root);
  const nativeByPath = native.facts || {};
  const nativeRecordsByPath = new Map((native.structuralRecords || []).map((record) => [record.relativePath, record]));
  const batchByPath = new Map(batch.records.map((record) => [record.relativePath, record]));
  const files = prepared.sourceRecords
    .filter((record) => SUPPORTED_EXTENSIONS.has(record.extension))
    .map((record) => {
      const parser = compareProjection(oracleProjection(record), nativeProjection(nativeByPath[record.relativePath]));
      const expectedResolution = resolutionProjection(batchByPath.get(record.relativePath)?.result);
      const actualResolution = resolutionProjection(native.resolution?.[record.relativePath]);
      const resolution = compareResolution(expectedResolution, actualResolution);
      const projectedRecord = batchByPath.get(record.relativePath);
      const structuralRecord = compareRecord(projectedRecord, nativeRecordsByPath.get(record.relativePath));
      return {
        path: record.relativePath,
        status: parser.status === "exact" && resolution.status === "exact" && structuralRecord.status === "exact" ? "exact" : "mismatch",
        parser,
        resolution,
        structuralRecord,
      };
    });
  return {
    id,
    status: files.every((file) => file.status === "exact") ? "exact" : "mismatch",
    files,
    parser: native.adapterVersion,
  };
}

function compareFixture(binary, fixture) {
  return compareRoot(binary, path.join(ROOT, fixture.fixture), fixture.id);
}

function requestedRoots(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root") continue;
    const value = argv[index + 1];
    if (!value) throw new Error("--root requires a repository path.");
    roots.push(path.resolve(value));
    index += 1;
  }
  return roots;
}

function main() {
  const binary = buildNativeBinary();
  const roots = requestedRoots(process.argv.slice(2));
  const cases = roots.length
    ? roots.map((root) => compareRoot(binary, root))
    : BASELINE.cases.map((fixture) => compareFixture(binary, fixture));
  const files = cases.flatMap((item) => item.files);
  const report = {
    schemaVersion: "flopeek-native-js-facts-comparison/v1",
    oracle: "javascript-scanner-record-subset",
    parser: "native-tree-sitter-source/v17",
    resolver: "native-js-resolver/v1",
    scope: "complete JavaScript/TypeScript scanner-result contract, import-resolution facts, and ordered StructuralFactBatch record projection",
    summary: {
      fixtures: cases.length,
      files: files.length,
      exactFiles: files.filter((file) => file.status === "exact").length,
      mismatchedFiles: files.filter((file) => file.status === "mismatch").length,
    },
    cases,
    limitation: "This comparison establishes JavaScript/TypeScript parser, resolver, and per-record StructuralFactBatch parity only in the declared fixture corpus. The complete batch envelope/digest, graph, ID, query, other-adapter, and runtime parity remain separate mandatory gates.",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--require-exact") && report.summary.mismatchedFiles > 0) {
    process.stderr.write(`Native JS/TS parser parity failed for ${report.summary.mismatchedFiles}/${report.summary.files} files.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { STRUCTURAL_FIELDS, buildNativeBinary, compareFixture, compareProjection, compareRecord, compareResolution, compareRoot, nativeProjection, oracleProjection, requestedRoots, resolutionProjection };
