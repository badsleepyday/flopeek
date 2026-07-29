"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCoreCompatibilityDigest } = require("../../src/core-compatibility");
const { createPublicGraphEnvelope, createRepositoryScanner, structuralEntryFacts } = require("../../src/scanner");

const ROOT = path.join(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "typescript-order-flow");

test("scanner prepares parser facts before public graph assembly without changing the graph contract", () => {
  const profile = [];
  const scanner = createRepositoryScanner(FIXTURE, {
    persistIdentity: false,
    onProfile: (entry) => profile.push(entry),
  });
  const prepared = scanner.prepare();
  assert.equal(profile.some((entry) => entry.phase === "graph-assembly"), false);
  assert.ok(prepared.sourceRecords.length > 0);
  assert.equal(prepared.sourceRecords.every((record) => typeof record.sourceHash === "string" && !Object.hasOwn(record, "content")), true);
  assert.deepEqual(
    prepared.sourceRecords.map((record) => record.relativePath),
    scanner.snapshotRecords().map((record) => record.relativePath),
  );

  const graph = scanner.assemble(prepared);
  const direct = createRepositoryScanner(FIXTURE, { persistIdentity: false }).scan();
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(direct));
  assert.equal(profile.filter((entry) => entry.phase === "graph-assembly").length, 1);
});

test("prepared public envelope is topology-free and produces the JavaScript graph contract", () => {
  const scanner = createRepositoryScanner(FIXTURE, { persistIdentity: false });
  const prepared = scanner.prepare();
  const envelope = createPublicGraphEnvelope(prepared, structuralEntryFacts(prepared.root, prepared.sourceRecords));
  assert.equal(Object.hasOwn(envelope, "nodes"), false);
  assert.equal(Object.hasOwn(envelope, "edges"), false);
  assert.equal(Object.hasOwn(envelope, "flows"), false);
  const graph = scanner.assemble(prepared, envelope);
  const direct = createRepositoryScanner(FIXTURE, { persistIdentity: false }).scan();
  assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(direct));
});

test("Go source-body edits reuse resolver context while Go topology edits invalidate it", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-go-context-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/context\n\ngo 1.23\n");
  fs.writeFileSync(path.join(root, "main.go"), [
    "package main",
    "",
    "func main() { value() }",
    "func value() {}",
    "",
  ].join("\n"));
  const scanner = createRepositoryScanner(root, { persistIdentity: false });
  const initial = scanner.prepare();
  fs.writeFileSync(path.join(root, "main.go"), [
    "package main",
    "",
    "func main() { value(); value() }",
    "func value() {}",
    "",
  ].join("\n"));
  const bodyEdit = scanner.prepare(["main.go"]);
  assert.strictEqual(bodyEdit.graphContext, initial.graphContext);
  assert.equal(bodyEdit.refresh.analyzedFiles, 1);

  fs.writeFileSync(path.join(root, "extra.go"), "package main\nfunc extra() {}\n");
  const added = scanner.prepare(["extra.go"]);
  assert.notStrictEqual(added.graphContext, bodyEdit.graphContext);

  fs.rmSync(path.join(root, "extra.go"));
  const removed = scanner.prepare(["extra.go"]);
  assert.notStrictEqual(removed.graphContext, added.graphContext);
});
