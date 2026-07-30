#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { adapterContractDigest } = require("../src/adapter-registry");
const {
  REQUIRED_NATIVE_ADAPTERS,
  validateNativeAdapterParity,
} = require("../src/native-rollout-gate");
const {
  platformBinaryBindings,
  validateBenchmark,
  validateProfiles,
} = require("./build-native-rollout-evidence");
const { validateDatabaseOpenEvidence } = require("../src/native-rollout-evidence");

const ROOT = path.resolve(__dirname, "..");
const PERFORMANCE_CORPUS_SCHEMA = "flopeek-native-performance-corpus/v1";
const REQUIRED_SIZE_CLASSES = Object.freeze(["small", "medium", "large", "monorepo"]);
const PROOF_SUITES = Object.freeze({
  structuralAndQueryParity: Object.freeze([
    "test/unit/core-client.test.js",
    "test/unit/native-protocol-client.test.js",
    "test/unit/native-adapter-parity.test.js",
    "test/unit/verify-native-core-parity.test.js",
  ]),
  lifecycleAndRecovery: Object.freeze([
    "test/unit/core-mode.test.js",
    "test/unit/scan-coordinator.test.js",
    "test/unit/native-activation-surfaces.test.js",
    "test/unit/native-failure-recovery.test.js",
  ]),
  nativeSurfaces: Object.freeze([]),
});

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args) {
  return childProcess.execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
  }).trim();
}

function validatePerformanceCorpus(manifest, adapterManifest) {
  if (manifest?.schemaVersion !== PERFORMANCE_CORPUS_SCHEMA
    || !Array.isArray(manifest.repositories)
    || manifest.repositories.length !== 5) {
    throw new Error("Performance corpus must contain exactly five repositories.");
  }
  const adapterRepositories = new Map(adapterManifest?.repositories
    ?.map((repository) => [repository.id, repository]) || []);
  const ids = new Set();
  const classes = new Set();
  const adapters = new Set();
  for (const entry of manifest.repositories) {
    const keys = Object.keys(entry || {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["repositoryId", "sizeClass"])) {
      throw new Error("Performance corpus entries must contain only repositoryId and sizeClass.");
    }
    const repository = adapterRepositories.get(entry.repositoryId);
    if (!repository || ids.has(entry.repositoryId)) {
      throw new Error(`Performance corpus repository is missing or duplicated: ${entry.repositoryId}.`);
    }
    if (!REQUIRED_SIZE_CLASSES.includes(entry.sizeClass)) {
      throw new Error(`Unsupported performance corpus size class: ${entry.sizeClass}.`);
    }
    ids.add(entry.repositoryId);
    classes.add(entry.sizeClass);
    for (const adapter of repository.adapters || []) adapters.add(adapter);
  }
  if (REQUIRED_SIZE_CLASSES.some((sizeClass) => !classes.has(sizeClass))) {
    throw new Error("Performance corpus must cover small, medium, large, and monorepo repositories.");
  }
  if (adapters.size < 3) {
    throw new Error("Performance corpus must cover at least three adapter or language families.");
  }
  return {
    repositories: manifest.repositories.map((entry) => ({
      ...entry,
      adapter: adapterRepositories.get(entry.repositoryId).adapters[0],
    })),
    adapters: [...adapters].sort(),
    sizeClasses: [...classes].sort(),
  };
}

function runCommand(summary, label, command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout || 90 * 60 * 1000,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const record = {
    label,
    command,
    arguments: args,
    exitCode: result.status,
    signal: result.signal,
    durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
  };
  summary.commands.push(record);
  if (result.error || result.status !== 0) {
    const cause = result.error?.message || stderr || stdout || `exit code ${result.status}`;
    throw new Error(`${label} failed: ${cause}`);
  }
  return stdout;
}

function requireExactCandidateBinding({ binary, assets, sourceSha }) {
  const manifest = readJson(path.join(ROOT, "package.json"));
  const bindings = platformBinaryBindings(assets, manifest);
  const linux = bindings["@flopeek/native-linux-x64-gnu"];
  const binarySha256 = sha256(fs.readFileSync(binary));
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Candidate evidence must run on Linux x64 with the Linux x64 candidate artifact.");
  }
  if (!linux || linux.binarySha256 !== binarySha256 || linux.repositoryRevision !== sourceSha) {
    throw new Error("Evidence binary is not the exact Linux x64 binary from the candidate release set.");
  }
  const revision = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (revision !== sourceSha || status) {
    throw new Error("Candidate evidence requires an exact clean source checkout.");
  }
  return { bindings, linux, binarySha256 };
}

function proofResult(summary, label) {
  const record = summary.commands.find((command) => command.label === label);
  return record?.exitCode === 0 && record.signal == null;
}

function buildCandidateEvidence({ adapterParity, realCorpus, databaseOpenEvidence, summary }) {
  validateNativeAdapterParity(adapterParity);
  if (realCorpus?.schemaVersion !== "flopeek-native-real-corpus-evidence/v1"
    || realCorpus.summary?.repositories !== REQUIRED_NATIVE_ADAPTERS.length
    || realCorpus.summary?.exactRepositories !== realCorpus.summary.repositories
    || realCorpus.summary?.targetRepositoryWrites !== false
    || JSON.stringify(realCorpus.summary?.adapters) !== JSON.stringify([...REQUIRED_NATIVE_ADAPTERS].sort())) {
    throw new Error("Candidate backend authority is not proven by the complete exact real-repository corpus.");
  }
  const structuralAndQueryParity = proofResult(summary, "structural-and-query-parity");
  const lifecycleAndRecovery = proofResult(summary, "lifecycle-and-recovery");
  const nativeSurfaces = proofResult(summary, "native-surfaces");
  if (!structuralAndQueryParity || !lifecycleAndRecovery || !nativeSurfaces) {
    throw new Error("Candidate proof suites are incomplete.");
  }
  return {
    backendParity: {
      schemaVersion: "flopeek-native-backend-parity/v1",
      sourceDiscoveryAuthority: "rust",
      parserAuthority: "rust",
      resolverAuthority: "rust",
      structuralFactAuthority: "rust",
      javascriptRole: "oracle-and-rollback-only",
      fixtureCount: adapterParity.summary.cases,
      exactFixtureCount: adapterParity.summary.exactCases,
      adapterContractDigest: adapterContractDigest(),
      requiredAdapters: [...REQUIRED_NATIVE_ADAPTERS],
      fallbackOnlyAdapters: [],
      adapterCoveragePolicy: "all-native",
    },
    structuralParity: {
      publicIds: structuralAndQueryParity,
      fixtureCount: adapterParity.summary.cases,
      exactFixtureCount: adapterParity.summary.exactCases,
    },
    queryParity: {
      flowLens: structuralAndQueryParity,
      impact: structuralAndQueryParity,
      relatedTests: structuralAndQueryParity,
      contextRef: structuralAndQueryParity,
      changedContexts: structuralAndQueryParity,
    },
    lifecycle: {
      sqlitePromotion: lifecycleAndRecovery,
      recovery: lifecycleAndRecovery,
      javascriptFallback: lifecycleAndRecovery,
    },
    surfaceContract: {
      verified: nativeSurfaces,
      proofCommandSha256: sha256(JSON.stringify(summary.commands
        .find((command) => command.label === "native-surfaces"))),
    },
    performanceAssertions: {
      databaseOpenEvidenceSha256: sha256(fs.readFileSync(databaseOpenEvidence)),
    },
  };
}

function parseArguments(argv) {
  const options = {
    binary: argument(argv, "--binary"),
    assets: argument(argv, "--assets"),
    workDirectory: argument(argv, "--work-directory"),
    output: argument(argv, "--output"),
    sourceSha: argument(argv, "--source-sha"),
  };
  if (!Object.values(options).every(Boolean)
    || !/^[a-f0-9]{40}$/u.test(options.sourceSha || "")) {
    throw new Error("Usage: run-native-candidate-evidence --binary <file> --assets <directory> --work-directory <directory> --output <directory> --source-sha <40-char SHA>.");
  }
  return Object.fromEntries(Object.entries(options)
    .map(([key, value]) => [key, key === "sourceSha" ? value : path.resolve(value)]));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!fs.existsSync(options.binary) || !fs.statSync(options.binary).isFile()) {
    throw new Error("Candidate evidence binary is missing.");
  }
  fs.mkdirSync(options.workDirectory, { recursive: true });
  fs.mkdirSync(options.output, { recursive: true });
  const profiles = path.join(options.output, "profiles");
  fs.mkdirSync(profiles, { recursive: true });
  const summary = {
    schemaVersion: "flopeek-native-candidate-test-summary/v1",
    generatedAt: new Date().toISOString(),
    sourceSha: options.sourceSha,
    commands: [],
  };
  const binding = requireExactCandidateBinding(options);
  summary.binary = {
    platformPackage: "@flopeek/native-linux-x64-gnu",
    sha256: binding.binarySha256,
    sourceRevision: binding.linux.repositoryRevision,
    sourceDigest: binding.linux.sourceDigest,
    target: binding.linux.target,
    compiler: binding.linux.compiler,
  };

  const cloneDirectory = path.join(options.workDirectory, "correctness-corpus");
  const realCorpusFile = path.join(options.output, "real-corpus.json");
  runCommand(summary, "real-repository-correctness", process.execPath, [
    "scripts/verify-native-real-corpus.js",
    "--binary", options.binary,
    "--manifest", path.join(ROOT, "benchmarks", "native-adapter-corpus.json"),
    "--clone-directory", cloneDirectory,
    "--source-revision", options.sourceSha,
    "--output", realCorpusFile,
  ]);

  const adapterParityFile = path.join(options.output, "adapter-parity.json");
  runCommand(summary, "adapter-parity", process.execPath, [
    "scripts/verify-native-adapter-parity.js",
    "--binary", options.binary,
    "--expected-binary-sha256", binding.binarySha256,
    "--source-revision", options.sourceSha,
    "--output", adapterParityFile,
  ]);

  for (const [label, files] of Object.entries(PROOF_SUITES)) {
    const commandLabel = label.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    if (label === "nativeSurfaces") {
      runCommand(summary, commandLabel, process.execPath, [
        "scripts/verify-native-surfaces.js",
        "--binary", options.binary,
        "--output", path.join(options.output, "native-surface-matrix.json"),
      ]);
    } else {
      runCommand(summary, commandLabel, process.execPath, ["--test", ...files], {
        env: { FLOPEEK_NATIVE_CORE_BINARY: options.binary },
      });
    }
  }

  const performance = validatePerformanceCorpus(
    readJson(path.join(ROOT, "benchmarks", "native-performance-corpus.json")),
    readJson(path.join(ROOT, "benchmarks", "native-adapter-corpus.json")),
  );
  summary.performanceCorpus = performance;
  const performanceRoots = performance.repositories
    .map((repository) => path.join(cloneDirectory, repository.repositoryId));
  const benchmarkFile = path.join(options.output, "benchmark.json");
  const benchmarkOutput = runCommand(summary, "five-repository-performance", process.execPath, [
    "scripts/benchmark-native-core-client.js",
    ...performanceRoots.flatMap((root) => ["--root", root]),
    "--iterations", "3",
  ]);
  writeJson(benchmarkFile, JSON.parse(benchmarkOutput));

  for (const root of performanceRoots) {
    const repository = path.basename(root);
    const profileOutput = runCommand(summary, `profile:${repository}`, process.execPath, [
      "scripts/profile-native-core-client.js", root,
    ], { env: { FLOPEEK_PROFILE_QUERY_SAMPLES: "101" } });
    writeJson(path.join(profiles, `${repository}.json`), JSON.parse(profileOutput));
  }

  const databaseOpenEvidence = path.join(options.output, "database-open-evidence.json");
  runCommand(summary, "database-open", process.execPath, [
    "scripts/capture-native-database-open-evidence.js",
    "--repository", performanceRoots[0],
    "--binary", options.binary,
    "--output", databaseOpenEvidence,
  ]);
  const soakEvidence = path.join(options.output, "native-soak.json");
  runCommand(summary, "native-soak", process.execPath, [
    "--expose-gc",
    "scripts/verify-native-soak.js",
    "--binary", options.binary,
    "--output", soakEvidence,
  ], { timeout: 120 * 60 * 1000 });

  const adapterParity = readJson(adapterParityFile);
  const realCorpus = readJson(realCorpusFile);
  validateNativeAdapterParity(adapterParity);
  const benchmark = readJson(benchmarkFile);
  const benchmarkRepositories = validateBenchmark(benchmark, binding.bindings);
  validateProfiles(profiles, benchmarkRepositories, binding.bindings);
  validateDatabaseOpenEvidence(readJson(databaseOpenEvidence), binding.bindings);
  const candidate = buildCandidateEvidence({
    adapterParity,
    realCorpus,
    databaseOpenEvidence,
    summary,
  });
  writeJson(path.join(options.output, "candidate.json"), candidate);
  summary.status = "passed";
  summary.completedAt = new Date().toISOString();
  writeJson(path.join(options.output, "test-summary.json"), summary);
  process.stdout.write(`Generated candidate-bound evidence from ${performanceRoots.length} performance repositories.\n`);
  return { candidate, summary };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Candidate evidence blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PERFORMANCE_CORPUS_SCHEMA,
  PROOF_SUITES,
  buildCandidateEvidence,
  parseArguments,
  validatePerformanceCorpus,
};
