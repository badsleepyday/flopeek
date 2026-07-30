#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { adapterContractDigest } = require("../src/adapter-registry");
const { NATIVE_PROTOCOL_VERSION } = require("../src/native-protocol-client");
const { evaluateNativeDefaultRollout } = require("../src/native-rollout-gate");
const { NATIVE_ROLLOUT_EVIDENCE_SCHEMA } = require("../src/native-rollout-evidence");

const STATES = ["cold", "unchanged", "oneFileChange"];

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

function validateBenchmark(report) {
  if (report?.schemaVersion !== "flopeek-native-core-client-benchmark/v1"
    || !Array.isArray(report.rows) || report.rows.length < 5) {
    throw new Error("Rollout evidence requires a native CoreClient benchmark with at least five rows.");
  }
  const repositories = new Set();
  for (const row of report.rows) {
    if (typeof row.repository !== "string" || !row.repository || repositories.has(row.repository)) {
      throw new Error("Benchmark rows must identify distinct repositories.");
    }
    repositories.add(row.repository);
    for (const state of STATES) {
      const sample = row.states?.[state];
      if (!Array.isArray(sample?.jsSamplesMs) || !Array.isArray(sample?.nativeSamplesMs)
        || sample.jsSamplesMs.length < 3 || sample.nativeSamplesMs.length !== sample.jsSamplesMs.length
        || !sample.jsSamplesMs.every(Number.isFinite) || !sample.nativeSamplesMs.every(Number.isFinite)
        || !Number.isFinite(sample.speedupNativeVsJavaScript)) {
        throw new Error(`Benchmark ${row.repository}/${state} must retain at least three paired raw samples.`);
      }
    }
  }
  return repositories;
}

function validateProfiles(directory, benchmarkRepositories) {
  const files = fs.readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(directory, file));
  const profiles = files.map(readJson);
  const repositories = new Set();
  const coreP95 = [];
  const contextP95 = [];
  let memoryNoWorse = true;
  for (const profile of profiles) {
    if (profile?.schemaVersion !== "flopeek-native-core-profile/v2"
      || profile.isolatedProcesses !== true || typeof profile.repository !== "string"
      || repositories.has(profile.repository)) {
      throw new Error("Profiles must be isolated, distinct flopeek-native-core-profile/v2 reports.");
    }
    repositories.add(profile.repository);
    for (const state of STATES) {
      const native = profile.states?.[state]?.native;
      const javascript = profile.states?.[state]?.javascript;
      if (native?.repository?.revision == null || javascript?.repository?.revision == null
        || native.repository.revision !== javascript.repository.revision
        || typeof native.machine?.binarySha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(native.machine.binarySha256)) {
        throw new Error(`Profile ${profile.repository}/${state} is not revision- and binary-bound.`);
      }
      const operations = native.measurement?.queryLatency?.operations || {};
      for (const [name, operation] of Object.entries(operations)) {
        if (!Array.isArray(operation.rawSamplesMs) || operation.rawSamplesMs.length < 101) {
          throw new Error(`Profile ${profile.repository}/${state}/${name} must retain 101 raw query samples.`);
        }
        if (name === "resolveContextRef") contextP95.push(percentile(operation.rawSamplesMs, 95));
        else coreP95.push(percentile(operation.rawSamplesMs, 95));
      }
      const nativeMemory = native.measurement?.concurrentMemory;
      const javascriptPeak = javascript.measurement?.memoryAfter?.node?.peakRssBytes;
      if (!Array.isArray(nativeMemory?.rawCombinedRssBytes)
        || nativeMemory.rawCombinedRssBytes.length < 2
        || !Number.isFinite(nativeMemory.maximumConcurrentCombinedRssBytes)
        || nativeMemory.maximumConcurrentCombinedRssBytes !== Math.max(...nativeMemory.rawCombinedRssBytes)
        || !Number.isFinite(javascriptPeak)) {
        throw new Error(`Profile ${profile.repository}/${state} lacks raw concurrent memory evidence.`);
      }
      memoryNoWorse &&= nativeMemory.maximumConcurrentCombinedRssBytes <= javascriptPeak;
    }
  }
  if (repositories.size < 5
    || [...benchmarkRepositories].some((repository) => !repositories.has(repository))) {
    throw new Error("Profiles must cover every repository in the five-repository benchmark.");
  }
  return {
    coreQueryP95Ms: percentile(coreP95, 95),
    contextRefP95Ms: percentile(contextP95, 95),
    databaseOpenDoesNotDeserializeFullGraph: true,
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
      || bindings[packed.name]) {
      throw new Error(`Invalid or duplicate native platform artifact: ${packed.name || file}.`);
    }
    bindings[packed.name] = packed.flopeekNative.binarySha256;
  }
  if (expected.some((name) => !bindings[name])) {
    throw new Error("The rollout packet requires one verified artifact for every optional native platform package.");
  }
  return bindings;
}

function buildPacket({ root, candidate, benchmark, profiles, assets, execFileSync }) {
  const manifest = readJson(path.join(root, "package.json"));
  const benchmarkRepositories = validateBenchmark(benchmark);
  const performance = validateProfiles(profiles, benchmarkRepositories);
  if (candidate?.performanceAssertions?.databaseOpenDoesNotDeserializeFullGraph !== true
    || typeof candidate.performanceAssertions.evidenceReference !== "string"
    || !candidate.performanceAssertions.evidenceReference) {
    throw new Error("Database-open behavior requires an explicit evidence reference.");
  }
  const evidence = {
    ...candidate,
    benchmark,
    performance: {
      ...performance,
      databaseOpenDoesNotDeserializeFullGraph: true,
    },
  };
  const decision = evaluateNativeDefaultRollout(evidence);
  if (!decision.eligible) {
    throw new Error(`Rollout evidence is not eligible: ${decision.reasons.join(", ")}.`);
  }
  return {
    schemaVersion: NATIVE_ROLLOUT_EVIDENCE_SCHEMA,
    status: "complete",
    binding: {
      packageName: manifest.name,
      packageVersion: manifest.version,
      adapterContractDigest: adapterContractDigest(),
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      binaries: platformBinaryBindings(assets, manifest, execFileSync),
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
  const output = argument(argv, "--output");
  if (![candidateFile, benchmarkFile, profiles, assets, output].every(Boolean)) {
    throw new Error("Usage: build-native-rollout-evidence --candidate <json> --benchmark <json> --profiles <directory> --assets <directory> --output <json>.");
  }
  const packet = buildPacket({
    root,
    candidate: readJson(path.resolve(candidateFile)),
    benchmark: readJson(path.resolve(benchmarkFile)),
    profiles: path.resolve(profiles),
    assets: path.resolve(assets),
  });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(packet, null, 2)}\n`);
  process.stdout.write(`Wrote complete native rollout evidence to ${path.resolve(output)}.\n`);
}

module.exports = {
  buildPacket,
  platformBinaryBindings,
  validateBenchmark,
  validateProfiles,
};
