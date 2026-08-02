"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { sameCanonicalFile, sourceFingerprint, writeCleanRoomReport } = require("../../src/clean-room-package");

const ROOT = path.resolve(__dirname, "..", "..");

test("clean-room native identity accepts filesystem aliases only when their canonical file matches", () => {
  const realpathSync = () => { throw new Error("generic realpath must not be used"); };
  realpathSync.native = (candidate) => {
    if (candidate === "/var/folders/native") return "/private/var/folders/native";
    return candidate;
  };
  const fileSystem = { realpathSync };

  assert.equal(sameCanonicalFile("/private/var/folders/native", "/var/folders/native", fileSystem), true);
  assert.equal(sameCanonicalFile("/private/var/folders/native", "/var/folders/other", fileSystem), false);
});

test("source fingerprint ignores Flopeek cache while detecting source changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-clean-room-fingerprint-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "feature.ts"), "export const feature = true;\n");
    const before = sourceFingerprint(root);
    fs.mkdirSync(path.join(root, ".flopeek"), { recursive: true });
    fs.writeFileSync(path.join(root, ".flopeek", "graph.json"), "{}\n");
    assert.deepEqual(sourceFingerprint(root), before);
    fs.writeFileSync(path.join(root, "src", "feature.ts"), "export const feature = false;\n");
    assert.notEqual(sourceFingerprint(root).value, before.value);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("clean-room evidence writes atomically outside the package artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-clean-room-report-"));
  try {
    const file = path.join(root, "evidence", "report.json");
    const report = { schemaVersion: "flopeek-clean-room-package-report/v1", status: "passed" };
    assert.equal(writeCleanRoomReport(file, report), file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), report);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("checked clean-room evidence preserves package, source, cleanup, and publication boundaries", () => {
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, "packaging", "evidence", "clean-room-current.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "schemas", "flopeek-clean-room-package-report.schema.json"), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, "flopeek-clean-room-package-report/v1");
  assert.equal(report.schemaVersion, "flopeek-clean-room-package-report/v1");
  assert.equal(report.status, "passed");
  assert.equal(report.packageAudit.status, "passed");
  assert.equal(report.packageAudit.package.private, false);
  assert.equal(report.packageAudit.policy.publicationState, "prepared");
  assert.equal(report.packageAudit.policy.distTag, "beta");
  assert.equal(report.environment.lifecycleScriptsDuringInstall, false);
  assert.equal(report.smoke.version.matched, true);
  assert.ok(report.smoke.scan.applicationFlows > 0);
  assert.equal(report.smoke.scan.cacheStatus, "disabled");
  assert.equal(report.smoke.mcp.connected, true);
  assert.equal(report.smoke.mcp.sourceWrites, "not-exposed");
  assert.equal(report.smoke.mcp.targetExecution, "not-exposed");
  assert.equal(report.smoke.targetFixture.unchanged, true);
  assert.equal(report.smoke.targetFixture.applicationExecuted, false);
  assert.equal(report.cleanup.status, "passed");
  assert.deepEqual(report.publication, { attempted: false, approved: false });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(ROOT), false);
  assert.equal(serialized.includes(os.tmpdir()), false);
  assert.equal(serialized.includes("export async function"), false);
});
