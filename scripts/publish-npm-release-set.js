#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function tarballIdentity(tarball, execFileSync = childProcess.execFileSync) {
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Tarball has no exact package identity: ${tarball}`);
  }
  const bytes = fs.readFileSync(tarball);
  return {
    name: manifest.name,
    version: manifest.version,
    shasum: crypto.createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function registryDist(identity, execFileSync = childProcess.execFileSync) {
  try {
    const output = execFileSync("npm", [
      "view",
      `${identity.name}@${identity.version}`,
      "dist",
      "--json",
      "--registry=https://registry.npmjs.org",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    const stderr = String(error?.stderr || "");
    if (error?.status === 1 && /E404|is not in this registry|No match found/u.test(stderr)) return null;
    throw error;
  }
}

function verifyExisting(identity, dist) {
  if (dist?.shasum !== identity.shasum || dist?.integrity !== identity.integrity) {
    throw new Error(`${identity.name}@${identity.version} already exists with different registry integrity.`);
  }
}

function publishTarball(tarball, stagingTag, options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const identity = tarballIdentity(tarball, execFileSync);
  const existing = registryDist(identity, execFileSync);
  if (existing) {
    verifyExisting(identity, existing);
    return { ...identity, action: "verified-existing" };
  }
  execFileSync("npm", [
    "publish",
    tarball,
    "--access",
    "public",
    "--tag",
    stagingTag,
    "--provenance",
  ], { stdio: "inherit" });
  const published = registryDist(identity, execFileSync);
  if (!published) throw new Error(`${identity.name}@${identity.version} was not visible after publication.`);
  verifyExisting(identity, published);
  return { ...identity, action: "published" };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

if (require.main === module) {
  const assets = path.resolve(argument("--assets") || "");
  const stagingTag = argument("--staging-tag");
  if (!stagingTag || !fs.existsSync(assets) || !fs.statSync(assets).isDirectory()) {
    throw new Error("Usage: publish-npm-release-set --assets <directory> --staging-tag <tag>.");
  }
  const tarballs = fs.readdirSync(assets)
    .filter((filename) => filename.endsWith(".tgz"))
    .map((filename) => path.join(assets, filename))
    .sort((left, right) => {
      const leftNative = path.basename(left).startsWith("flopeek-native-");
      const rightNative = path.basename(right).startsWith("flopeek-native-");
      return Number(rightNative) - Number(leftNative) || path.basename(left).localeCompare(path.basename(right));
    });
  if (!tarballs.length) throw new Error("No npm tarballs were found in the release set.");
  for (const tarball of tarballs) {
    const result = publishTarball(tarball, stagingTag);
    process.stdout.write(`${result.action}: ${result.name}@${result.version}\n`);
  }
}

module.exports = { publishTarball, registryDist, tarballIdentity, verifyExisting };
