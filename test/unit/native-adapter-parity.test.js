"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { adapterContractDigest } = require("../../src/adapter-registry");
const {
  MINIMUM_ADAPTER_CASES,
  NATIVE_ADAPTER_PARITY_SCHEMA,
  nativeAdaptersFromParity,
  validateNativeAdapterParity,
} = require("../../src/native-rollout-gate");

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function evidence() {
  const binary = { sha256: "a".repeat(64), sourceRevision: "b".repeat(40) };
  const adapters = {};
  let sequence = 0;
  for (const adapterId of Object.keys(MINIMUM_ADAPTER_CASES).sort()) {
    const records = Array.from({ length: MINIMUM_ADAPTER_CASES[adapterId] }, (_, index) => {
      sequence += 1;
      const compatibilityDigest = digest(`compatibility:${adapterId}:${index}`);
      return {
        adapterId,
        caseId: `${adapterId}:case-${index + 1}`,
        fixtureId: `generated/${adapterId}/case-${index + 1}`,
        sourceDigest: digest(`source:${sequence}`),
        javascriptCompatibilityDigest: compatibilityDigest,
        nativeCompatibilityDigest: compatibilityDigest,
        exact: true,
        nativeParserHost: "rust-tree-sitter-source/v19",
        executionAdapterCapability: {
          id: adapterId,
          parser: `${adapterId}-native`,
          availability: "bundled",
          requiredToolchain: null,
        },
        binarySha256: binary.sha256,
        sourceRevision: binary.sourceRevision,
      };
    });
    adapters[adapterId] = {
      cases: records.length,
      exactCases: records.length,
      caseIds: records.map((record) => record.caseId),
      sourceDigests: records.map((record) => record.sourceDigest),
      compatibilityDigests: records.map((record) => record.nativeCompatibilityDigest),
      records,
    };
  }
  const cases = Object.values(adapters).reduce((sum, adapter) => sum + adapter.cases, 0);
  return {
    schemaVersion: NATIVE_ADAPTER_PARITY_SCHEMA,
    adapterContractDigest: adapterContractDigest(),
    generatedAt: "2026-07-30T00:00:00.000Z",
    binary,
    summary: { adapters: Object.keys(adapters).length, cases, exactCases: cases },
    adapters,
  };
}

test("machine adapter parity accepts only the complete exact required adapter set", () => {
  const value = evidence();
  assert.equal(validateNativeAdapterParity(value), true);
  assert.deepEqual(nativeAdaptersFromParity(value), Object.keys(MINIMUM_ADAPTER_CASES).sort());
});

test("machine adapter parity rejects a missing adapter", () => {
  const value = evidence();
  delete value.adapters.go;
  assert.throws(() => validateNativeAdapterParity(value), /must contain exactly/u);
});

test("machine adapter parity rejects duplicate fixture source content", () => {
  const value = evidence();
  value.adapters.go.records[1].sourceDigest = value.adapters.go.records[0].sourceDigest;
  value.adapters.go.sourceDigests[1] = value.adapters.go.sourceDigests[0];
  assert.throws(() => validateNativeAdapterParity(value), /Duplicate.*source digest/u);
});

test("machine adapter parity rejects compatibility divergence", () => {
  const value = evidence();
  value.adapters.csharp.records[0].nativeCompatibilityDigest = digest("diverged");
  value.adapters.csharp.compatibilityDigests[0] = digest("diverged");
  assert.throws(() => validateNativeAdapterParity(value), /not exact and binary-bound/u);
});

test("machine adapter parity rejects a case rebound to another binary or source revision", () => {
  const value = evidence();
  value.adapters.rust.records[0].binarySha256 = "c".repeat(64);
  assert.throws(() => validateNativeAdapterParity(value), /not exact and binary-bound/u);
});

test("machine adapter parity rejects a JavaScript parser host on the native path", () => {
  const value = evidence();
  value.adapters.python.records[0].nativeParserHost = "javascript-structural-fact-batch/v1";
  assert.throws(() => validateNativeAdapterParity(value), /not exact and binary-bound/u);
});
