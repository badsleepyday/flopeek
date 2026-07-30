"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { validateBenchmark } = require("../../scripts/build-native-rollout-evidence");
const { removeStagingTag } = require("../../scripts/cleanup-npm-staging-tags");
const { publishTarball, tarballIdentity, verifyExisting } = require("../../scripts/publish-npm-release-set");
const {
  loadBundledNativeRolloutEvidence,
  probeVerifiedNativeRuntime,
} = require("../../src/native-rollout-evidence");

const ROOT = path.resolve(__dirname, "..", "..");

test("bundled rollout evidence is version-bound and honestly incomplete", () => {
  const result = loadBundledNativeRolloutEvidence(ROOT);
  assert.equal(result.complete, false);
  assert.equal(result.packet.status, "incomplete");
  assert.equal(result.packet.binding.binaries, null);
  assert.deepEqual(result.evidence, {});
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
      }),
      verifyBinary: () => true,
      expectedBinaries: { "@flopeek/native-win32-x64": "b".repeat(64) },
    };
    const blocked = probeVerifiedNativeRuntime(root, options);
    assert.equal(blocked.available, false);
    assert.equal(blocked.reason, "native-runtime-not-bound-to-rollout-evidence");
    const accepted = probeVerifiedNativeRuntime(root, {
      ...options,
      expectedBinaries: { "@flopeek/native-win32-x64": "a".repeat(64) },
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
  const state = {
    jsSamplesMs: [1, 1, 1],
    nativeSamplesMs: [1, 1, 1],
    speedupNativeVsJavaScript: 1,
  };
  const row = (repository) => ({
    repository,
    states: { cold: state, unchanged: state, oneFileChange: state },
  });
  assert.throws(
    () => validateBenchmark({
      schemaVersion: "flopeek-native-core-client-benchmark/v1",
      rows: Array.from({ length: 5 }, () => row("same")),
    }),
    /distinct repositories/,
  );
  assert.throws(
    () => validateBenchmark({
      schemaVersion: "flopeek-native-core-client-benchmark/v1",
      rows: Array.from({ length: 5 }, (_, index) => ({
        ...row(`repo-${index}`),
        states: { ...row(`repo-${index}`).states, cold: { ...state, jsSamplesMs: [1] } },
      })),
    }),
    /paired raw samples/,
  );
});
