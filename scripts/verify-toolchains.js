#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync: execute } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SUPPORTED_NODE_MAJORS = Object.freeze([20, 22]);

function rustContract(root) {
  const source = fs.readFileSync(path.join(root, "rust-toolchain.toml"), "utf8");
  const channel = source.match(/^\s*channel\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  const profile = source.match(/^\s*profile\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  const components = source.match(/^\s*components\s*=\s*\[([^\]]+)\]\s*$/mu)?.[1]
    ?.split(",").map((value) => value.trim().replace(/^"|"$/gu, "")).filter(Boolean);
  if (!/^\d+\.\d+\.\d+$/u.test(channel || "")
    || profile !== "minimal"
    || !Array.isArray(components)
    || !["rustfmt", "clippy"].every((component) => components.includes(component))) {
    throw new Error("rust-toolchain.toml must pin one exact Rust release with minimal, rustfmt, and clippy.");
  }
  return { channel, profile, components };
}

function dotnetContract(root) {
  const globalJson = JSON.parse(fs.readFileSync(path.join(root, "global.json"), "utf8"));
  const sdk = globalJson?.sdk;
  if (!/^\d+\.\d+\.\d+$/u.test(sdk?.version || "")
    || sdk.rollForward !== "latestPatch"
    || sdk.allowPrerelease !== false) {
    throw new Error("global.json must pin one exact stable .NET SDK and restrict roll-forward to the same feature band.");
  }
  return { version: sdk.version, rollForward: sdk.rollForward, allowPrerelease: sdk.allowPrerelease };
}

function goContract(root) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "contracts", "go-stdlib-catalog.json"), "utf8"));
  if (catalog?.schemaVersion !== "flopeek-go-stdlib-catalog/v1"
    || !/^go\d+\.\d+\.\d+$/u.test(catalog.goVersion || "")) {
    throw new Error("The Go standard-library catalog must carry one exact Go version.");
  }
  return { version: catalog.goVersion };
}

function output(command, args, root, execFileSync) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

function verifyToolchains({ root = ROOT, execFileSync = execute } = {}) {
  const rust = rustContract(root);
  const dotnet = dotnetContract(root);
  const go = goContract(root);
  const rustLines = output("rustc", ["--version", "--verbose"], root, execFileSync).split(/\r?\n/u);
  const rustFields = Object.fromEntries(rustLines.slice(1)
    .map((line) => line.split(/:\s+/u, 2))
    .filter(([key, value]) => key && value));
  const actualRust = {
    version: rustLines[0],
    release: rustFields.release || null,
    commitHash: rustFields["commit-hash"] || null,
    commitDate: rustFields["commit-date"] || null,
    host: rustFields.host || null,
    llvmVersion: rustFields["LLVM version"] || null,
  };
  if (actualRust.release !== rust.channel
    || !/^[a-f0-9]{40}$/u.test(actualRust.commitHash || "")
    || !/^\d{4}-\d{2}-\d{2}$/u.test(actualRust.commitDate || "")
    || typeof actualRust.host !== "string" || !actualRust.host
    || typeof actualRust.llvmVersion !== "string" || !actualRust.llvmVersion) {
    throw new Error(`Actual Rust toolchain does not match rust-toolchain.toml (${actualRust.release || "unknown"} != ${rust.channel}).`);
  }
  const actualDotnet = output("dotnet", ["--version"], root, execFileSync);
  if (actualDotnet !== dotnet.version) {
    throw new Error(`Actual .NET SDK does not match global.json (${actualDotnet} != ${dotnet.version}).`);
  }
  const actualGoOutput = output("go", ["version"], root, execFileSync);
  const actualGo = actualGoOutput.match(/\b(go\d+\.\d+\.\d+)\b/u)?.[1] || null;
  if (actualGo !== go.version) {
    throw new Error(`Actual Go toolchain does not match the stdlib catalog (${actualGo || "unknown"} != ${go.version}).`);
  }
  const actualNodeVersion = output("node", ["--version"], root, execFileSync);
  const actualNodeMajor = Number(actualNodeVersion.match(/^v(\d+)\./u)?.[1]);
  if (!SUPPORTED_NODE_MAJORS.includes(actualNodeMajor)) {
    throw new Error(`Actual Node major ${actualNodeMajor || "unknown"} is outside the frozen 20/22 release contract.`);
  }
  return Object.freeze({
    schemaVersion: "flopeek-toolchain-verification/v1",
    rust: { contract: rust, actual: actualRust },
    dotnet: { contract: dotnet, actualVersion: actualDotnet },
    go: { contract: go, actualVersion: actualGo },
    node: { supportedMajors: SUPPORTED_NODE_MAJORS, actualVersion: actualNodeVersion },
  });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(verifyToolchains(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SUPPORTED_NODE_MAJORS,
  dotnetContract,
  goContract,
  rustContract,
  verifyToolchains,
};
