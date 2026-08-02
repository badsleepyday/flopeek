#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const { nativePlatformPackageNames } = require("../src/native-platform-targets");
const { NATIVE_ROLLOUT_EVIDENCE_SCHEMA } = require("../src/native-rollout-evidence");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

const root = path.resolve(__dirname, "..");
const assets = path.resolve(argument("--assets") || "");
const mainTarball = argument("--main");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!fs.statSync(assets).isDirectory()) throw new Error("Supply --assets with the downloaded release asset directory.");
const files = fs.readdirSync(assets);
const expectedTarballs = new Set();
const tarballByPackage = new Map();
for (const packageName of nativePlatformPackageNames()) {
  if (packageJson.optionalDependencies?.[packageName] !== packageJson.version) {
    throw new Error(`${packageName} must be pinned exactly to ${packageJson.version}.`);
  }
  const filenamePrefix = `${packageName.replace("@flopeek/", "flopeek-")}-${packageJson.version}`;
  const matches = files.filter((filename) => filename.startsWith(filenamePrefix) && filename.endsWith(".tgz"));
  if (matches.length !== 1) {
    throw new Error(`Verified tarball is missing for ${packageName}@${packageJson.version}.`);
  }
  expectedTarballs.add(matches[0]);
  tarballByPackage.set(packageName, matches[0]);
}
const unexpectedTarballs = files.filter((filename) => filename.endsWith(".tgz") && !expectedTarballs.has(filename));
if (unexpectedTarballs.length) throw new Error(`Unexpected native release tarballs: ${unexpectedTarballs.join(", ")}.`);
const checksumFiles = files.filter((filename) => filename.startsWith("checksums-") && filename.endsWith(".txt"));
if (checksumFiles.length !== nativePlatformPackageNames().length) {
  throw new Error(`Expected ${nativePlatformPackageNames().length} checksum manifests, found ${checksumFiles.length}.`);
}
const checksums = new Map();
for (const filename of checksumFiles) {
  const lines = fs.readFileSync(path.join(assets, filename), "utf8").split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+(.+\.tgz)$/u.exec(line.trim());
    if (!match || checksums.has(match[2])) throw new Error(`Invalid or duplicate checksum entry in ${filename}.`);
    checksums.set(match[2], match[1]);
  }
}
for (const filename of expectedTarballs) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(assets, filename))).digest("hex");
  if (checksums.get(filename) !== digest) throw new Error(`Checksum mismatch for ${filename}.`);
}
if (mainTarball) {
  const resolvedMain = path.resolve(mainTarball);
  const manifest = JSON.parse(childProcess.execFileSync("tar", ["-xOf", resolvedMain, "package/package.json"], { encoding: "utf8" }));
  if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) {
    throw new Error("The exact main tarball does not match the approved package identity.");
  }
  const actualOptional = manifest.optionalDependencies || {};
  const expectedOptional = packageJson.optionalDependencies || {};
  if (JSON.stringify(actualOptional) !== JSON.stringify(expectedOptional)) {
    throw new Error("The exact main tarball optional dependencies do not match the verified release set.");
  }
  const packet = JSON.parse(childProcess.execFileSync(
    "tar",
    ["-xOf", resolvedMain, "package/packaging/native-rollout-evidence.json"],
    { encoding: "utf8" },
  ));
  if (packet?.schemaVersion !== NATIVE_ROLLOUT_EVIDENCE_SCHEMA
    || packet.binding?.packageName !== manifest.name
    || packet.binding?.packageVersion !== manifest.version) {
    throw new Error("The exact main tarball has invalid native rollout evidence.");
  }
  if (packet.status === "incomplete") {
    if (packet.evidence !== null || packet.binding.binaries !== null) {
      throw new Error("Incomplete rollout evidence in the main tarball must remain non-activating.");
    }
  } else if (packet.status === "complete") {
    for (const packageName of nativePlatformPackageNames()) {
      const filename = tarballByPackage.get(packageName);
      const nativeManifest = JSON.parse(childProcess.execFileSync(
        "tar",
        ["-xOf", path.join(assets, filename), "package/package.json"],
        { encoding: "utf8" },
      ));
      const binding = packet.binding.binaries?.[packageName];
      const tarballSha256 = crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(assets, filename))).digest("hex");
      if (!binding
        || binding.binarySha256 !== nativeManifest.flopeekNative?.binarySha256
        || binding.tarballSha256 !== tarballSha256
        || binding.repositoryRevision !== nativeManifest.flopeekNative?.repositoryRevision
        || binding.sourceDigest !== nativeManifest.flopeekNative?.sourceDigest
        || binding.target !== nativeManifest.flopeekNative?.target
        || binding.compiler?.version !== nativeManifest.flopeekNative?.compiler?.version) {
        throw new Error(`The main rollout packet is not bound to the exact ${packageName} release artifact.`);
      }
    }
  } else {
    throw new Error("The main tarball rollout evidence status is invalid.");
  }
}
process.stdout.write(`Verified ${nativePlatformPackageNames().length} native tarballs for flopeek@${packageJson.version} before publication.\n`);
