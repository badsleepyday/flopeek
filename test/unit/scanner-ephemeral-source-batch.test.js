"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepositoryScanner } = require("../../src/scanner");

test("scanner consumes an ephemeral native source record without retaining its text", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-ephemeral-source-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "main.js"), "export function diskOnly() {}\n");

  const scanner = createRepositoryScanner(root, {
    persistIdentity: false,
    initialSourceContents: [{
      path: "src/main.js",
      utf8: "export function batchOne() {}\n",
      sizeBytes: fs.statSync(path.join(root, "src", "main.js")).size,
      modifiedAtNs: fs.statSync(path.join(root, "src", "main.js"), { bigint: true }).mtimeNs.toString(),
    }],
  });
  const graph = scanner.scan();
  const records = scanner.snapshotRecords();
  assert.deepEqual(scanner.sourceBatchStatus(), { provided: 1, used: 1, discarded: 0, pending: 0 });

  assert.ok(graph.nodes.some((node) => node.id === "symbol:src/main.js:function:batchOne"));
  assert.equal(graph.nodes.some((node) => node.id === "symbol:src/main.js:function:diskOnly"), false);
  assert.equal(Object.hasOwn(records[0], "utf8"), false, "record cache payloads must never retain ephemeral source text");
  assert.equal(JSON.stringify(records).includes("batchOne"), true, "only parser facts, never a source-body field, may remain");
  assert.equal(JSON.stringify(records).includes("export function batchOne"), false);
});

test("scanner discards a source batch when the file changed after inventory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-stale-source-batch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src", "main.js");
  fs.writeFileSync(file, "export function diskOnly() {}\n");
  const inventoryFingerprint = fs.statSync(file, { bigint: true });
  fs.writeFileSync(file, "export function currentOnDisk() {}\n");

  const scanner = createRepositoryScanner(root, {
    persistIdentity: false,
    initialSourceContents: [{
      path: "src/main.js",
      utf8: "export function batchOne() {}\n",
      sizeBytes: Number(inventoryFingerprint.size),
      modifiedAtNs: inventoryFingerprint.mtimeNs.toString(),
    }],
  });
  const graph = scanner.scan();

  assert.ok(graph.nodes.some((node) => node.id === "symbol:src/main.js:function:currentOnDisk"));
  assert.equal(graph.nodes.some((node) => node.id === "symbol:src/main.js:function:batchOne"), false);
  assert.deepEqual(scanner.sourceBatchStatus(), { provided: 1, used: 0, discarded: 1, pending: 0 });
});
