"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  loadDatabaseOpenEvidence,
  validateDatabaseOpenEvidence,
} = require("../../src/native-rollout-evidence");

function fixture() {
  return {
    schemaVersion: "flopeek-native-database-open-evidence/v1",
    platformPackage: "@flopeek/native-linux-x64-gnu",
    repositoryRevision: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    binarySha256: "c".repeat(64),
    operation: "open-current-graph",
    fullPayloadDeserialized: false,
    observations: {
      schemaVersion: "flopeek-native-database-open-observation/v1",
      sqliteOperations: ["current-complete-graph-metadata"],
      currentGraphFound: true,
      graphPayloadRowsRead: 0,
      graphPayloadBytesDeserialized: 0,
    },
  };
}

function bindings() {
  return {
    "@flopeek/native-linux-x64-gnu": {
      repositoryRevision: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      binarySha256: "c".repeat(64),
    },
  };
}

test("database-open evidence is byte-hashed and bound to exact metadata-only binary observations", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-db-evidence-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence.json");
  const bytes = Buffer.from(`${JSON.stringify(fixture(), null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  const loaded = loadDatabaseOpenEvidence(file, bindings());
  assert.deepEqual(loaded.evidence, fixture());
  assert.equal(loaded.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
});

test("database-open evidence rejects claims, payload reads, unknown fields, and different binaries", () => {
  assert.throws(
    () => validateDatabaseOpenEvidence({ databaseOpenDoesNotDeserializeFullGraph: true }, bindings()),
    /must contain exactly/,
  );
  assert.throws(
    () => validateDatabaseOpenEvidence({
      ...fixture(),
      observations: { ...fixture().observations, graphPayloadRowsRead: 1 },
    }, bindings()),
    /metadata-only/,
  );
  assert.throws(
    () => validateDatabaseOpenEvidence({ ...fixture(), comment: "trust me" }, bindings()),
    /must contain exactly/,
  );
  assert.throws(
    () => validateDatabaseOpenEvidence(fixture(), {
      ...bindings(),
      "@flopeek/native-linux-x64-gnu": {
        ...bindings()["@flopeek/native-linux-x64-gnu"],
        binarySha256: "d".repeat(64),
      },
    }),
    /exact release binary/,
  );
});
