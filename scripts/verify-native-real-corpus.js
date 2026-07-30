#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  createCoreCompatibilityDigest,
  createCoreCompatibilityProjection,
} = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { createNativeIncrementalSession } = require("../src/native-incremental-coordinator");
const { createScanCoordinator } = require("../src/scan-coordinator");
const { REQUIRED_NATIVE_ADAPTERS } = require("../src/native-rollout-gate");

const SCHEMA = "flopeek-native-adapter-corpus/v1";
const EVIDENCE_SCHEMA = "flopeek-native-real-corpus-evidence/v1";

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length) throw new Error(`${field} is missing fields: ${missing.join(", ")}.`);
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}.`);
}

function validateManifest(manifest) {
  exactKeys(manifest, ["schemaVersion", "repositories"], "corpus manifest");
  if (manifest.schemaVersion !== SCHEMA || !Array.isArray(manifest.repositories)) {
    throw new Error(`corpus manifest must use ${SCHEMA}.`);
  }
  const ids = new Set();
  const adapters = new Set();
  for (const [index, repository] of manifest.repositories.entries()) {
    exactKeys(repository, [
      "id",
      "repository",
      "revision",
      "sourceDigest",
      "license",
      "licenseFile",
      "adapters",
      "expectedScope",
    ], `corpus repository ${index}`);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(repository.id || "") || ids.has(repository.id)) {
      throw new Error(`corpus repository ${index} has an invalid or duplicate id.`);
    }
    ids.add(repository.id);
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/u.test(repository.repository || "")) {
      throw new Error(`corpus repository ${repository.id} must use an exact public GitHub clone URL.`);
    }
    if (!/^[a-f0-9]{40}$/u.test(repository.revision || "")
      || !/^[a-f0-9]{64}$/u.test(repository.sourceDigest || "")) {
      throw new Error(`corpus repository ${repository.id} must pin a full commit and source digest.`);
    }
    if (typeof repository.license !== "string" || !repository.license
      || typeof repository.licenseFile !== "string" || !repository.licenseFile) {
      throw new Error(`corpus repository ${repository.id} must declare its license and license file.`);
    }
    if (!Array.isArray(repository.adapters) || repository.adapters.length !== 1
      || !REQUIRED_NATIVE_ADAPTERS.includes(repository.adapters[0])) {
      throw new Error(`corpus repository ${repository.id} must own exactly one required adapter.`);
    }
    if (adapters.has(repository.adapters[0])) {
      throw new Error(`corpus manifest duplicates adapter ${repository.adapters[0]}.`);
    }
    adapters.add(repository.adapters[0]);
    exactKeys(repository.expectedScope, ["extensions", "minimumFiles"], `corpus repository ${repository.id} expectedScope`);
    if (!Array.isArray(repository.expectedScope.extensions) || !repository.expectedScope.extensions.length
      || !repository.expectedScope.extensions.every((entry) => /^\.[a-z0-9]+$/u.test(entry))
      || !Number.isSafeInteger(repository.expectedScope.minimumFiles)
      || repository.expectedScope.minimumFiles < 1) {
      throw new Error(`corpus repository ${repository.id} has an invalid expected scope.`);
    }
  }
  if (JSON.stringify([...adapters].sort()) !== JSON.stringify([...REQUIRED_NATIVE_ADAPTERS].sort())) {
    throw new Error("corpus manifest must contain exactly one pinned real repository per required adapter.");
  }
  return manifest;
}

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: options.encoding === null ? null : "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
}

function sourceDigest(root) {
  return crypto.createHash("sha256")
    .update(git(root, ["ls-tree", "-r", "--full-tree", "HEAD"], { encoding: null }))
    .digest("hex");
}

function checkoutRepository(repository, cloneDirectory) {
  const destination = path.join(cloneDirectory, repository.id);
  if (fs.existsSync(destination)) throw new Error(`corpus checkout already exists: ${destination}`);
  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", repository.repository, destination], {
    stdio: "inherit",
  });
  git(destination, ["checkout", "--detach", repository.revision], { stdio: "inherit" });
  return destination;
}

function inventory(root) {
  const files = git(root, ["ls-files"]).trim().split(/\r?\n/u).filter(Boolean);
  return {
    files,
    digest: crypto.createHash("sha256").update(files.join("\n")).digest("hex"),
  };
}

function scopeEvidence(root, expectedScope) {
  const files = git(root, ["ls-files"]).trim().split(/\r?\n/u).filter(Boolean);
  const matchingFiles = files.filter((file) => expectedScope.extensions.includes(path.extname(file).toLowerCase()));
  if (matchingFiles.length < expectedScope.minimumFiles) {
    throw new Error(`repository scope has ${matchingFiles.length} matching files; expected at least ${expectedScope.minimumFiles}.`);
  }
  return {
    extensions: expectedScope.extensions,
    matchingFiles: matchingFiles.length,
    minimumFiles: expectedScope.minimumFiles,
  };
}

async function verifyRepository(repository, root, native) {
  const resolved = fs.realpathSync(root);
  const revision = git(resolved, ["rev-parse", "HEAD"]).trim();
  if (revision !== repository.revision) throw new Error(`${repository.id} is at ${revision}, expected ${repository.revision}.`);
  if (git(resolved, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
    throw new Error(`${repository.id} checkout is not clean before verification.`);
  }
  if (sourceDigest(resolved) !== repository.sourceDigest) {
    throw new Error(`${repository.id} source digest does not match committed corpus metadata.`);
  }
  const license = path.join(resolved, repository.licenseFile);
  if (!fs.existsSync(license) || !fs.statSync(license).isFile()) {
    throw new Error(`${repository.id} declared license file is absent.`);
  }
  const before = inventory(resolved);
  const scope = scopeEvidence(resolved, repository.expectedScope);
  const javascript = createJsCoreClient();
  const javascriptResult = await createScanCoordinator(resolved, {
    cache: false,
    coreClient: javascript,
  }).refresh(null, `real-corpus-js-${repository.id}`);
  const nativeResult = await createScanCoordinator(resolved, {
    cache: false,
    coreClient: native,
  }).refresh(null, `real-corpus-native-${repository.id}`);
  assert.equal(javascriptResult.outcome.status, "complete", `${repository.id}: JavaScript scan failed`);
  assert.equal(nativeResult.outcome.status, "complete", `${repository.id}: native scan failed`);
  const javascriptDigest = createCoreCompatibilityDigest(javascriptResult.graph);
  const nativeDigest = createCoreCompatibilityDigest(nativeResult.graph);
  if (nativeDigest !== javascriptDigest) {
    assert.deepEqual(
      createCoreCompatibilityProjection(nativeResult.graph),
      createCoreCompatibilityProjection(javascriptResult.graph),
      `${repository.id}: compatibility projection diverged`,
    );
  }
  assert.equal(nativeDigest, javascriptDigest, `${repository.id}: compatibility projection diverged`);
  assert.deepEqual(nativeResult.graph.stats, javascriptResult.graph.stats, `${repository.id}: graph stats diverged`);
  const adapterId = repository.adapters[0];
  const capability = nativeResult.graph.analysis?.executionAdapterCapabilities?.adapters
    ?.find((entry) => entry.id === adapterId);
  assert.equal(capability?.availability, "bundled", `${repository.id}: ${adapterId} execution adapter is not bundled`);
  assert.equal(capability?.requiredToolchain, null, `${repository.id}: ${adapterId} unexpectedly requires an external toolchain`);
  assert.equal(native.sourceAuthority, "rust");
  assert.equal(native.parserHost, "rust-tree-sitter-source/v19");
  assert.equal(native.factEnvelopeHost, "rust-native-structural-batch/v1");
  assert.equal(native.backendAuthority, "rust-sqlite");
  assert.equal(nativeResult.graph.analysis.graphState.persistence, "session-memory");
  const after = inventory(resolved);
  assert.deepEqual(after, before, `${repository.id}: tracked source inventory changed`);
  assert.equal(git(resolved, ["status", "--porcelain", "--untracked-files=all"]).trim(), "", `${repository.id}: verification wrote to target repository`);
  assert.equal(fs.existsSync(path.join(resolved, ".flopeek")), false, `${repository.id}: verification created .flopeek`);
  assert.equal(fs.existsSync(path.join(resolved, ".flowpeek")), false, `${repository.id}: verification created .flowpeek`);
  return {
    id: repository.id,
    repository: repository.repository,
    revision,
    sourceDigest: repository.sourceDigest,
    license: repository.license,
    adapterId,
    scope,
    exact: true,
    javascriptCompatibilityDigest: javascriptDigest,
    nativeCompatibilityDigest: nativeDigest,
    stats: nativeResult.graph.stats,
    nativeParserHost: native.parserHost,
    executionAdapterCapability: capability,
    targetRepositoryWrites: false,
  };
}

function parseArguments(argv) {
  const options = {
    manifest: path.resolve(__dirname, "..", "benchmarks", "native-adapter-corpus.json"),
    cloneDirectory: null,
    binary: null,
    output: null,
    repositories: {},
    sourceRevision: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--repository") {
      const value = argv[++index] || "";
      const split = value.indexOf("=");
      if (split < 1) throw new Error("--repository must use id=path.");
      options.repositories[value.slice(0, split)] = path.resolve(value.slice(split + 1));
      continue;
    }
    const key = {
      "--manifest": "manifest",
      "--clone-directory": "cloneDirectory",
      "--binary": "binary",
      "--output": "output",
      "--source-revision": "sourceRevision",
    }[flag];
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete corpus argument: ${flag}`);
    options[key] = path.resolve(argv[++index]);
    if (key === "sourceRevision") options[key] = argv[index];
  }
  if (!options.binary || !options.output) throw new Error("--binary and --output are required.");
  if (!options.cloneDirectory && !Object.keys(options.repositories).length) {
    throw new Error("provide --clone-directory or explicit --repository id=path mappings.");
  }
  return options;
}

async function runCorpus(options) {
  const manifest = validateManifest(JSON.parse(fs.readFileSync(options.manifest, "utf8")));
  if (!fs.existsSync(options.binary) || !fs.statSync(options.binary).isFile()) {
    throw new Error("real corpus requires the exact candidate binary.");
  }
  if (options.cloneDirectory) fs.mkdirSync(options.cloneDirectory, { recursive: true });
  const binarySha256 = crypto.createHash("sha256").update(fs.readFileSync(options.binary)).digest("hex");
  const native = createNativeCoreClient({
    native: createNativeIncrementalSession(
      { command: options.binary, args: [] },
      { cwd: path.resolve(__dirname, "..") },
    ),
    sourceAuthority: "rust",
  });
  const results = [];
  try {
    for (const repository of manifest.repositories) {
      const root = options.repositories[repository.id]
        || checkoutRepository(repository, options.cloneDirectory);
      results.push(await verifyRepository(repository, root, native));
    }
  } finally {
    await native.close();
  }
  const sourceRevision = options.sourceRevision || git(path.resolve(__dirname, ".."), ["rev-parse", "HEAD"]).trim();
  const evidence = {
    schemaVersion: EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    binarySha256,
    sourceRevision,
    summary: {
      repositories: results.length,
      adapters: [...new Set(results.map((entry) => entry.adapterId))].sort(),
      exactRepositories: results.filter((entry) => entry.exact).length,
      targetRepositoryWrites: results.some((entry) => entry.targetRepositoryWrites),
    },
    repositories: results,
  };
  if (evidence.summary.repositories !== REQUIRED_NATIVE_ADAPTERS.length
    || evidence.summary.exactRepositories !== evidence.summary.repositories
    || evidence.summary.targetRepositoryWrites
    || JSON.stringify(evidence.summary.adapters) !== JSON.stringify([...REQUIRED_NATIVE_ADAPTERS].sort())) {
    throw new Error("real corpus evidence is incomplete.");
  }
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

async function main() {
  const evidence = await runCorpus(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Verified exact native parity on ${evidence.summary.repositories} pinned repositories across ${evidence.summary.adapters.length} adapters.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Native real corpus blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  checkoutRepository,
  inventory,
  parseArguments,
  runCorpus,
  scopeEvidence,
  sourceDigest,
  validateManifest,
  verifyRepository,
};
