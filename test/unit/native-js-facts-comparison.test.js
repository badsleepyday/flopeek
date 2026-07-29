"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compareProjection, compareResolution, nativeProjection, oracleProjection, resolutionProjection } = require("../../scripts/compare-native-js-facts");

test("native JavaScript fact comparison requires the complete ordered structural result", () => {
  const expected = oracleProjection({
    result: {
      imports: [{ specifier: "./orders", evidence: { file: "src/index.ts" } }],
      symbols: [{ type: "function", name: "submit", methods: [] }],
      calls: [{ name: "validate", source: { type: "function", name: "submit" } }],
      analysis: { parser: "typescript-ast", status: "parsed", confidence: "exact", diagnostics: 0 },
    },
  });
  const actual = nativeProjection({
    structural: expected,
  });
  assert.equal(compareProjection(expected, actual).status, "exact");
  const mismatch = compareProjection(expected, { ...actual, calls: [] });
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.fields.calls.status, "mismatch");
});

test("native JavaScript resolver comparison preserves canonical target ordering and metadata", () => {
  const expected = resolutionProjection({
    resolvedImports: [{ specifier: "./service", targetPath: "src/service.ts" }],
    resolvedPackages: [],
    externalImports: [{ specifier: "node-cron", nodeType: "external", metadata: { layer: "package" } }],
  });
  assert.equal(compareResolution(expected, resolutionProjection(expected)).status, "exact");
  assert.equal(compareResolution(expected, resolutionProjection({ ...expected, externalImports: [] })).status, "mismatch");
});
