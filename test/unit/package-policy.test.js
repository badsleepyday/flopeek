"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { auditPackageFiles, loadPackagePolicy, runPackageAudit } = require("../../src/package-policy");

const ROOT = path.resolve(__dirname, "..", "..");
const POLICY = loadPackagePolicy(path.join(ROOT, "packaging", "package-policy.json"));
const PACKAGE = require("../../package.json");

function result(paths) {
  return { name: "flopeek", version: PACKAGE.version, filename: `flopeek-${PACKAGE.version}.tgz`, size: 100, unpackedSize: 1000, files: paths.map((item) => ({ path: item, size: 1, mode: 420 })) };
}

test("package policy accepts only the bounded runtime artifact", () => {
  const report = auditPackageFiles(result(POLICY.requiredPaths), POLICY, PACKAGE);
  assert.equal(report.status, "passed");
  assert.equal(report.checks.allowlist, true);
  assert.equal(report.checks.releaseBoundary, true);
  assert.equal(report.policy.releasePublishingApproved, false);
  assert.equal(report.policy.publicationState, "prepared");
  assert.equal(report.policy.distTag, "beta");
});

test("package policy rejects repository governance, cache, secrets, maps, omissions, and release drift", () => {
  const unsafe = result([...POLICY.requiredPaths.filter((item) => item !== "src/mcp.js"), ".github/workflows/ci.yml", ".flopeek/graph.json", "benchmarks/private-provider-cohort.json", "src/.env.production", "src/secrets.local.json", "src/private.pem", "public/app.js.map"]);
  const publishable = { ...PACKAGE, private: true };
  const report = auditPackageFiles(unsafe, POLICY, publishable);
  assert.equal(report.status, "failed");
  assert.ok(report.errors.some((item) => item.code === "outside-allowlist"));
  assert.ok(report.errors.find((item) => item.code === "outside-allowlist").paths.includes("benchmarks/private-provider-cohort.json"));
  assert.ok(report.errors.some((item) => item.code === "denied-segment"));
  assert.ok(report.errors.some((item) => item.code === "denied-basename-prefix"));
  assert.ok(report.errors.some((item) => item.code === "denied-suffix"));
  assert.ok(report.errors.some((item) => item.code === "missing-required-path"));
  assert.ok(report.errors.some((item) => item.code === "release-publication-metadata"));
});

test("npm publication requires an explicit matching owner approval", () => {
  const { assertNpmPublicationApproved, loadNpmPublicationApproval } = require("../../src/npm-publication-approval");
  const approval = loadNpmPublicationApproval(path.join(ROOT, "packaging", "npm-publication-approval.json"));
  assert.equal(approval.status, "approved");
  assert.equal(approval.packageName, PACKAGE.name);
  assert.equal(approval.version, PACKAGE.version);
  assert.equal(approval.distTag, PACKAGE.publishConfig.tag);
  assert.deepEqual(assertNpmPublicationApproved(ROOT), approval);
});

test("current npm dry-run package passes the committed allowlist", () => {
  const { report } = runPackageAudit(ROOT, { dryRun: true });
  assert.equal(report.status, "passed", JSON.stringify(report.errors));
  assert.ok(report.package.entries <= POLICY.maximumEntries);
  assert.equal(report.checks.requiredRuntime, true);
});

test("CLI exposes the installed package version without scanning a repository", () => {
  for (const argument of ["--version", "version", "-v"]) {
    const command = spawnSync(process.execPath, [path.join(ROOT, "src", "cli.js"), argument], { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout.trim(), PACKAGE.version);
  }
});
