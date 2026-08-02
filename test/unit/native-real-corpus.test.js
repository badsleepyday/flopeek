"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  scopeEvidence,
  validateManifest,
} = require("../../scripts/verify-native-real-corpus");
const { REQUIRED_NATIVE_ADAPTERS } = require("../../src/native-rollout-gate");

const ROOT = path.resolve(__dirname, "..", "..");

test("native adapter corpus pins one distinct real repository per required adapter", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "native-adapter-corpus.json"), "utf8"));
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.equal(manifest.repositories.length, REQUIRED_NATIVE_ADAPTERS.length);
  assert.deepEqual(manifest.repositories.flatMap((entry) => entry.adapters).sort(), [...REQUIRED_NATIVE_ADAPTERS].sort());
  assert.equal(new Set(manifest.repositories.map((entry) => entry.repository)).size, REQUIRED_NATIVE_ADAPTERS.length);
});

test("native adapter corpus rejects duplicate adapters, abbreviated revisions, and missing scope", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmarks", "native-adapter-corpus.json"), "utf8"));
  const duplicate = structuredClone(manifest);
  duplicate.repositories[1].adapters = duplicate.repositories[0].adapters;
  assert.throws(() => validateManifest(duplicate), /duplicates adapter/);
  const abbreviated = structuredClone(manifest);
  abbreviated.repositories[0].revision = abbreviated.repositories[0].revision.slice(0, 7);
  assert.throws(() => validateManifest(abbreviated), /full commit/);
  const missing = structuredClone(manifest);
  delete missing.repositories[0].expectedScope;
  assert.throws(() => validateManifest(missing), /missing fields/);
});

test("expected repository scope is measured from tracked files and fails closed", (context) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-corpus-scope-"));
  context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, "one.ts"), "export const one = 1;\n");
  fs.writeFileSync(path.join(fixture, "two.ts"), "export const two = 2;\n");
  fs.writeFileSync(path.join(fixture, "ignored.go"), "package ignored\n");
  execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: fixture, stdio: "ignore" });
  assert.deepEqual(scopeEvidence(fixture, {
    extensions: [".ts"],
    minimumFiles: 2,
  }), {
    extensions: [".ts"],
    matchingFiles: 2,
    minimumFiles: 2,
  });
  assert.throws(() => scopeEvidence(fixture, {
    extensions: [".rs"],
    minimumFiles: 1,
  }), /expected at least 1/);
});
