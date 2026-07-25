"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef, resolveContextRef } = require("../../src/context-card");
const { DELTA_PRUNE_JOURNAL_SCHEMA, listGraphDeltaHistory, pruneGraphDeltas, recoverGraphDeltaPrune } = require("../../src/graph-state");

function writeDelta(root, from, payloadBytes = 128) {
  const target = path.join(root, ".flopeek", "deltas", `${from}-${from + 1}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: "flopeek-delta/v1", projectId: "project:retention", fromGraphVersion: from, toGraphVersion: from + 1, payload: "x".repeat(payloadBytes) }));
}

test("delta history uses deterministic version and byte retention with a dry-run-first prune", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-delta-retention-"));
  try {
    for (let version = 1; version <= 12; version += 1) writeDelta(root, version, 256);
    const malformed = path.join(root, ".flopeek", "deltas", "notes.json");
    fs.writeFileSync(malformed, "user-owned", "utf8");
    const before = listGraphDeltaHistory(root, { keepDeltas: 3, maxBytes: 10_000 });
    assert.equal(before.storage.files, 12);
    assert.equal(before.retained.length, 3);
    assert.equal(before.retained[0].toGraphVersion, 13);
    assert.equal(before.reclaimable.length, 9);
    assert.equal(before.unknownFiles.length, 1);
    const preview = pruneGraphDeltas(root, { keepDeltas: 3, maxBytes: 10_000 });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.pruned.length, 9);
    assert.equal(fs.existsSync(path.join(root, ".flopeek", "deltas", "1-2.json")), true);
    const applied = pruneGraphDeltas(root, { keepDeltas: 3, maxBytes: 10_000, dryRun: false });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.pruned.length, 9);
    assert.equal(fs.existsSync(path.join(root, ".flopeek", "deltas", "1-2.json")), false);
    assert.equal(fs.existsSync(path.join(root, ".flopeek", "deltas", "12-13.json")), true);
    assert.equal(fs.existsSync(malformed), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a missing old Context Ref is explicit as expired when retained delta history was pruned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-context-expiry-"));
  try {
    writeDelta(root, 5);
    const graph = { project: { projectId: "project:retention" }, state: { graphVersion: 6 }, nodes: [], flows: [] };
    const ref = createContextRef(graph.project.projectId, "node", "file:removed.ts", 1);
    const result = resolveContextRef(graph, ref, { deltaHistory: () => listGraphDeltaHistory(root), readDelta: () => null });
    assert.equal(result.status, "expired");
    assert.equal(result.code, "history-pruned");
    assert.equal(result.retention.oldestRetainedFrom, 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("delta prune recovery rolls back an interrupted staging journal and completes a committed journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-delta-recovery-"));
  try {
    writeDelta(root, 1);
    const deltas = path.join(root, ".flopeek", "deltas");
    const staging = path.join(deltas, ".prune-staging");
    const journal = path.join(deltas, ".prune-journal.json");
    fs.mkdirSync(staging);
    fs.renameSync(path.join(deltas, "1-2.json"), path.join(staging, "1-2.json"));
    fs.writeFileSync(journal, JSON.stringify({ schemaVersion: DELTA_PRUNE_JOURNAL_SCHEMA, status: "prepared", files: ["1-2.json"] }));
    assert.equal(recoverGraphDeltaPrune(root).status, "rolled-back");
    assert.equal(fs.existsSync(path.join(deltas, "1-2.json")), true);

    fs.mkdirSync(staging);
    fs.renameSync(path.join(deltas, "1-2.json"), path.join(staging, "1-2.json"));
    fs.writeFileSync(journal, JSON.stringify({ schemaVersion: DELTA_PRUNE_JOURNAL_SCHEMA, status: "committed", files: ["1-2.json"] }));
    assert.equal(recoverGraphDeltaPrune(root).status, "completed");
    assert.equal(fs.existsSync(path.join(deltas, "1-2.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
