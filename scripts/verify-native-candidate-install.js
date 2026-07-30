#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadNativeReleaseManifest } = require("./native-release-manifest");

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function platformPackage() {
  const key = `${process.platform}/${process.arch}`;
  return {
    "linux/x64": ["@flopeek/native-linux-x64-gnu", "flopeek-native-core"],
    "linux/arm64": ["@flopeek/native-linux-arm64-gnu", "flopeek-native-core"],
    "darwin/x64": ["@flopeek/native-darwin-x64", "flopeek-native-core"],
    "darwin/arm64": ["@flopeek/native-darwin-arm64", "flopeek-native-core"],
    "win32/x64": ["@flopeek/native-win32-x64", "flopeek-native-core.exe"],
    "win32/arm64": ["@flopeek/native-win32-arm64", "flopeek-native-core.exe"],
  }[key] || null;
}

function main(argv = process.argv.slice(2)) {
  const mainTarball = path.resolve(argument(argv, "--main") || "");
  const nativeTarball = path.resolve(argument(argv, "--native") || "");
  const manifestFile = path.resolve(argument(argv, "--manifest") || "");
  const output = argument(argv, "--output");
  if (![mainTarball, nativeTarball, manifestFile].every((file) => fs.existsSync(file) && fs.statSync(file).isFile())) {
    throw new Error("Usage: verify-native-candidate-install --main <tgz> --native <tgz> --manifest <json> [--output <json>].");
  }
  const platform = platformPackage();
  if (!platform) throw new Error(`candidate install has no registered platform for ${process.platform}/${process.arch}.`);
  const [packageName, executable] = platform;
  const manifest = loadNativeReleaseManifest(manifestFile);
  const artifact = manifest.artifacts.native[packageName];
  if (!artifact || path.basename(nativeTarball) !== artifact.filename
    || hash(mainTarball) !== manifest.artifacts.main.sha256
    || hash(nativeTarball) !== artifact.tarballSha256) {
    throw new Error("candidate install inputs do not match the exact release manifest.");
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-candidate-install-"));
  try {
    execFileSync("npm", ["init", "-y"], { cwd: sandbox, stdio: "ignore" });
    execFileSync("npm", [
      "install",
      "--ignore-scripts=false",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      mainTarball,
      nativeTarball,
    ], { cwd: sandbox, stdio: "inherit" });
    const binary = path.join(sandbox, "node_modules", ...packageName.split("/"), "bin", executable);
    assert.equal(hash(binary), artifact.binarySha256, "installed binary digest diverged from the release manifest");
    const fixture = path.join(sandbox, "fixture");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, "index.ts"), "export function candidateInstall() { return true; }\n");
    const cli = path.join(sandbox, "node_modules", "flopeek", "src", "cli.js");
    const stdout = execFileSync(process.execPath, [
      cli,
      "scan",
      fixture,
      "--no-cache",
      "--format",
      "json",
      "--core-mode",
      "native",
    ], { cwd: sandbox, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const graph = JSON.parse(stdout);
    const execution = graph.analysis?.coreRuntime?.execution;
    assert.equal(execution?.selectedImplementation, "native");
    assert.equal(execution?.sourceAuthority, "rust");
    assert.equal(execution?.fallback?.active, false);
    assert.equal(fs.existsSync(path.join(fixture, ".flopeek")), false, "cache-disabled install smoke wrote repository metadata");
    const report = {
      schemaVersion: "flopeek-native-candidate-install/v1",
      status: "verified",
      packageVersion: manifest.release.version,
      sourceSha: manifest.release.repositoryRevision,
      platformPackage: packageName,
      binarySha256: artifact.binarySha256,
      selectedImplementation: execution.selectedImplementation,
      sourceAuthority: execution.sourceAuthority,
      fallback: execution.fallback,
      targetRepositoryWrites: false,
    };
    if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Candidate install blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, platformPackage };
