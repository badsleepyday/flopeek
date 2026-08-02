#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildPromotionAttestation,
  canonicalJson,
} = require("./native-candidate-bundle");

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function main(argv = process.argv.slice(2)) {
  const attestation = buildPromotionAttestation({
    candidateRunId: argument(argv, "--candidate-run-id"),
    releaseManifestSha256: argument(argv, "--manifest-sha256"),
    sourceSha: argument(argv, "--source-sha"),
    packageVersion: argument(argv, "--package-version"),
    channel: argument(argv, "--channel"),
    promotedBy: argument(argv, "--promoted-by"),
    result: argument(argv, "--result") || "published",
  });
  const output = argument(argv, "--output");
  if (!output) throw new Error("--output is required.");
  const resolved = path.resolve(output);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, canonicalJson(attestation));
  process.stdout.write(`Wrote ${attestation.result} promotion attestation to ${resolved}.\n`);
  return attestation;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Promotion attestation blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
