"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");

test("Go stdlib catalog is versioned, target-complete, unique, and packaged", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "go-stdlib-catalog.json"), "utf8"));
  assert.equal(catalog.schemaVersion, "flopeek-go-stdlib-catalog/v1");
  assert.equal(catalog.goVersion, "go1.26.4");
  assert.deepEqual(catalog.targets, [
    "darwin/amd64",
    "darwin/arm64",
    "linux/amd64",
    "linux/arm64",
    "windows/amd64",
    "windows/arm64",
  ]);
  assert.equal(new Set(catalog.packages).size, catalog.packages.length);
  assert.deepEqual(catalog.packages, [...catalog.packages].sort());
  for (const specifier of ["C", "net/http", "unique", "weak"]) {
    assert.ok(catalog.packages.includes(specifier), specifier);
  }
  for (const specifier of ["fmt/not-a-real-package", "example.com/unique"]) {
    assert.equal(catalog.packages.includes(specifier), false, specifier);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "packaging", "package-policy.json"), "utf8"));
  assert.ok(packageJson.files.includes("contracts/go-stdlib-catalog.json"));
  assert.ok(policy.requiredPaths.includes("contracts/go-stdlib-catalog.json"));
});
