"use strict";

const { adapterContractDigest } = require("./adapter-registry");

const NATIVE_ADAPTER_PARITY_SCHEMA = "flopeek-native-adapter-parity/v1";
const MINIMUM_ADAPTER_CASES = Object.freeze({
  typescript: 5,
  python: 3,
  go: 5,
  csharp: 5,
  java: 3,
  rust: 3,
  php: 3,
  svelte: 2,
});

function sha256(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function binarySha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function sameValues(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!sameValues(actual, wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function validateNativeAdapterParity(evidence, requiredAdapters = Object.keys(MINIMUM_ADAPTER_CASES).sort()) {
  requireExactKeys(evidence, [
    "schemaVersion",
    "adapterContractDigest",
    "generatedAt",
    "binary",
    "summary",
    "adapters",
  ], "native adapter parity evidence");
  if (evidence.schemaVersion !== NATIVE_ADAPTER_PARITY_SCHEMA) {
    throw new Error(`Native adapter parity evidence must use ${NATIVE_ADAPTER_PARITY_SCHEMA}.`);
  }
  if (evidence.adapterContractDigest !== adapterContractDigest()) {
    throw new Error("Native adapter parity evidence does not match the committed adapter contract.");
  }
  if (typeof evidence.generatedAt !== "string" || !Number.isFinite(Date.parse(evidence.generatedAt))) {
    throw new Error("Native adapter parity evidence requires a valid generatedAt timestamp.");
  }
  requireExactKeys(evidence.binary, ["sha256", "sourceRevision"], "native adapter parity binary");
  if (!binarySha256(evidence.binary.sha256)
    || !/^[a-f0-9]{40,64}$/u.test(evidence.binary.sourceRevision || "")) {
    throw new Error("Native adapter parity evidence requires an exact binary SHA-256 and source revision.");
  }
  requireExactKeys(evidence.summary, ["adapters", "cases", "exactCases"], "native adapter parity summary");
  requireExactKeys(evidence.adapters, requiredAdapters, "native adapter parity adapters");

  const seenCaseIds = new Set();
  const seenSourceDigests = new Set();
  let totalCases = 0;
  let totalExactCases = 0;
  for (const adapterId of requiredAdapters) {
    const adapter = evidence.adapters[adapterId];
    requireExactKeys(adapter, [
      "cases",
      "exactCases",
      "caseIds",
      "sourceDigests",
      "compatibilityDigests",
      "records",
    ], `native adapter parity adapter ${adapterId}`);
    const minimum = MINIMUM_ADAPTER_CASES[adapterId] || 1;
    if (!Number.isSafeInteger(adapter.cases) || adapter.cases < minimum
      || adapter.exactCases !== adapter.cases
      || !Array.isArray(adapter.records) || adapter.records.length !== adapter.cases) {
      throw new Error(`Native adapter parity adapter ${adapterId} requires at least ${minimum} exact machine cases.`);
    }
    const caseIds = [];
    const sourceDigests = [];
    const compatibilityDigests = [];
    for (const record of adapter.records) {
      requireExactKeys(record, [
        "adapterId",
        "caseId",
        "fixtureId",
        "sourceDigest",
        "javascriptCompatibilityDigest",
        "nativeCompatibilityDigest",
        "exact",
        "nativeParserHost",
        "executionAdapterCapability",
        "binarySha256",
        "sourceRevision",
      ], `native adapter parity case ${adapterId}`);
      if (record.adapterId !== adapterId
        || typeof record.caseId !== "string" || !record.caseId.startsWith(`${adapterId}:`)
        || typeof record.fixtureId !== "string" || !record.fixtureId
        || !sha256(record.sourceDigest)
        || !sha256(record.javascriptCompatibilityDigest)
        || record.nativeCompatibilityDigest !== record.javascriptCompatibilityDigest
        || record.exact !== true
        || record.nativeParserHost !== "rust-tree-sitter-source/v19"
        || record.binarySha256 !== evidence.binary.sha256
        || record.sourceRevision !== evidence.binary.sourceRevision) {
        throw new Error(`Native adapter parity case ${record.caseId || adapterId} is not exact and binary-bound.`);
      }
      const capability = record.executionAdapterCapability;
      if (!capability || capability.id !== adapterId
        || capability.availability !== "bundled"
        || typeof capability.parser !== "string" || !capability.parser
        || capability.requiredToolchain !== null) {
        throw new Error(`Native adapter parity case ${record.caseId} did not execute the bundled native adapter.`);
      }
      if (seenCaseIds.has(record.caseId)) {
        throw new Error(`Duplicate native adapter parity case ID: ${record.caseId}`);
      }
      if (seenSourceDigests.has(record.sourceDigest)) {
        throw new Error(`Duplicate native adapter parity source digest: ${record.sourceDigest}`);
      }
      seenCaseIds.add(record.caseId);
      seenSourceDigests.add(record.sourceDigest);
      caseIds.push(record.caseId);
      sourceDigests.push(record.sourceDigest);
      compatibilityDigests.push(record.nativeCompatibilityDigest);
    }
    if (!sameValues(adapter.caseIds, caseIds)
      || !sameValues(adapter.sourceDigests, sourceDigests)
      || !sameValues(adapter.compatibilityDigests, compatibilityDigests)) {
      throw new Error(`Native adapter parity adapter ${adapterId} summaries do not match their raw records.`);
    }
    totalCases += adapter.cases;
    totalExactCases += adapter.exactCases;
  }
  if (evidence.summary.adapters !== requiredAdapters.length
    || evidence.summary.cases !== totalCases
    || evidence.summary.exactCases !== totalExactCases) {
    throw new Error("Native adapter parity summary does not match its raw adapter records.");
  }
  return true;
}

function nativeAdaptersFromParity(evidence, requiredAdapters) {
  validateNativeAdapterParity(evidence, requiredAdapters);
  return Object.keys(evidence.adapters).sort();
}

module.exports = {
  MINIMUM_ADAPTER_CASES,
  NATIVE_ADAPTER_PARITY_SCHEMA,
  nativeAdaptersFromParity,
  validateNativeAdapterParity,
};
