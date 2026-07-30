#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNativeCoreClient } = require("../src/native-core-client");
const { NativeProtocolClient } = require("../src/native-protocol-client");
const { validateDatabaseOpenEvidence } = require("../src/native-rollout-evidence");
const { nativeArtifactBinding, releaseNativeOptions } = require("./benchmark-native-core-client");
const { copyRepository } = require("./benchmark-native-incremental");

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

async function captureDatabaseOpenEvidence({ repository, binary, output }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-database-open-evidence-"));
  const target = path.join(sandbox, "repository");
  copyRepository(repository, target);
  const artifact = nativeArtifactBinding(binary);
  const protocol = new NativeProtocolClient({ command: binary, args: [], cwd: path.resolve(__dirname, "..") });
  const core = createNativeCoreClient({ native: protocol, sourceAuthority: "rust" });
  try {
    const graph = await core.scan(target);
    const observation = await protocol.request("getNativeDatabaseOpenEvidence", {
      projectRoot: target,
      projectId: graph.project.projectId,
    });
    const evidence = {
      schemaVersion: "flopeek-native-database-open-evidence/v1",
      platformPackage: artifact.platformPackage,
      repositoryRevision: artifact.repositoryRevision,
      sourceDigest: artifact.sourceDigest,
      binarySha256: artifact.binarySha256,
      operation: observation.operation,
      fullPayloadDeserialized: observation.fullPayloadDeserialized,
      observations: observation.observations,
    };
    validateDatabaseOpenEvidence(evidence, {
      [artifact.platformPackage]: {
        binarySha256: artifact.binarySha256,
        repositoryRevision: artifact.repositoryRevision,
        sourceDigest: artifact.sourceDigest,
      },
    });
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    await core.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const repository = argument(argv, "--repository");
  const output = argument(argv, "--output");
  const binary = argument(argv, "--binary") || releaseNativeOptions().command;
  if (!repository || !output) {
    throw new Error("Usage: capture-native-database-open-evidence --repository <clean repository> [--binary <release binary>] --output <json>.");
  }
  await captureDatabaseOpenEvidence({
    repository: path.resolve(repository),
    binary: path.resolve(binary),
    output: path.resolve(output),
  });
  process.stdout.write(`Wrote machine-readable database-open evidence to ${path.resolve(output)}.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { captureDatabaseOpenEvidence };
