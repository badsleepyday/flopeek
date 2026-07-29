"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const PACKAGER = path.join(ROOT, "scripts", "package-native-platform.js");

test("platform packager emits a target-locked protocol and checksum manifest", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-package-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "source.exe");
  const contents = Buffer.from("flopeek native fixture\0bytes");
  fs.writeFileSync(binary, contents);
  const output = path.join(root, "output");
  execFileSync(process.execPath, [PACKAGER,
    "--package", "@flopeek/native-win32-x64",
    "--os", "win32",
    "--cpu", "x64",
    "--binary", binary,
    "--output", output,
  ], { cwd: ROOT, windowsHide: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "package.json"), "utf8"));
  assert.deepEqual(manifest.os, ["win32"]);
  assert.deepEqual(manifest.cpu, ["x64"]);
  assert.equal(manifest.flopeekNative.protocolVersion, "flopeek-native-protocol/v1");
  assert.equal(manifest.flopeekNative.binarySha256, createHash("sha256").update(contents).digest("hex"));
  assert.deepEqual(fs.readFileSync(path.join(output, "bin", "flopeek-native-core.exe")), contents);
});

test("platform packager rejects a package name that does not match its OS and CPU", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-package-invalid-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "source.exe");
  fs.writeFileSync(binary, "fixture");
  const result = spawnSync(process.execPath, [PACKAGER,
    "--package", "@flopeek/native-linux-x64-gnu",
    "--os", "win32",
    "--cpu", "x64",
    "--binary", binary,
    "--output", path.join(root, "output"),
  ], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mismatched native package target/);
});
