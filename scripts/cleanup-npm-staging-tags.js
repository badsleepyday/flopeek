#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function packageNames(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return [...Object.keys(manifest.optionalDependencies || {}), manifest.name];
}

function distTags(packageName, execFileSync = childProcess.execFileSync) {
  const output = execFileSync("npm", [
    "dist-tag",
    "ls",
    packageName,
    "--json",
    "--registry=https://registry.npmjs.org",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`npm returned invalid dist-tags for ${packageName}.`);
  }
  return parsed;
}

function removeStagingTag(packageName, stagingTag, execFileSync = childProcess.execFileSync) {
  const tags = distTags(packageName, execFileSync);
  if (!Object.hasOwn(tags, stagingTag)) return { packageName, action: "already-absent" };
  execFileSync("npm", [
    "dist-tag",
    "rm",
    packageName,
    stagingTag,
    "--registry=https://registry.npmjs.org",
  ], { stdio: "inherit" });
  const remaining = distTags(packageName, execFileSync);
  if (Object.hasOwn(remaining, stagingTag)) {
    throw new Error(`npm staging tag ${stagingTag} still exists for ${packageName}.`);
  }
  return { packageName, action: "removed" };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const stagingTag = argument("--staging-tag");
  if (!stagingTag) throw new Error("Usage: cleanup-npm-staging-tags --staging-tag <tag>.");
  for (const packageName of packageNames(root)) {
    const result = removeStagingTag(packageName, stagingTag);
    process.stdout.write(`${result.action}: ${packageName}@${stagingTag}\n`);
  }
}

module.exports = { distTags, packageNames, removeStagingTag };
