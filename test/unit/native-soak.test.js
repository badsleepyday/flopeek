"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { validateSoakEvidence } = require("../../scripts/build-native-rollout-evidence");
const {
  EVENT_BLOCK,
  eventSchedule,
  plateauEvidence,
} = require("../../scripts/verify-native-soak");

test("soak schedule preserves the exact required 1000-event mix", () => {
  const schedule = eventSchedule(1000);
  assert.equal(schedule.length, 1000);
  assert.deepEqual(Object.fromEntries([...new Set(EVENT_BLOCK)]
    .map((event) => [event, schedule.filter((candidate) => candidate === event).length])), {
    "content-only-edit": 500,
    "symbol-addition": 150,
    "symbol-removal": 100,
    "file-add-delete": 100,
    rename: 50,
    "manifest-config-reconciliation": 50,
    "no-op": 50,
  });
  assert.throws(() => eventSchedule(999), /multiple of 100/);
});

test("RSS plateau proof accepts bounded noise and rejects linear growth", () => {
  const plateau = Array.from({ length: 1000 }, (_, index) => 100_000_000 + (index % 10) * 1024);
  assert.equal(plateauEvidence(plateau).plateau, true);
  const warmed = Array.from({ length: 1000 }, (_, index) => (
    index < 650 ? 100_000_000 : 150_000_000 + (index % 10) * 1024
  ));
  assert.equal(plateauEvidence(warmed).plateau, true);
  const growing = Array.from({ length: 1000 }, (_, index) => 100_000_000 + index * 100_000);
  assert.equal(plateauEvidence(growing).plateau, false);
  assert.throws(() => plateauEvidence([1, 2, 3]), /at least 600/);
});

test("rollout validation accepts only complete exact-mix raw soak evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-soak-validator-"));
  const file = path.join(root, "native-soak.json");
  const binarySha256 = "a".repeat(64);
  const counts = {
    "content-only-edit": 500,
    "symbol-addition": 150,
    "symbol-removal": 100,
    "file-add-delete": 100,
    rename: 50,
    "manifest-config-reconciliation": 50,
    "no-op": 50,
  };
  const mode = (name) => {
    let graphVersion = 1;
    const raw = eventSchedule(1000).map((event, index) => {
      if (event !== "no-op") graphVersion += 1;
      return {
        sequence: index + 1,
        event,
        changedPaths: event === "no-op" ? [] : ["src/index.ts"],
        graphVersion,
        compatibilityDigest: `sha256:${"b".repeat(64)}`,
        nodeRssBytes: 100,
        rustRssBytes: 50,
        combinedRssBytes: 150,
        sqlite: name === "persistent"
          ? { databaseBytes: 4096, walBytes: 0 }
          : { databaseBytes: 0, walBytes: 0 },
        sessionHistory: name === "cache-disabled"
          ? { limit: 8, retained: 8, expiredThroughVersion: null }
          : null,
      };
    });
    return {
      mode: name,
      events: 1000,
      eventCounts: counts,
      graphVersion,
      rssPlateau: {
        combined: { plateau: true },
        node: { plateau: true },
        rust: { plateau: true },
      },
      raw,
      assertions: {
        exactParityEveryEvent: true,
        staleEdgesObserved: false,
        dualAuthorityObserved: false,
        unhandledProcessDeath: false,
        boundedSessionHistory: true,
      },
    };
  };
  const evidence = {
    schemaVersion: "flopeek-native-soak-evidence/v1",
    binarySha256,
    modes: [mode("persistent"), mode("cache-disabled")],
    summary: { modes: 2, totalRefreshEvents: 2000, status: "passed" },
  };
  try {
    fs.writeFileSync(file, JSON.stringify(evidence));
    assert.equal(
      validateSoakEvidence(file, {
        "@flopeek/native-linux-x64-gnu": { binarySha256 },
      }).totalRefreshEvents,
      2000,
    );
    evidence.modes[0].raw[10].event = "no-op";
    fs.writeFileSync(file, JSON.stringify(evidence));
    assert.throws(
      () => validateSoakEvidence(file, {
        "@flopeek/native-linux-x64-gnu": { binarySha256 },
      }),
      /raw series is invalid/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
