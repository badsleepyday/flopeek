"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");

function releaseNativeOptions() {
  const name = process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
  const command = path.join(ROOT, "native", "flopeek-core", "target", "release", name);
  if (!fs.existsSync(command)) {
    throw new Error(`Native release binary is missing: ${command}. Run cargo build --release --manifest-path native/flopeek-core/Cargo.toml before benchmarking.`);
  }
  return Object.freeze({ command, args: [] });
}

function repositoryBinding(root) {
  const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
  if (status) throw new Error(`Benchmark repository must be clean and revision-bound: ${root}.`);
  const repositoryRevision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceDigest = createHash("sha256")
    .update(execFileSync("git", ["-C", root, "ls-tree", "-r", "--full-tree", "HEAD"]))
    .digest("hex");
  return { repositoryRevision, sourceDigest };
}

function stateRequest(state, changedPath = null) {
  if (state === "cold") return { changedPaths: null, reason: "benchmark-cold" };
  if (state === "unchanged") return { changedPaths: [], reason: "benchmark-unchanged" };
  if (state === "oneFileChange" && typeof changedPath === "string" && changedPath) {
    return { changedPaths: [changedPath], reason: "benchmark-one-file-change" };
  }
  throw new Error(`Unknown benchmark state or missing changed path: ${state}.`);
}

module.exports = { releaseNativeOptions, repositoryBinding, stateRequest };
