"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { nativeRustShadowProjection } = require("../../src/native-rust-shadow");

const ROOT = path.join(__dirname, "..", "..");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function nativeProjection(root) {
  const payload = JSON.parse(execFileSync("cargo", ["run", "--quiet", "--manifest-path", MANIFEST, "--", "--native-rust-graph", root], { cwd: ROOT, encoding: "utf8" }));
  return {
    schemaVersion: payload.schemaVersion,
    nodes: payload.nodes.map((node) => node.id).sort(),
    edges: payload.edges.map((edge) => ({ type: edge.type, source: edge.source, target: edge.target }))
      .sort((left, right) => `${left.type}\0${left.source}\0${left.target}`.localeCompare(`${right.type}\0${right.source}\0${right.target}`)),
  };
}

test("native Rust graph shadow exactly matches the JS projection contract", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-rust-graph-parity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "Cargo.toml", "[package]\nname = \"native-rust-parity\"\nversion = \"0.1.0\"\n");
  write(root, "src/lib.rs", "mod helpers;\nuse crate::helpers::parse;\npub fn run() { parse(); }\n");
  write(root, "src/helpers.rs", "pub fn parse() {}\n");
  assert.deepEqual(nativeProjection(root), nativeRustShadowProjection(root));
});
