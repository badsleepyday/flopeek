#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadNativeReleaseManifest } = require("./native-release-manifest");
const {
  registryDist,
  tarballIdentity,
  verifyExisting,
} = require("./publish-npm-release-set");
const { platformPackage } = require("./verify-native-candidate-install");

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function registryVersion(packageName, tag) {
  const output = execFileSync("npm", [
    "view",
    `${packageName}@${tag}`,
    "version",
    "--json",
    "--registry=https://registry.npmjs.org",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output);
}

function verifyRegistryArtifact(tarball) {
  const identity = tarballIdentity(tarball);
  const dist = registryDist(identity);
  if (!dist) throw new Error(`${identity.name}@${identity.version} is absent from the public registry.`);
  verifyExisting(identity, dist);
  return identity;
}

function main(argv = process.argv.slice(2)) {
  const bundle = path.resolve(argument(argv, "--bundle") || "");
  const manifestFile = path.resolve(argument(argv, "--manifest") || "");
  const channel = argument(argv, "--channel");
  if (!fs.existsSync(bundle) || !fs.statSync(bundle).isDirectory()
    || !fs.existsSync(manifestFile) || !channel) {
    throw new Error("Usage: verify-native-registry-release --bundle <directory> --manifest <json> --channel <tag>.");
  }
  const manifest = loadNativeReleaseManifest(manifestFile);
  const verified = [];
  verified.push(verifyRegistryArtifact(path.join(bundle, "flopeek-main.tgz")));
  for (const artifact of Object.values(manifest.artifacts.native)) {
    verified.push(verifyRegistryArtifact(path.join(bundle, artifact.filename)));
  }
  for (const identity of verified) {
    assert.equal(registryVersion(identity.name, channel), identity.version, `${identity.name}@${channel} is not the candidate version`);
  }
  const platform = platformPackage();
  if (!platform) throw new Error(`registry smoke has no registered platform for ${process.platform}/${process.arch}.`);
  const [platformPackageName, executable] = platform;
  const expectedNative = manifest.artifacts.native[platformPackageName];
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-registry-install-"));
  try {
    execFileSync("npm", ["init", "-y"], { cwd: sandbox, stdio: "ignore" });
    const environment = { ...process.env };
    delete environment.NODE_AUTH_TOKEN;
    delete environment.NPM_TOKEN;
    execFileSync("npm", [
      "install",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      `flopeek@${manifest.release.version}`,
    ], { cwd: sandbox, env: environment, stdio: "inherit" });
    const binary = path.join(sandbox, "node_modules", ...platformPackageName.split("/"), "bin", executable);
    assert.equal(hash(binary), expectedNative.binarySha256, "anonymous registry install selected a binary outside the manifest");
    const fixture = path.join(sandbox, "fixture");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, "index.ts"), "export const registryRelease = true;\n");
    const cli = path.join(sandbox, "node_modules", "flopeek", "src", "cli.js");
    const graph = JSON.parse(execFileSync(process.execPath, [
      cli,
      "scan",
      fixture,
      "--no-cache",
      "--format",
      "json",
      "--core-mode",
      "native",
    ], { cwd: sandbox, encoding: "utf8", env: environment, maxBuffer: 32 * 1024 * 1024 }));
    assert.equal(graph.analysis?.coreRuntime?.execution?.selectedImplementation, "native");
    assert.equal(graph.analysis?.coreRuntime?.execution?.fallback?.active, false);
    assert.equal(fs.existsSync(path.join(fixture, ".flopeek")), false);
    const report = {
      schemaVersion: "flopeek-native-registry-release-verification/v1",
      status: "verified",
      packageVersion: manifest.release.version,
      channel,
      artifacts: verified.map(({ name, version, shasum, integrity }) => ({ name, version, shasum, integrity })),
      platformPackage: platformPackageName,
      binarySha256: expectedNative.binarySha256,
      anonymousInstall: true,
      selectedImplementation: "native",
    };
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
    process.stderr.write(`Registry release blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, registryVersion, verifyRegistryArtifact };
