"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildNativeReleaseManifest,
  canonicalReleaseManifestBytes,
  validateNativeReleaseManifest,
} = require("../../scripts/native-release-manifest");
const { NATIVE_PLATFORM_TARGETS } = require("../../src/native-platform-targets");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-release-manifest-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets);
  const version = "1.2.3-beta.4";
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "flopeek", version }));
  const mainTarball = path.join(root, `flopeek-${version}.tgz`);
  fs.writeFileSync(mainTarball, "exact main bytes");
  const nativeManifests = new Map();
  const binaries = {};
  for (const [index, target] of NATIVE_PLATFORM_TARGETS.entries()) {
    const filename = `${target.packageName.replace("@flopeek/", "flopeek-")}-${version}.tgz`;
    const tarball = path.join(assets, filename);
    const bytes = Buffer.from(`native-tarball-${index}`);
    fs.writeFileSync(tarball, bytes);
    const binarySha256 = sha256(Buffer.from(`binary-${index}`));
    binaries[target.packageName] = {
      binarySha256,
      tarballSha256: sha256(bytes),
      repositoryRevision: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      compiler: { version: "rustc 1.2.3" },
      target: target.rustTarget,
    };
    nativeManifests.set(tarball, {
      name: target.packageName,
      version,
      flopeekNative: { binarySha256, target: target.rustTarget },
    });
  }
  const packet = {
    schemaVersion: "flopeek-native-rollout-evidence/v2",
    status: "complete",
    binding: {
      packageName: "flopeek",
      packageVersion: version,
      repositoryRevision: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      binaries,
    },
    evidence: {},
  };
  const packetBytes = Buffer.from(`${JSON.stringify(packet, null, 2)}\n`);
  const rolloutEvidence = path.join(root, "native-rollout-evidence.json");
  fs.writeFileSync(rolloutEvidence, packetBytes);
  const execFileSync = (_command, args, options) => {
    const [operation, tarball, member] = args;
    assert.equal(operation, "-xOf");
    if (tarball === mainTarball && member === "package/package.json") {
      return JSON.stringify({ name: "flopeek", version });
    }
    if (tarball === mainTarball && member === "package/packaging/native-rollout-evidence.json") {
      return options.encoding === null ? packetBytes : packetBytes.toString("utf8");
    }
    return JSON.stringify(nativeManifests.get(tarball));
  };
  return { root, assets, mainTarball, rolloutEvidence, execFileSync, version, packet };
}

test("release manifest binds the exact main, rollout, native tarball, and native binary bytes", (context) => {
  const value = fixture(context);
  const manifest = buildNativeReleaseManifest({
    ...value,
    tag: `v${value.version}`,
  });
  assert.doesNotThrow(() => validateNativeReleaseManifest(manifest));
  assert.equal(manifest.artifacts.main.sha256, sha256(fs.readFileSync(value.mainTarball)));
  assert.equal(manifest.artifacts.rolloutEvidence.sha256, sha256(fs.readFileSync(value.rolloutEvidence)));
  for (const target of NATIVE_PLATFORM_TARGETS) {
    assert.equal(
      manifest.artifacts.native[target.packageName].binarySha256,
      value.packet.binding.binaries[target.packageName].binarySha256,
    );
  }
  assert.equal(canonicalReleaseManifestBytes(manifest).at(-1), 10);
});

test("release manifest fails closed for a changed artifact or unbound field", (context) => {
  const value = fixture(context);
  const first = NATIVE_PLATFORM_TARGETS[0];
  const tarball = path.join(value.assets, `${first.packageName.replace("@flopeek/", "flopeek-")}-${value.version}.tgz`);
  fs.appendFileSync(tarball, "tampered");
  assert.throws(() => buildNativeReleaseManifest({
    ...value,
    tag: `v${value.version}`,
  }), /does not match the exact rollout evidence binding/);
  assert.throws(() => validateNativeReleaseManifest({
    schemaVersion: "flopeek-native-release-manifest/v1",
    release: {},
    artifacts: {},
    trustMe: true,
  }), /unknown fields/);
});
