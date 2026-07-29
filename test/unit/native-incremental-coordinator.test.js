"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCoreCompatibilityProjection } = require("../../src/core-compatibility");
const { scanWithNativeIncremental, selectNativeBinary } = require("../../src/native-incremental-coordinator");
const { scanRepository } = require("../../src/scanner");

const ROOT = path.join(__dirname, "..", "..");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");
const NATIVE = { command: "cargo", args: ["run", "--quiet", "--manifest-path", MANIFEST, "--"] };

test("native binary selection prefers explicit configuration, then release, then debug", () => {
  const allAvailable = () => true;
  assert.deepEqual(
    selectNativeBinary({ configured: "C:/custom/flopeek.exe", release: "C:/release.exe", debug: "C:/debug.exe" }, allAvailable),
    { command: "C:/custom/flopeek.exe", args: [] },
  );
  assert.deepEqual(
    selectNativeBinary({ configured: "", release: "C:/release.exe", debug: "C:/debug.exe" }, allAvailable),
    { command: "C:/release.exe", args: [] },
  );
  assert.deepEqual(
    selectNativeBinary({ configured: "", release: "C:/release.exe", debug: "C:/debug.exe" }, (candidate) => candidate.endsWith("debug.exe")),
    { command: "C:/debug.exe", args: [] },
  );
});

function copiedFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-incremental-"));
  fs.cpSync(path.join(ROOT, "test", "fixtures", name), root, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".flopeek",
  });
  return root;
}

test("native incremental coordinator reuses cross-process JS facts through one persistent native session", async (t) => {
  const root = copiedFixture("legacy-handoff");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const jsFirst = scanRepository(root);
  const first = await scanWithNativeIncremental(root, { native: NATIVE });
  assert.deepEqual(createCoreCompatibilityProjection(first.graph), createCoreCompatibilityProjection(jsFirst));
  assert.equal(first.native.manifest.changedFiles, jsFirst.stats.scannedFiles);
  assert.equal(first.native.manifest.ephemeralSourceRecords, jsFirst.stats.scannedFiles);
  assert.equal(first.native.manifest.ephemeralSourceOmittedFiles, 0);
  assert.equal(first.native.manifest.ephemeralSourceUsedRecords, jsFirst.stats.scannedFiles);
  assert.equal(first.native.manifest.ephemeralSourceDiscardedRecords, 0);
  assert.equal(first.native.loadedRecords, 0);
  assert.equal(first.native.profile.transport, "persistent-jsonl");
  assert.equal(first.native.profile.protocolRequests, 3);
  assert.ok(first.native.profile.nativeSessionStartMs >= 0);
  assert.ok(first.native.profile.nativeSessionCloseMs >= 0);

  const jsUnchanged = scanRepository(root);
  const unchanged = await scanWithNativeIncremental(root, { native: NATIVE });
  assert.deepEqual(createCoreCompatibilityProjection(unchanged.graph), createCoreCompatibilityProjection(jsUnchanged));
  assert.equal(unchanged.native.manifest.changedFiles, 0);
  assert.equal(unchanged.native.manifest.ephemeralSourceRecords, 0);
  assert.equal(unchanged.native.manifest.ephemeralSourceUsedRecords, 0);
  assert.equal(unchanged.native.loadedRecords, jsUnchanged.stats.scannedFiles);
  assert.equal(unchanged.native.storedRecords, 0);
  assert.equal(unchanged.native.profile.protocolRequests, 2);

  const changedPath = jsUnchanged.nodes.find((node) => node.kind === "file").path;
  fs.appendFileSync(path.join(root, changedPath), "\n");
  const jsChanged = scanRepository(root);
  const changed = await scanWithNativeIncremental(root, { native: NATIVE });
  assert.deepEqual(createCoreCompatibilityProjection(changed.graph), createCoreCompatibilityProjection(jsChanged));
  assert.equal(changed.native.manifest.changedFiles, 1);
  assert.equal(changed.native.manifest.ephemeralSourceRecords, 1);
  assert.equal(changed.native.manifest.ephemeralSourceUsedRecords, 1);
  assert.equal(changed.native.loadedRecords, jsChanged.stats.scannedFiles - 1);
  assert.equal(changed.native.storedRecords, 1);
  assert.equal(changed.native.profile.protocolRequests, 3);
});

test("caller-owned native session stays open for multiple incremental scans", async (t) => {
  const root = copiedFixture("legacy-handoff");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createNativeIncrementalSession } = require("../../src/native-incremental-coordinator");
  const session = createNativeIncrementalSession(NATIVE);
  t.after(() => session.close());
  const first = await scanWithNativeIncremental(root, { session });
  const second = await scanWithNativeIncremental(root, { session });
  assert.equal(first.native.profile.sessionScope, "caller");
  assert.equal(first.native.profile.sessionReused, false);
  assert.equal(first.native.profile.nativeSessionCloseMs, null);
  assert.equal(second.native.profile.sessionScope, "caller");
  assert.equal(second.native.profile.sessionReused, true);
  assert.equal(second.native.profile.nativeSessionCloseMs, null);
});
