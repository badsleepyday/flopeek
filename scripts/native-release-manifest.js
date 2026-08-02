"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { nativePlatformPackageNames } = require("../src/native-platform-targets");
const { NATIVE_ROLLOUT_EVIDENCE_SCHEMA } = require("../src/native-rollout-evidence");

const NATIVE_RELEASE_MANIFEST_SCHEMA = "flopeek-native-release-manifest/v1";

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}.`);
  if (missing.length) throw new Error(`${field} is missing fields: ${missing.join(", ")}.`);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function validateNativeReleaseManifest(manifest) {
  exactKeys(manifest, ["schemaVersion", "release", "artifacts"], "release manifest");
  if (manifest.schemaVersion !== NATIVE_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`release manifest must use ${NATIVE_RELEASE_MANIFEST_SCHEMA}.`);
  }
  exactKeys(manifest.release, ["packageName", "version", "tag", "repositoryRevision", "sourceDigest"], "release manifest identity");
  requiredText(manifest.release.packageName, "release manifest packageName");
  requiredText(manifest.release.version, "release manifest version");
  if (manifest.release.tag !== `v${manifest.release.version}`) throw new Error("release manifest tag must exactly match its version.");
  if (!/^[a-f0-9]{40,64}$/u.test(manifest.release.repositoryRevision || "")) throw new Error("release manifest repositoryRevision is invalid.");
  if (!validSha256(manifest.release.sourceDigest)) throw new Error("release manifest sourceDigest is invalid.");
  exactKeys(manifest.artifacts, ["main", "rolloutEvidence", "native"], "release manifest artifacts");
  for (const [field, artifact] of [["main", manifest.artifacts.main], ["rolloutEvidence", manifest.artifacts.rolloutEvidence]]) {
    exactKeys(artifact, ["filename", "sha256"], `release manifest ${field} artifact`);
    requiredText(artifact.filename, `release manifest ${field} filename`);
    if (!validSha256(artifact.sha256)) throw new Error(`release manifest ${field} sha256 is invalid.`);
  }
  exactKeys(manifest.artifacts.native, nativePlatformPackageNames(), "release manifest native artifacts");
  for (const packageName of nativePlatformPackageNames()) {
    const artifact = manifest.artifacts.native[packageName];
    exactKeys(artifact, ["filename", "tarballSha256", "binarySha256", "target"], `release manifest ${packageName}`);
    requiredText(artifact.filename, `release manifest ${packageName} filename`);
    if (!validSha256(artifact.tarballSha256) || !validSha256(artifact.binarySha256)) {
      throw new Error(`release manifest ${packageName} checksums are invalid.`);
    }
    requiredText(artifact.target, `release manifest ${packageName} target`);
  }
  return manifest;
}

function canonicalReleaseManifestBytes(manifest) {
  validateNativeReleaseManifest(manifest);
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function findExactNativeTarball(assets, packageName, version) {
  const prefix = `${packageName.replace("@flopeek/", "flopeek-")}-${version}`;
  const matches = fs.readdirSync(assets)
    .filter((filename) => filename.startsWith(prefix) && filename.endsWith(".tgz"));
  if (matches.length !== 1) throw new Error(`expected exactly one release tarball for ${packageName}@${version}.`);
  return path.join(assets, matches[0]);
}

function tarJson(tarball, member, execFileSync) {
  return JSON.parse(execFileSync("tar", ["-xOf", tarball, member], { encoding: "utf8" }));
}

function tarBytes(tarball, member, execFileSync) {
  const output = execFileSync("tar", ["-xOf", tarball, member], { encoding: null });
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function buildNativeReleaseManifest({ root, tag, mainTarball, rolloutEvidence, assets, execFileSync = childProcess.execFileSync }) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (tag !== `v${packageJson.version}`) throw new Error("release manifest tag does not match package.json.");
  const main = path.resolve(mainTarball);
  const evidenceFile = path.resolve(rolloutEvidence);
  const assetsDirectory = path.resolve(assets);
  const packedPackage = tarJson(main, "package/package.json", execFileSync);
  if (packedPackage.name !== packageJson.name || packedPackage.version !== packageJson.version) {
    throw new Error("main tarball identity does not match package.json.");
  }
  const packetBytes = fs.readFileSync(evidenceFile);
  const packet = JSON.parse(packetBytes);
  if (packet.schemaVersion !== NATIVE_ROLLOUT_EVIDENCE_SCHEMA || packet.status !== "complete") {
    throw new Error("release manifest requires complete native rollout evidence.");
  }
  if (packet.binding?.packageName !== packageJson.name || packet.binding?.packageVersion !== packageJson.version) {
    throw new Error("rollout evidence identity does not match the main package.");
  }
  const packedPacketBytes = tarBytes(main, "package/packaging/native-rollout-evidence.json", execFileSync);
  if (sha256Bytes(packedPacketBytes) !== sha256Bytes(packetBytes)) {
    throw new Error("main tarball does not contain the exact rollout evidence file.");
  }
  const native = {};
  for (const packageName of nativePlatformPackageNames()) {
    const binding = packet.binding.binaries?.[packageName];
    if (!binding) throw new Error(`rollout evidence lacks ${packageName}.`);
    const tarball = findExactNativeTarball(assetsDirectory, packageName, packageJson.version);
    const tarballSha256 = sha256File(tarball);
    const nativePackage = tarJson(tarball, "package/package.json", execFileSync);
    if (tarballSha256 !== binding.tarballSha256
      || nativePackage.name !== packageName
      || nativePackage.version !== packageJson.version
      || nativePackage.flopeekNative?.binarySha256 !== binding.binarySha256
      || nativePackage.flopeekNative?.target !== binding.target) {
      throw new Error(`${packageName} does not match the exact rollout evidence binding.`);
    }
    native[packageName] = {
      filename: path.basename(tarball),
      tarballSha256,
      binarySha256: binding.binarySha256,
      target: binding.target,
    };
  }
  return validateNativeReleaseManifest({
    schemaVersion: NATIVE_RELEASE_MANIFEST_SCHEMA,
    release: {
      packageName: packageJson.name,
      version: packageJson.version,
      tag,
      repositoryRevision: packet.binding.repositoryRevision,
      sourceDigest: packet.binding.sourceDigest,
    },
    artifacts: {
      main: { filename: path.basename(main), sha256: sha256File(main) },
      rolloutEvidence: { filename: path.basename(evidenceFile), sha256: sha256Bytes(packetBytes) },
      native,
    },
  });
}

function loadNativeReleaseManifest(file) {
  return validateNativeReleaseManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

module.exports = {
  NATIVE_RELEASE_MANIFEST_SCHEMA,
  buildNativeReleaseManifest,
  canonicalReleaseManifestBytes,
  loadNativeReleaseManifest,
  sha256File,
  validateNativeReleaseManifest,
};
