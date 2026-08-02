"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyInstalledContextRef } = require("../../scripts/verify-native-candidate-install");

const ROOT = path.resolve(__dirname, "..", "..");

test("candidate install Context Ref proof queries and resolves the native authority", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-install-context-"));
  try {
    fs.writeFileSync(
      path.join(fixture, "index.ts"),
      "export function candidateInstall() { return true; }\n",
    );
    const proof = await verifyInstalledContextRef(ROOT, fixture, {
      coreMode: "native-experimental",
    });
    assert.match(proof.contextRef, /^fp:\/\//u);
    assert.equal(proof.resolutionStatus, "current");
    assert.equal(fs.existsSync(path.join(fixture, ".flopeek", "native-core.sqlite3")), true);
    assert.equal(fs.existsSync(path.join(fixture, ".flopeek", "graph.json")), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("candidate install Context Ref proof fails closed when the expected node is absent", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-install-context-missing-"));
  try {
    fs.writeFileSync(path.join(fixture, "other.ts"), "export const other = true;\n");
    await assert.rejects(
      verifyInstalledContextRef(ROOT, fixture, { coreMode: "native-experimental" }),
      (error) => error?.code === "candidate-context-ref-missing",
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
