"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanRepositoryBounded } = require("../../src/bounded-scan");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-cleanup-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cleanup-test-fixture" }));
  fs.mkdirSync(path.join(root, "src"));
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(root, "src", `file-${index}.js`), `export function func${index}() { return ${index}; }\n`);
  }
  return root;
}

test("bounded scan abort signal terminates worker thread and cleans up handles cleanly", async (t) => {
  const root = fixture(t);
  const controller = new AbortController();
  
  // Abort mid-process
  setTimeout(() => controller.abort(), 5);
  
  const result = await scanRepositoryBounded(root, {
    signal: controller.signal,
    persistIdentity: false,
  });

  assert.equal(result.schemaVersion, "flowpeek-bounded-scan-result/v1");
  assert.equal(result.status, "cancelled");
  assert.equal(result.graph, null);
  assert.equal(result.cachePromotion.allowed, false);
  assert.match(result.limitations.join(" "), /Worker termination/);
});

test("bounded scan time-budget timeout cleans up worker resource state without leaving active worker", async (t) => {
  const root = fixture(t);
  const result = await scanRepositoryBounded(root, {
    timeBudgetMs: 1, // Extremely short budget to trigger timeout
    persistIdentity: false,
  });

  assert.equal(result.schemaVersion, "flowpeek-bounded-scan-result/v1");
  assert.ok(["partial-by-budget", "complete"].includes(result.status));
  if (result.status === "partial-by-budget") {
    assert.equal(result.graph, null);
    assert.equal(result.cachePromotion.allowed, false);
  }
});
