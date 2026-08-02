#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { NativeProtocolClient } = require("../src/native-protocol-client");
const { createScanCoordinator } = require("../src/scan-coordinator");
const { copyRepository, sourceFiles } = require("./benchmark-native-incremental");
const { releaseNativeOptions, repositoryBinding, stateRequest } = require("./benchmark-native-core-client");
const { profileState } = require("./profile-native-core-client");

async function main() {
  const source = path.resolve(process.argv[2] || "");
  const implementation = process.argv[3];
  const state = process.argv[4];
  if (!["javascript", "native"].includes(implementation)) throw new Error("Worker implementation must be javascript or native.");
  if (!["cold", "unchanged", "oneFileChange"].includes(state)) throw new Error("Worker state is invalid.");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `flopeek-profile-${implementation}-${state}-`));
  const target = path.join(sandbox, "repository");
  copyRepository(source, target);
  const phases = [];
  const nativeProtocol = implementation === "native" ? new NativeProtocolClient(releaseNativeOptions()) : null;
  const core = implementation === "native"
    ? createNativeCoreClient({ native: nativeProtocol, sourceAuthority: "rust" })
    : createJsCoreClient();
  const coordinator = createScanCoordinator(target, {
    cache: true,
    coreClient: core,
    onCoreProfile: (entry) => phases.push(entry),
  });
  try {
    let changedPath = null;
    if (state !== "cold") await coordinator.refresh(null, "profile-warmup");
    if (state === "oneFileChange") {
      const file = sourceFiles(target)[0];
      fs.appendFileSync(file, "\n");
      changedPath = path.relative(target, file).replaceAll("\\", "/");
    }
    const result = await profileState(coordinator, core, stateRequest(state, changedPath), phases, nativeProtocol);
    const nativeOptions = releaseNativeOptions();
    const binary = nativeOptions.command && fs.existsSync(nativeOptions.command) ? nativeOptions.command : null;
    const rustVersion = (() => {
      try { return execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(); } catch { return null; }
    })();
    const sourceBinding = repositoryBinding(source);
    process.stdout.write(JSON.stringify({
      schemaVersion: "flopeek-native-core-profile-worker/v1",
      implementation,
      state,
      repository: {
        source: path.basename(source),
        revision: sourceBinding.repositoryRevision,
        sourceDigest: sourceBinding.sourceDigest,
        files: sourceFiles(source).length,
        bytes: sourceFiles(source).reduce((total, file) => total + fs.statSync(file).size, 0),
      },
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model || null,
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        nodeVersion: process.version,
        rustVersion,
        binarySha256: binary ? createHash("sha256").update(fs.readFileSync(binary)).digest("hex") : null,
      },
      compatibilityDigest: createCoreCompatibilityDigest(result.graph),
      stats: result.graph.stats,
      measurement: {
        milliseconds: result.milliseconds,
        phases: result.phases,
        memoryBefore: result.memoryBefore,
        memoryAfter: result.memoryAfter,
        concurrentMemory: result.concurrentMemory,
        database: result.database,
        queryLatency: result.queries,
      },
    }));
  } finally {
    await core.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
