"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { adapterContractDigest } = require("./adapter-registry");
const {
  readPlatformNativePackageMetadata,
  resolvePlatformNativeBinary,
  verifyPlatformNativeBinary,
} = require("./native-incremental-coordinator");
const { NATIVE_PROTOCOL_VERSION } = require("./native-protocol-client");

const NATIVE_ROLLOUT_EVIDENCE_SCHEMA = "flopeek-native-rollout-evidence/v1";

function loadBundledNativeRolloutEvidence(root = path.resolve(__dirname, ".."), options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  const packageJson = JSON.parse(readFile(path.join(root, "package.json"), "utf8"));
  const packet = JSON.parse(readFile(path.join(root, "packaging", "native-rollout-evidence.json"), "utf8"));
  if (!packet || packet.schemaVersion !== NATIVE_ROLLOUT_EVIDENCE_SCHEMA
    || !["incomplete", "complete"].includes(packet.status)
    || !packet.binding || typeof packet.binding !== "object") {
    throw new Error(`Bundled native rollout evidence must use ${NATIVE_ROLLOUT_EVIDENCE_SCHEMA}.`);
  }
  const bindingMatches = packet.binding.packageName === packageJson.name
    && packet.binding.packageVersion === packageJson.version
    && packet.binding.adapterContractDigest === adapterContractDigest()
    && packet.binding.protocolVersion === NATIVE_PROTOCOL_VERSION;
  if (!bindingMatches) throw new Error("Bundled native rollout evidence does not match this package, adapter contract, and protocol.");
  if (packet.status === "incomplete") {
    if (packet.evidence !== null || packet.binding.binaries !== null) {
      throw new Error("Incomplete native rollout evidence must not carry decision evidence or binary bindings.");
    }
    return Object.freeze({ packet, evidence: Object.freeze({}), complete: false });
  }
  const binaries = packet.binding.binaries;
  if (!packet.evidence || !binaries || typeof binaries !== "object" || Array.isArray(binaries)
    || Object.keys(binaries).length !== Object.keys(packageJson.optionalDependencies || {}).length
    || Object.entries(packageJson.optionalDependencies || {}).some(([name]) => !/^[a-f0-9]{64}$/u.test(binaries[name] || ""))) {
    throw new Error("Complete native rollout evidence requires an exact SHA-256 for every platform binary and an evidence payload.");
  }
  return Object.freeze({ packet, evidence: Object.freeze(packet.evidence), complete: true });
}

function probeVerifiedNativeRuntime(root = path.resolve(__dirname, ".."), options = {}) {
  const packageJson = JSON.parse((options.readFile || fs.readFileSync)(path.join(root, "package.json"), "utf8"));
  const binary = (options.resolveBinary || resolvePlatformNativeBinary)();
  const metadata = (options.readMetadata || readPlatformNativePackageMetadata)();
  const expectedPackageVersion = metadata?.packageName
    ? packageJson.optionalDependencies?.[metadata.packageName]
    : null;
  const integrityVerified = Boolean(binary && metadata
    && metadata.version === packageJson.version
    && expectedPackageVersion === packageJson.version
    && (options.verifyBinary || verifyPlatformNativeBinary)(binary, metadata));
  const evidenceVerified = integrityVerified && (!options.expectedBinaries
    || options.expectedBinaries[metadata.packageName] === metadata.binarySha256);
  return Object.freeze({
    available: evidenceVerified,
    binary: evidenceVerified ? binary : null,
    packageName: metadata?.packageName || null,
    packageVersion: metadata?.version || null,
    binarySha256: metadata?.binarySha256 || null,
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    reason: evidenceVerified
      ? null
      : integrityVerified
        ? "native-runtime-not-bound-to-rollout-evidence"
        : "verified-platform-native-runtime-unavailable",
  });
}

module.exports = {
  NATIVE_ROLLOUT_EVIDENCE_SCHEMA,
  loadBundledNativeRolloutEvidence,
  probeVerifiedNativeRuntime,
};
