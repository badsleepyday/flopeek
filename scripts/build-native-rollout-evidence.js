#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { adapterContractDigest } = require("../src/adapter-registry");
const { NATIVE_PROTOCOL_VERSION } = require("../src/native-protocol-client");
const { nativePlatformTarget } = require("../src/native-platform-targets");
const { evaluateNativeDefaultRollout } = require("../src/native-rollout-gate");
const {
  NATIVE_ROLLOUT_EVIDENCE_SCHEMA,
  loadDatabaseOpenEvidence,
} = require("../src/native-rollout-evidence");

const STATES = ["cold", "unchanged", "oneFileChange"];
const REQUIRED_QUERY_OPERATIONS = Object.freeze([
  "findNodes",
  "projectOverview",
  "contextCard",
  "flowProjection",
  "resolveContextRef",
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function percentile(values, p) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * p / 100) - 1))];
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function validateBenchmark(report, binaryBindings = null) {
  const artifact = report?.nativeArtifact;
  if (report?.schemaVersion !== "flopeek-native-core-client-benchmark/v2"
    || !artifact || typeof artifact !== "object"
    || !/^[a-f0-9]{64}$/u.test(artifact.binarySha256 || "")
    || !/^[a-f0-9]{40,64}$/u.test(artifact.repositoryRevision || "")
    || !/^[a-f0-9]{64}$/u.test(artifact.sourceDigest || "")
    || typeof artifact.platformPackage !== "string" || !artifact.platformPackage
    || typeof artifact.target !== "string" || !artifact.target
    || typeof artifact.compilerVersion !== "string" || !artifact.compilerVersion
    || !Array.isArray(report.rows) || report.rows.length < 5) {
    throw new Error("Rollout evidence requires a revision-bound native CoreClient benchmark/v2 with at least five rows.");
  }
  if (binaryBindings) {
    const releaseArtifact = binaryBindings[artifact.platformPackage];
    if (!releaseArtifact
      || releaseArtifact.binarySha256 !== artifact.binarySha256
      || releaseArtifact.target !== artifact.target
      || releaseArtifact.compiler.version !== artifact.compilerVersion) {
      throw new Error("Benchmark timing was not measured with the exact release binary, target, and compiler.");
    }
  }
  const repositories = new Map();
  for (const row of report.rows) {
    if (typeof row.repository !== "string" || !row.repository || repositories.has(row.repository)
      || typeof row.repositoryRevision !== "string" || !/^[a-f0-9]{40,64}$/u.test(row.repositoryRevision)
      || typeof row.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.sourceDigest)) {
      throw new Error("Benchmark rows must identify distinct repositories.");
    }
    repositories.set(row.repository, {
      revision: row.repositoryRevision,
      sourceDigest: row.sourceDigest,
    });
    for (const state of STATES) {
      const sample = row.states?.[state];
      if (!Array.isArray(sample?.jsSamplesMs) || !Array.isArray(sample?.nativeSamplesMs)
        || sample.jsSamplesMs.length < 3 || sample.nativeSamplesMs.length !== sample.jsSamplesMs.length
        || !sample.jsSamplesMs.every((value) => Number.isFinite(value) && value >= 0)
        || !sample.nativeSamplesMs.every((value) => Number.isFinite(value) && value > 0)
        || !Number.isFinite(sample.speedupNativeVsJavaScript)) {
        throw new Error(`Benchmark ${row.repository}/${state} must retain at least three paired raw samples.`);
      }
      const jsMedianMs = Number(median(sample.jsSamplesMs).toFixed(3));
      const nativeMedianMs = Number(median(sample.nativeSamplesMs).toFixed(3));
      const speedup = Number((median(sample.jsSamplesMs) / median(sample.nativeSamplesMs)).toFixed(3));
      if (sample.speedupNativeVsJavaScript !== speedup
        || (sample.jsMedianMs != null && sample.jsMedianMs !== jsMedianMs)
        || (sample.nativeMedianMs != null && sample.nativeMedianMs !== nativeMedianMs)) {
        throw new Error(`Benchmark ${row.repository}/${state} aggregates do not match its raw samples.`);
      }
      sample.jsMedianMs = jsMedianMs;
      sample.nativeMedianMs = nativeMedianMs;
      sample.speedupNativeVsJavaScript = speedup;
    }
  }
  return repositories;
}

function validateProfiles(directory, benchmarkRepositories, binaryBindings) {
  const files = fs.readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(directory, file));
  const profiles = files.map(readJson);
  const repositories = new Set();
  const operationCellP95 = Object.fromEntries(REQUIRED_QUERY_OPERATIONS.map((name) => [name, []]));
  const queryRawSamples = [];
  let memoryNoWorse = true;
  for (const profile of profiles) {
    if (profile?.schemaVersion !== "flopeek-native-core-profile/v2"
      || profile.isolatedProcesses !== true || typeof profile.repository !== "string"
      || repositories.has(profile.repository)) {
      throw new Error("Profiles must be isolated, distinct flopeek-native-core-profile/v2 reports.");
    }
    repositories.add(profile.repository);
    const retainedStates = {};
    for (const state of STATES) {
      const native = profile.states?.[state]?.native;
      const javascript = profile.states?.[state]?.javascript;
      if (typeof native?.repository?.revision !== "string"
        || !/^[a-f0-9]{40,64}$/u.test(native.repository.revision)
        || typeof javascript?.repository?.revision !== "string"
        || !/^[a-f0-9]{40,64}$/u.test(javascript.repository.revision)
        || typeof native.repository.sourceDigest !== "string"
        || !/^[a-f0-9]{64}$/u.test(native.repository.sourceDigest)
        || typeof javascript.repository.sourceDigest !== "string"
        || !/^[a-f0-9]{64}$/u.test(javascript.repository.sourceDigest)
        || native.repository.revision !== javascript.repository.revision
        || native.repository.source !== profile.repository
        || javascript.repository.source !== profile.repository
        || typeof native.machine?.binarySha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(native.machine.binarySha256)) {
        throw new Error(`Profile ${profile.repository}/${state} is not revision- and binary-bound.`);
      }
      const platform = nativePlatformTarget(native.machine.platform, native.machine.arch);
      const artifact = platform && binaryBindings[platform.packageName];
      const benchmarkRepository = benchmarkRepositories.get(profile.repository);
      if (!artifact || artifact.binarySha256 !== native.machine.binarySha256
        || artifact.target !== platform.rustTarget
        || artifact.compiler.version !== native.machine.rustVersion
        || native.repository.revision !== benchmarkRepository?.revision
        || native.repository.sourceDigest !== benchmarkRepository?.sourceDigest
        || javascript.repository.sourceDigest !== benchmarkRepository?.sourceDigest) {
        throw new Error(`Profile ${profile.repository}/${state} was not measured with the exact release binary and compiler.`);
      }
      const operations = native.measurement?.queryLatency?.operations || {};
      const operationNames = Object.keys(operations).sort();
      if (JSON.stringify(operationNames) !== JSON.stringify([...REQUIRED_QUERY_OPERATIONS].sort())) {
        throw new Error(`Profile ${profile.repository}/${state} must measure every required query operation exactly once.`);
      }
      for (const name of REQUIRED_QUERY_OPERATIONS) {
        const operation = operations[name];
        if (!Array.isArray(operation.rawSamplesMs) || operation.rawSamplesMs.length !== 101
          || !operation.rawSamplesMs.every((value) => Number.isFinite(value) && value >= 0)) {
          throw new Error(`Profile ${profile.repository}/${state}/${name} must retain 101 raw query samples.`);
        }
        operationCellP95[name].push(percentile(operation.rawSamplesMs, 95));
      }
      retainedStates[state] = Object.fromEntries(REQUIRED_QUERY_OPERATIONS
        .map((name) => [name, [...operations[name].rawSamplesMs]]));
      const nativeMemory = native.measurement?.concurrentMemory;
      const javascriptPeak = javascript.measurement?.memoryAfter?.node?.peakRssBytes;
      if (!Array.isArray(nativeMemory?.rawCombinedRssBytes)
        || nativeMemory.rawCombinedRssBytes.length < 2
        || !nativeMemory.rawCombinedRssBytes.every((value) => Number.isFinite(value) && value >= 0)
        || !Number.isFinite(nativeMemory.maximumConcurrentCombinedRssBytes)
        || nativeMemory.maximumConcurrentCombinedRssBytes !== Math.max(...nativeMemory.rawCombinedRssBytes)
        || !Number.isFinite(javascriptPeak)) {
        throw new Error(`Profile ${profile.repository}/${state} lacks raw concurrent memory evidence.`);
      }
      memoryNoWorse &&= nativeMemory.maximumConcurrentCombinedRssBytes <= javascriptPeak;
    }
    const benchmarkRepository = benchmarkRepositories.get(profile.repository);
    queryRawSamples.push({
      repository: profile.repository,
      repositoryRevision: benchmarkRepository.revision,
      sourceDigest: benchmarkRepository.sourceDigest,
      states: retainedStates,
    });
  }
  if (repositories.size < 5 || repositories.size !== benchmarkRepositories.size
    || [...benchmarkRepositories.keys()].some((repository) => !repositories.has(repository))) {
    throw new Error("Profiles must exactly cover every repository in the five-repository benchmark.");
  }
  const operationP95Ms = Object.fromEntries(REQUIRED_QUERY_OPERATIONS
    .map((name) => [name, Math.max(...operationCellP95[name])]));
  const coreOperationP95 = REQUIRED_QUERY_OPERATIONS
    .filter((name) => name !== "resolveContextRef")
    .map((name) => operationP95Ms[name]);
  return {
    operationP95Ms,
    coreQueryP95Ms: Math.max(...coreOperationP95),
    contextRefP95Ms: operationP95Ms.resolveContextRef,
    queryRawSamples: queryRawSamples.sort((left, right) => left.repository.localeCompare(right.repository)),
    memoryPeakNoWorseThanJavaScript: memoryNoWorse,
  };
}

function platformBinaryBindings(assets, manifest, execFileSync = childProcess.execFileSync) {
  const expected = Object.keys(manifest.optionalDependencies || {}).sort();
  const bindings = {};
  for (const file of fs.readdirSync(assets).filter((name) => name.endsWith(".tgz"))) {
    const tarball = path.join(assets, file);
    const packed = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
    if (!expected.includes(packed.name)) continue;
    if (packed.version !== manifest.version
      || packed.flopeekNative?.protocolVersion !== NATIVE_PROTOCOL_VERSION
      || !/^[a-f0-9]{64}$/u.test(packed.flopeekNative?.binarySha256 || "")
      || !/^[a-f0-9]{40,64}$/u.test(packed.flopeekNative?.repositoryRevision || "")
      || !/^[a-f0-9]{64}$/u.test(packed.flopeekNative?.sourceDigest || "")
      || typeof packed.flopeekNative?.compiler?.version !== "string"
      || !packed.flopeekNative.compiler.version
      || typeof packed.flopeekNative?.target !== "string"
      || bindings[packed.name]) {
      throw new Error(`Invalid or duplicate native platform artifact: ${packed.name || file}.`);
    }
    const platform = nativePlatformTarget(packed.os?.[0], packed.cpu?.[0]);
    if (!platform || platform.packageName !== packed.name || platform.rustTarget !== packed.flopeekNative.target) {
      throw new Error(`Native artifact target metadata does not match ${packed.name || file}.`);
    }
    const executable = packed.os[0] === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
    const binary = execFileSync("tar", ["-xOf", tarball, `package/bin/${executable}`]);
    const actualBinarySha256 = crypto.createHash("sha256").update(binary).digest("hex");
    if (actualBinarySha256 !== packed.flopeekNative.binarySha256) {
      throw new Error(`Native artifact binary checksum does not match its manifest: ${packed.name}.`);
    }
    bindings[packed.name] = {
      binarySha256: actualBinarySha256,
      tarballSha256: crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"),
      repositoryRevision: packed.flopeekNative.repositoryRevision,
      sourceDigest: packed.flopeekNative.sourceDigest,
      compiler: packed.flopeekNative.compiler,
      target: packed.flopeekNative.target,
    };
  }
  if (expected.some((name) => !bindings[name])) {
    throw new Error("The rollout packet requires one verified artifact for every optional native platform package.");
  }
  const revisions = new Set(Object.values(bindings).map((binding) => binding.repositoryRevision));
  const sourceDigests = new Set(Object.values(bindings).map((binding) => binding.sourceDigest));
  const compilers = new Set(Object.values(bindings).map((binding) => JSON.stringify({
    version: binding.compiler.version,
    commitHash: binding.compiler.commitHash,
    commitDate: binding.compiler.commitDate,
    release: binding.compiler.release,
    llvmVersion: binding.compiler.llvmVersion,
  })));
  if (revisions.size !== 1 || sourceDigests.size !== 1 || compilers.size !== 1) {
    throw new Error("All native platform artifacts must come from the exact same repository revision, source tree, and compiler.");
  }
  return bindings;
}

function buildPacket({ root, candidate, benchmark, profiles, assets, databaseOpenEvidence, execFileSync }) {
  const manifest = readJson(path.join(root, "package.json"));
  const verifiedBenchmark = JSON.parse(JSON.stringify(benchmark));
  const binaries = platformBinaryBindings(assets, manifest, execFileSync);
  const benchmarkRepositories = validateBenchmark(verifiedBenchmark, binaries);
  const performance = validateProfiles(profiles, benchmarkRepositories, binaries);
  const databaseOpen = loadDatabaseOpenEvidence(databaseOpenEvidence, binaries);
  if (candidate?.performanceAssertions?.databaseOpenEvidenceSha256 !== databaseOpen.sha256) {
    throw new Error("Candidate database-open evidence SHA-256 does not match the validated evidence file.");
  }
  const evidence = {
    ...candidate,
    benchmark: verifiedBenchmark,
    performance: {
      ...performance,
      databaseOpenDoesNotDeserializeFullGraph: true,
      databaseOpenEvidence: {
        sha256: databaseOpen.sha256,
        evidence: databaseOpen.evidence,
      },
    },
  };
  const decision = evaluateNativeDefaultRollout(evidence);
  if (!decision.eligible) {
    throw new Error(`Rollout evidence is not eligible: ${decision.reasons.join(", ")}.`);
  }
  const artifact = Object.values(binaries)[0];
  return {
    schemaVersion: NATIVE_ROLLOUT_EVIDENCE_SCHEMA,
    status: "complete",
    binding: {
      packageName: manifest.name,
      packageVersion: manifest.version,
      adapterContractDigest: adapterContractDigest(),
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      repositoryRevision: artifact.repositoryRevision,
      sourceDigest: artifact.sourceDigest,
      binaries,
    },
    evidence,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const root = path.resolve(__dirname, "..");
  const candidateFile = argument(argv, "--candidate");
  const benchmarkFile = argument(argv, "--benchmark");
  const profiles = argument(argv, "--profiles");
  const assets = argument(argv, "--assets");
  const databaseOpenEvidence = argument(argv, "--database-open-evidence");
  const output = argument(argv, "--output");
  if (![candidateFile, benchmarkFile, profiles, assets, databaseOpenEvidence, output].every(Boolean)) {
    throw new Error("Usage: build-native-rollout-evidence --candidate <json> --benchmark <json> --profiles <directory> --assets <directory> --database-open-evidence <json> --output <json>.");
  }
  const packet = buildPacket({
    root,
    candidate: readJson(path.resolve(candidateFile)),
    benchmark: readJson(path.resolve(benchmarkFile)),
    profiles: path.resolve(profiles),
    assets: path.resolve(assets),
    databaseOpenEvidence: path.resolve(databaseOpenEvidence),
  });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(packet, null, 2)}\n`);
  process.stdout.write(`Wrote complete native rollout evidence to ${path.resolve(output)}.\n`);
}

module.exports = {
  buildPacket,
  platformBinaryBindings,
  REQUIRED_QUERY_OPERATIONS,
  validateBenchmark,
  validateProfiles,
};
