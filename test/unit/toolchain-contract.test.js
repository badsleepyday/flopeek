"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  dotnetContract,
  goContract,
  rustContract,
  verifyToolchains,
} = require("../../scripts/verify-toolchains");

const ROOT = path.resolve(__dirname, "..", "..");
const exact = {
  rustc: "rustc 1.97.0 (2d8144b78 2026-07-07)\nbinary: rustc\ncommit-hash: 2d8144b7880597b6e6d3dfd63a9a9efae3f533d3\ncommit-date: 2026-07-07\nhost: x86_64-unknown-linux-gnu\nrelease: 1.97.0\nLLVM version: 22.1.6\n",
  dotnet: "10.0.302\n",
  go: "go version go1.26.4 linux/amd64\n",
  node: "v22.20.0\n",
};

function executor(overrides = {}) {
  return (command) => overrides[command] ?? exact[command];
}

test("toolchain contracts are exact and use bounded roll-forward", () => {
  assert.deepEqual(rustContract(ROOT), {
    channel: "1.97.0",
    profile: "minimal",
    components: ["rustfmt", "clippy"],
  });
  assert.deepEqual(dotnetContract(ROOT), {
    version: "10.0.302",
    rollForward: "latestPatch",
    allowPrerelease: false,
  });
  assert.deepEqual(goContract(ROOT), { version: "go1.26.4" });
  assert.equal(verifyToolchains({ root: ROOT, execFileSync: executor() }).node.actualVersion, "v22.20.0");
});

test("toolchain verification rejects Rust, .NET, Go, and Node drift", () => {
  assert.throws(
    () => verifyToolchains({ root: ROOT, execFileSync: executor({ rustc: exact.rustc.replaceAll("1.97.0", "1.98.0") }) }),
    /Rust toolchain does not match/u,
  );
  assert.throws(
    () => verifyToolchains({ root: ROOT, execFileSync: executor({ dotnet: "10.0.303\n" }) }),
    /\.NET SDK does not match/u,
  );
  assert.throws(
    () => verifyToolchains({ root: ROOT, execFileSync: executor({ go: "go version go1.26.5 linux/amd64\n" }) }),
    /Go toolchain does not match/u,
  );
  assert.throws(
    () => verifyToolchains({ root: ROOT, execFileSync: executor({ node: "v24.1.0\n" }) }),
    /outside the frozen 20\/22/u,
  );
});
