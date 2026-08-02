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
const {
  platformPackage,
  verifyInstalledContextRef,
} = require("./verify-native-candidate-install");

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

async function main(argv = process.argv.slice(2)) {
  const bundle = path.resolve(argument(argv, "--bundle") || "");
  const manifestFile = path.resolve(argument(argv, "--manifest") || "");
  const channel = argument(argv, "--channel");
  const output = argument(argv, "--output");
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
    const scan = (root, extra = []) => JSON.parse(execFileSync(process.execPath, [
      cli,
      "scan",
      root,
      ...extra,
      "--format",
      "json",
      "--core-mode",
      "native",
    ], { cwd: sandbox, encoding: "utf8", env: environment, maxBuffer: 32 * 1024 * 1024 }));
    const graph = scan(fixture);
    assert.equal(graph.analysis?.coreRuntime?.execution?.selectedImplementation, "native");
    assert.equal(graph.analysis?.coreRuntime?.execution?.fallback?.active, false);
    assert.equal(graph.analysis?.coreRuntime?.execution?.sourceAuthority, "rust");
    assert.equal(fs.existsSync(path.join(fixture, ".flopeek", "native-core.sqlite3")), true);
    assert.equal(fs.existsSync(path.join(fixture, ".flopeek", "graph.json")), false);
    fs.appendFileSync(path.join(fixture, "index.ts"), "export const refreshed = true;\n");
    const refreshed = scan(fixture);
    assert.ok(refreshed.state.graphVersion > graph.state.graphVersion);
    const contextProof = await verifyInstalledContextRef(
      path.join(sandbox, "node_modules", "flopeek"),
      fixture,
    );
    const delta = JSON.parse(execFileSync(process.execPath, [
      cli,
      "delta",
      fixture,
      "--from-version",
      String(graph.state.graphVersion),
      "--to-version",
      String(refreshed.state.graphVersion),
      "--format",
      "json",
      "--core-mode",
      "native",
    ], { cwd: sandbox, encoding: "utf8", env: environment, maxBuffer: 32 * 1024 * 1024 }));
    assert.equal(delta.fromGraphVersion, graph.state.graphVersion);
    assert.equal(delta.toGraphVersion, refreshed.state.graphVersion);

    const fallbackFixture = path.join(sandbox, "fallback-fixture");
    fs.mkdirSync(fallbackFixture);
    fs.writeFileSync(path.join(fallbackFixture, "index.ts"), "export const fallback = true;\n");
    const missingBinary = `${binary}.missing`;
    fs.renameSync(binary, missingBinary);
    let missing;
    try {
      missing = scan(fallbackFixture, ["--no-cache"]);
    } finally {
      fs.renameSync(missingBinary, binary);
    }
    assert.equal(missing.analysis?.coreRuntime?.selectedImplementation, "javascript");
    assert.equal(missing.analysis?.coreRuntime?.fallback?.active, true);
    const exactBinary = fs.readFileSync(binary);
    fs.appendFileSync(binary, "tampered");
    let tampered;
    try {
      tampered = scan(fallbackFixture, ["--no-cache"]);
    } finally {
      fs.writeFileSync(binary, exactBinary);
    }
    assert.equal(tampered.analysis?.coreRuntime?.selectedImplementation, "javascript");
    assert.equal(tampered.analysis?.coreRuntime?.fallback?.active, true);
    assert.equal(hash(binary), expectedNative.binarySha256);
    assert.equal(fs.existsSync(path.join(fallbackFixture, ".flopeek")), false);
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
      sourceAuthority: "rust",
      sqliteAuthority: true,
      graphJsonAuthority: false,
      contextRef: contextProof.contextRef,
      contextRefResolution: contextProof.resolutionStatus,
      refresh: {
        fromVersion: graph.state.graphVersion,
        toVersion: refreshed.state.graphVersion,
        deltaSchemaVersion: delta.schemaVersion,
      },
      fallbackProofs: {
        missingBinary: missing.analysis.coreRuntime.fallback,
        tamperedBinary: tampered.analysis.coreRuntime.fallback,
      },
    };
    if (output) {
      const resolved = path.resolve(output);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Registry release blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, registryVersion, verifyRegistryArtifact };
