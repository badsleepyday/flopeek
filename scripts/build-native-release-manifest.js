#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildNativeReleaseManifest,
  canonicalReleaseManifestBytes,
  sha256File,
} = require("./native-release-manifest");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function main() {
  const tag = argument("--tag");
  const mainTarball = argument("--main");
  const rolloutEvidence = argument("--rollout-evidence");
  const assets = argument("--assets");
  const output = argument("--output");
  if (![tag, mainTarball, rolloutEvidence, assets, output].every(Boolean)) {
    throw new Error("Usage: build-native-release-manifest --tag <tag> --main <tgz> --rollout-evidence <json> --assets <directory> --output <json>.");
  }
  const manifest = buildNativeReleaseManifest({
    root: path.resolve(__dirname, ".."),
    tag,
    mainTarball,
    rolloutEvidence,
    assets,
  });
  const resolvedOutput = path.resolve(output);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, canonicalReleaseManifestBytes(manifest));
  process.stdout.write(`Wrote exact release manifest ${resolvedOutput} (${sha256File(resolvedOutput)}).\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release manifest blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
