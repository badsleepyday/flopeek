const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { scanRepository } = require("../../src/scanner");

const ROOT = path.join(__dirname, "..", "..");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

function nativeInventory(root) {
  const output = execFileSync("cargo", ["run", "--quiet", "--manifest-path", MANIFEST, "--", "--native-inventory-paths", root], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function nativeRustFacts(root) {
  const output = execFileSync("cargo", ["run", "--quiet", "--manifest-path", MANIFEST, "--", "--native-rust-facts", root], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("native inventory matches JavaScript registered-file candidates and reuses unchanged SQLite rows", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-parity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "src/index.js", "module.exports = 1;\n");
  write(root, "src/model.rs", "pub struct Model;\n");
  write(root, "scripts/Makefile", "all:\n\t@echo static\n");
  write(root, "docs/README.md", "ignored by registered source inventory\n");
  write(root, "node_modules/ignored.js", "module.exports = 0;\n");
  write(root, ".flopeek/cache.ts", "export const stale = true;\n");

  const jsPaths = scanRepository(root).nodes
    .filter((node) => node.kind === "file")
    .map((node) => node.path)
    .sort();
  const first = nativeInventory(root);
  assert.equal(first.schemaVersion, "flopeek-native-inventory/v1");
  assert.equal(first.candidateFiles, jsPaths.length);
  assert.deepEqual(first.candidatePaths, jsPaths);
  assert.equal(first.hashedFiles, jsPaths.length);
  const second = nativeInventory(root);
  assert.equal(second.hashedFiles, 0);
  assert.equal(second.reusedFiles, jsPaths.length);
});

test("native inventory honors the JavaScript config scope and configured project identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-scope-parity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, ".flopeek/config.json", JSON.stringify({
    schemaVersion: 1,
    projectId: "project:native-scope-parity",
    sourceRoots: ["app"],
    testRoots: ["verification"],
    fixtureRoots: ["samples"],
    exclude: ["legacy/**"],
  }));
  write(root, "app/live.ts", "export const live = true;\n");
  write(root, "app/generated/api.generated.ts", "export const api = true;\n");
  write(root, "verification/live.test.ts", "test('live', () => {});\n");
  write(root, "samples/example.ts", "export const sample = true;\n");
  write(root, "legacy/old.ts", "export const old = true;\n");
  write(root, "outside/ignored.ts", "export const ignored = true;\n");

  const jsPaths = scanRepository(root).nodes
    .filter((node) => node.kind === "file")
    .map((node) => node.path)
    .sort();
  const native = nativeInventory(root);
  assert.deepEqual(native.candidatePaths, jsPaths);
  assert.equal(native.projectId, "project:native-scope-parity");
  assert.equal(native.identity.source, "configured");
  assert.equal(native.scopeSource, "config");
  assert.deepEqual(native.sourceScopeCounts, {
    application: 1,
    excluded: 2,
    fixture: 1,
    generated: 1,
    test: 1,
  });
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "project.json")), false);
});

test("native Rust parser shadows the JavaScript Rust facts and reuses its SQLite cache", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-rust-facts-parity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "src/orders.rs", `use std::collections::HashMap;
use crate::service::validate;
use serde::Serialize;

struct Orders;
trait Persists { fn persist(&self); }
impl Orders { fn submit(&self, id: &str) { validate(id); } fn save(&self) {} }
fn validate(id: &str) { let _ = id; }
`);

  const graph = scanRepository(root);
  const orders = graph.nodes.find((node) => node.id === "symbol:src/orders.rs:class:Orders");
  const validate = graph.nodes.find((node) => node.id === "symbol:src/orders.rs:function:validate");
  assert.deepEqual(orders.methods, ["submit", "save"]);
  assert.ok(validate);

  const first = nativeRustFacts(root);
  const facts = first.facts["src/orders.rs"];
  assert.equal(first.mode, "native-rust-parser-shadow");
  assert.equal(first.parsedFiles, 1);
  assert.equal(first.failedFiles, 0);
  assert.equal(facts.parser, "syn");
  assert.equal(facts.status, "parsed");
  assert.deepEqual(facts.symbols.find((symbol) => symbol.name === "Orders").methods, orders.methods);
  assert.ok(facts.symbols.some((symbol) => symbol.name === "Persists" && symbol.methods.includes("persist")));
  assert.ok(facts.imports.some((item) => item.specifier === "crate::service::validate" && item.binding.local_name === "validate"));
  assert.ok(facts.imports.some((item) => item.specifier === "serde::Serialize" && item.binding.local_name === "Serialize"));
  assert.deepEqual(facts.calls, [{
    name: "validate",
    source_kind: "class",
    source_name: "Orders",
    imported: { specifier: "crate::service::validate", exported_name: "validate" },
  }]);

  const second = nativeRustFacts(root);
  assert.equal(second.parsedFiles, 0);
  assert.equal(second.reusedFiles, 1);
});
