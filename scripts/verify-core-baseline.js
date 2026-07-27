"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCoreBaselineCase, JS_CORE_BASELINE_SCHEMA } = require("../src/core-compatibility");
const { scanRepository } = require("../src/scanner");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES_ROOT = path.join(ROOT, "test", "fixtures");
const BASELINE_PATH = path.join(ROOT, "benchmarks", "js-core-baseline.json");

function fixtureNames() {
  return fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(FIXTURES_ROOT, entry.name, "expectations.json")))
    .map((entry) => entry.name)
    .sort();
}

function buildJsCoreBaseline() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return {
    schemaVersion: JS_CORE_BASELINE_SCHEMA,
    oracle: {
      implementation: "javascript",
      packageVersion: packageJson.version,
      command: "npm run verify:core-baseline",
    },
    compatibilitySchemaVersion: "flopeek-core-compatibility/v1",
    cases: fixtureNames().map((fixture) => {
      const root = path.join(FIXTURES_ROOT, fixture);
      const graph = scanRepository(root, { persistIdentity: false });
      return createCoreBaselineCase(fixture, `test/fixtures/${fixture}`, graph);
    }),
    excludedVolatileState: [
      "absolute repository root",
      "local project identity",
      "Git metadata",
      "scan timestamps",
      "graph version",
      "cache and adjacent-delta state",
      "manual descriptions",
    ],
    limitation: "This baseline proves deterministic static-fact compatibility only. It does not prove runtime behavior, performance parity, storage compatibility, or business intent.",
  };
}

function changedCases(expected, actual) {
  const expectedById = new Map((expected.cases || []).map((item) => [item.id, item]));
  const actualById = new Map((actual.cases || []).map((item) => [item.id, item]));
  return [...new Set([...expectedById.keys(), ...actualById.keys()])]
    .filter((id) => JSON.stringify(expectedById.get(id)) !== JSON.stringify(actualById.get(id)))
    .sort();
}

function verifyJsCoreBaseline() {
  const expected = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const actual = buildJsCoreBaseline();
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    const changed = changedCases(expected, actual);
    const suffix = changed.length ? ` Changed cases: ${changed.join(", ")}.` : "";
    throw new Error(`JavaScript core baseline drifted.${suffix} Review the semantic change, then run npm run update:core-baseline intentionally.`, { cause: error });
  }
  return actual;
}

if (require.main === module) {
  if (process.argv.includes("--update")) {
    const baseline = buildJsCoreBaseline();
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`Updated ${path.relative(ROOT, BASELINE_PATH)} with ${baseline.cases.length} cases.\n`);
  } else {
    const baseline = verifyJsCoreBaseline();
    process.stdout.write(`JavaScript core baseline matches ${baseline.cases.length} deterministic fixture cases.\n`);
  }
}

module.exports = { BASELINE_PATH, buildJsCoreBaseline, verifyJsCoreBaseline };
