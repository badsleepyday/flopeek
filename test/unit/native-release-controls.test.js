"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  platformBinaryBindings,
  validateBenchmark,
  validateProfiles,
} = require("../../scripts/build-native-rollout-evidence");
const { preparePacket } = require("../../scripts/prepare-native-rollout-evidence");
const { removeStagingTag } = require("../../scripts/cleanup-npm-staging-tags");
const { publishTarball, tarballIdentity, verifyExisting } = require("../../scripts/publish-npm-release-set");
const {
  loadBundledNativeRolloutEvidence,
  probeVerifiedNativeRuntime,
} = require("../../src/native-rollout-evidence");
const { NATIVE_PLATFORM_TARGETS } = require("../../src/native-platform-targets");

const ROOT = path.resolve(__dirname, "..", "..");

test("bundled rollout evidence is version-bound and honestly incomplete", () => {
  const result = loadBundledNativeRolloutEvidence(ROOT);
  assert.equal(result.complete, false);
  assert.equal(result.packet.status, "incomplete");
  assert.equal(result.packet.binding.binaries, null);
  assert.equal(result.packet.binding.repositoryRevision, null);
  assert.equal(result.packet.binding.sourceDigest, null);
  assert.deepEqual(result.evidence, {});
});

test("release evidence preparation is fail-closed for absent or partial raw inputs", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rollout-prepare-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "flopeek", version: "1.2.3" }));
  const absent = preparePacket({
    root,
    inputs: path.join(root, "missing"),
    assets: path.join(root, "assets"),
  });
  assert.equal(absent.status, "incomplete");
  assert.equal(absent.binding.repositoryRevision, null);
  assert.equal(absent.binding.sourceDigest, null);
  assert.equal(absent.binding.binaries, null);

  const partial = path.join(root, "partial");
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, "candidate.json"), "{}");
  assert.throws(
    () => preparePacket({ root, inputs: partial, assets: path.join(root, "assets") }),
    /inputs are partial/,
  );
});

test("verified runtime must match the rollout packet's platform binary binding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-runtime-binding-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    version: "1.2.3",
    optionalDependencies: { "@flopeek/native-win32-x64": "1.2.3" },
  }));
  try {
    const options = {
      resolveBinary: () => "native.exe",
      readMetadata: () => ({
        packageName: "@flopeek/native-win32-x64",
        version: "1.2.3",
        binarySha256: "a".repeat(64),
        repositoryRevision: "c".repeat(40),
        sourceDigest: "d".repeat(64),
        compiler: { version: "rustc 1.2.3" },
        target: "x86_64-pc-windows-msvc",
      }),
      verifyBinary: () => true,
      expectedBinaries: {
        "@flopeek/native-win32-x64": {
          binarySha256: "b".repeat(64),
          repositoryRevision: "c".repeat(40),
          sourceDigest: "d".repeat(64),
          compiler: { version: "rustc 1.2.3" },
          target: "x86_64-pc-windows-msvc",
        },
      },
    };
    const blocked = probeVerifiedNativeRuntime(root, options);
    assert.equal(blocked.available, false);
    assert.equal(blocked.reason, "native-runtime-not-bound-to-rollout-evidence");
    const accepted = probeVerifiedNativeRuntime(root, {
      ...options,
      expectedBinaries: {
        "@flopeek/native-win32-x64": {
          binarySha256: "a".repeat(64),
          repositoryRevision: "c".repeat(40),
          sourceDigest: "d".repeat(64),
          compiler: { version: "rustc 1.2.3" },
          target: "x86_64-pc-windows-msvc",
        },
      },
    });
    assert.equal(accepted.available, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resumable publisher skips only an immutable version with exact registry integrity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-publish-resume-"));
  const tarball = path.join(root, "package.tgz");
  fs.writeFileSync(tarball, "exact release bytes");
  const manifestOutput = JSON.stringify({ name: "@flopeek/native-test", version: "1.2.3" });
  const identity = tarballIdentity(tarball, () => manifestOutput);
  const calls = [];
  const execFileSync = (command, args) => {
    calls.push([command, args]);
    if (command === "tar") return manifestOutput;
    if (command === "npm" && args[0] === "view") {
      return JSON.stringify({ shasum: identity.shasum, integrity: identity.integrity });
    }
    throw new Error("publish must not run for an exact existing version");
  };
  try {
    const result = publishTarball(tarball, "candidate-1", { execFileSync });
    assert.equal(result.action, "verified-existing");
    assert.equal(calls.filter(([command, args]) => command === "npm" && args[0] === "publish").length, 0);
    assert.throws(
      () => verifyExisting(identity, { shasum: "different", integrity: identity.integrity }),
      /different registry integrity/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging-tag cleanup distinguishes absence from a failed removal", () => {
  let views = 0;
  const calls = [];
  const execFileSync = (_command, args) => {
    calls.push(args);
    if (args[0] === "dist-tag" && args[1] === "ls") {
      views += 1;
      return JSON.stringify(views === 1 ? { "candidate-1": "1.2.3", beta: "1.2.3" } : { beta: "1.2.3" });
    }
    if (args[0] === "dist-tag" && args[1] === "rm") return "";
    throw new Error("unexpected npm operation");
  };
  assert.deepEqual(
    removeStagingTag("flopeek", "candidate-1", execFileSync),
    { packageName: "flopeek", action: "removed" },
  );
  assert.equal(calls.filter((args) => args[1] === "rm").length, 1);
  assert.throws(
    () => removeStagingTag("flopeek", "candidate-1", () => { throw new Error("registry unavailable"); }),
    /registry unavailable/,
  );
});

test("rollout evidence builder rejects duplicate repositories and missing raw samples", () => {
  const nativeArtifact = {
    binarySha256: "a".repeat(64),
    platformPackage: "@flopeek/native-linux-x64-gnu",
    target: "x86_64-unknown-linux-gnu",
    compilerVersion: "rustc 1.2.3",
    repositoryRevision: "b".repeat(40),
    sourceDigest: "c".repeat(64),
  };
  const state = {
    jsSamplesMs: [1, 1, 1],
    nativeSamplesMs: [1, 1, 1],
    speedupNativeVsJavaScript: 1,
  };
  const row = (repository) => ({
    repository,
    repositoryRevision: "d".repeat(40),
    sourceDigest: "e".repeat(64),
    states: { cold: state, unchanged: state, oneFileChange: state },
  });
  assert.throws(
    () => validateBenchmark({
      schemaVersion: "flopeek-native-core-client-benchmark/v2",
      nativeArtifact,
      rows: Array.from({ length: 5 }, () => row("same")),
    }),
    /distinct repositories/,
  );
  assert.throws(
    () => validateBenchmark({
      schemaVersion: "flopeek-native-core-client-benchmark/v2",
      nativeArtifact,
      rows: Array.from({ length: 5 }, (_, index) => ({
        ...row(`repo-${index}`),
        states: { ...row(`repo-${index}`).states, cold: { ...state, jsSamplesMs: [1] } },
      })),
    }),
    /paired raw samples/,
  );
  assert.throws(
    () => validateBenchmark({
      schemaVersion: "flopeek-native-core-client-benchmark/v2",
      nativeArtifact,
      rows: Array.from({ length: 5 }, (_, index) => ({
        ...row(`repo-${index}`),
        states: {
          ...row(`repo-${index}`).states,
          cold: { ...state, speedupNativeVsJavaScript: 999 },
        },
      })),
    }),
    /aggregates do not match its raw samples/,
  );
});

test("benchmark v2 is bound to the exact release artifact", () => {
  const state = {
    jsSamplesMs: [2, 2, 2],
    nativeSamplesMs: [1, 1, 1],
    speedupNativeVsJavaScript: 2,
  };
  const nativeArtifact = {
    binarySha256: "a".repeat(64),
    platformPackage: "@flopeek/native-linux-x64-gnu",
    target: "x86_64-unknown-linux-gnu",
    compilerVersion: "rustc 1.2.3",
    repositoryRevision: "b".repeat(40),
    sourceDigest: "c".repeat(64),
  };
  const report = {
    schemaVersion: "flopeek-native-core-client-benchmark/v2",
    nativeArtifact,
    rows: Array.from({ length: 5 }, (_, index) => ({
      repository: `repo-${index}`,
      repositoryRevision: "e".repeat(40),
      sourceDigest: "f".repeat(64),
      states: { cold: { ...state }, unchanged: { ...state }, oneFileChange: { ...state } },
    })),
  };
  const release = {
    "@flopeek/native-linux-x64-gnu": {
      binarySha256: nativeArtifact.binarySha256,
      target: nativeArtifact.target,
      compiler: { version: nativeArtifact.compilerVersion },
    },
  };
  assert.equal(validateBenchmark(report, release).size, 5);
  assert.throws(
    () => validateBenchmark(report, {
      ...release,
      "@flopeek/native-linux-x64-gnu": { ...release["@flopeek/native-linux-x64-gnu"], binarySha256: "d".repeat(64) },
    }),
    /exact release binary, target, and compiler/,
  );
});

test("rollout profiles must use the exact release binary and compiler", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rollout-profiles-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binarySha256 = "a".repeat(64);
  const binding = {
    binarySha256,
    tarballSha256: "b".repeat(64),
    repositoryRevision: "c".repeat(40),
    sourceDigest: "d".repeat(64),
    compiler: { version: "rustc 1.2.3" },
    target: "x86_64-unknown-linux-gnu",
  };
  const repositories = new Map(Array.from({ length: 5 }, (_, index) => [
    `repo-${index}`,
    { revision: "1".repeat(40), sourceDigest: "f".repeat(64) },
  ]));
  const state = (repository) => ({
    native: {
      repository: { source: repository, revision: "1".repeat(40), sourceDigest: "f".repeat(64) },
      machine: {
        platform: "linux",
        arch: "x64",
        rustVersion: binding.compiler.version,
        binarySha256,
      },
      measurement: {
        queryLatency: {
          operations: {
            findNodes: { rawSamplesMs: Array(101).fill(1) },
            resolveContextRef: { rawSamplesMs: Array(101).fill(1) },
          },
        },
        concurrentMemory: {
          rawCombinedRssBytes: [100, 101],
          maximumConcurrentCombinedRssBytes: 101,
        },
      },
    },
    javascript: {
      repository: { source: repository, revision: "1".repeat(40), sourceDigest: "f".repeat(64) },
      measurement: { memoryAfter: { node: { peakRssBytes: 101 } } },
    },
  });
  for (const repository of repositories.keys()) {
    const profileState = state(repository);
    fs.writeFileSync(path.join(directory, `${repository}.json`), JSON.stringify({
      schemaVersion: "flopeek-native-core-profile/v2",
      repository,
      isolatedProcesses: true,
      states: { cold: profileState, unchanged: profileState, oneFileChange: profileState },
    }));
  }
  const bindings = { "@flopeek/native-linux-x64-gnu": binding };
  assert.deepEqual(validateProfiles(directory, repositories, bindings), {
    coreQueryP95Ms: 1,
    contextRefP95Ms: 1,
    databaseOpenDoesNotDeserializeFullGraph: true,
    memoryPeakNoWorseThanJavaScript: true,
  });

  const tampered = JSON.parse(fs.readFileSync(path.join(directory, "repo-0.json"), "utf8"));
  tampered.states.cold.native.machine.binarySha256 = "e".repeat(64);
  fs.writeFileSync(path.join(directory, "repo-0.json"), JSON.stringify(tampered));
  assert.throws(
    () => validateProfiles(directory, repositories, bindings),
    /exact release binary and compiler/,
  );
});

test("rollout artifact bindings hash the binary bytes and require one source revision", (context) => {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rollout-assets-"));
  context.after(() => fs.rmSync(assets, { recursive: true, force: true }));
  const version = "1.2.3";
  const revision = "a".repeat(40);
  const sourceDigest = "b".repeat(64);
  const compiler = { version: "rustc 1.2.3" };
  const byTarball = new Map();
  for (const target of NATIVE_PLATFORM_TARGETS) {
    const filename = `${target.packageName.replace("@flopeek/", "flopeek-")}-${version}.tgz`;
    fs.writeFileSync(path.join(assets, filename), `tarball:${target.packageName}`);
    const binary = Buffer.from(`binary:${target.packageName}`);
    byTarball.set(path.join(assets, filename), {
      binary,
      manifest: {
        name: target.packageName,
        version,
        os: [target.platform],
        cpu: [target.arch],
        flopeekNative: {
          protocolVersion: "flopeek-native-protocol/v1",
          binarySha256: require("node:crypto").createHash("sha256").update(binary).digest("hex"),
          repositoryRevision: revision,
          sourceDigest,
          compiler,
          target: target.rustTarget,
        },
      },
    });
  }
  const execFileSync = (_command, args) => {
    const artifact = byTarball.get(args[1]);
    return args[2] === "package/package.json" ? JSON.stringify(artifact.manifest) : artifact.binary;
  };
  const manifest = {
    version,
    optionalDependencies: Object.fromEntries(NATIVE_PLATFORM_TARGETS.map((target) => [target.packageName, version])),
  };
  const bindings = platformBinaryBindings(assets, manifest, execFileSync);
  assert.equal(Object.keys(bindings).length, 6);
  assert.ok(Object.values(bindings).every((binding) => binding.repositoryRevision === revision
    && binding.sourceDigest === sourceDigest && /^[a-f0-9]{64}$/u.test(binding.tarballSha256)));

  const first = byTarball.values().next().value;
  first.manifest.flopeekNative.binarySha256 = "f".repeat(64);
  assert.throws(
    () => platformBinaryBindings(assets, manifest, execFileSync),
    /binary checksum does not match/,
  );
});
