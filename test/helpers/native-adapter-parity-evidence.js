"use strict";

const { adapterContractDigest } = require("../../src/adapter-registry");
const {
  MINIMUM_ADAPTER_CASES,
  NATIVE_ADAPTER_PARITY_SCHEMA,
} = require("../../src/native-rollout-gate");

function machineAdapterParityEvidence() {
  const binary = { sha256: "a".repeat(64), sourceRevision: "b".repeat(40) };
  const adapters = {};
  let sequence = 0;
  for (const adapterId of Object.keys(MINIMUM_ADAPTER_CASES).sort()) {
    const records = Array.from({ length: MINIMUM_ADAPTER_CASES[adapterId] }, (_, index) => {
      sequence += 1;
      const compatibilityDigest = `sha256:${(sequence + 1000).toString(16).padStart(64, "0")}`;
      return {
        adapterId,
        caseId: `${adapterId}:case-${index + 1}`,
        fixtureId: `generated/${adapterId}/case-${index + 1}`,
        sourceDigest: `sha256:${sequence.toString(16).padStart(64, "0")}`,
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

module.exports = { machineAdapterParityEvidence };
