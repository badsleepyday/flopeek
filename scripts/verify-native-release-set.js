#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { nativePlatformPackageNames } = require("../src/native-platform-targets");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

const root = path.resolve(__dirname, "..");
const assets = path.resolve(argument("--assets") || "");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!fs.statSync(assets).isDirectory()) throw new Error("Supply --assets with the downloaded release asset directory.");
const files = fs.readdirSync(assets);
for (const packageName of nativePlatformPackageNames()) {
  if (packageJson.optionalDependencies?.[packageName] !== packageJson.version) {
    throw new Error(`${packageName} must be pinned exactly to ${packageJson.version}.`);
  }
  const filenamePrefix = `${packageName.replace("@flopeek/", "flopeek-")}-${packageJson.version}`;
  if (!files.some((filename) => filename.startsWith(filenamePrefix) && filename.endsWith(".tgz"))) {
    throw new Error(`Verified tarball is missing for ${packageName}@${packageJson.version}.`);
  }
}
const checksumFiles = files.filter((filename) => filename.startsWith("checksums-") && filename.endsWith(".txt"));
if (checksumFiles.length !== nativePlatformPackageNames().length) {
  throw new Error(`Expected ${nativePlatformPackageNames().length} checksum manifests, found ${checksumFiles.length}.`);
}
process.stdout.write(`Verified ${nativePlatformPackageNames().length} native tarballs for flopeek@${packageJson.version} before publication.\n`);
