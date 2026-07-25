"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { scanRepositoryBounded } = require("../../src/bounded-scan");
const { discoverRepository } = require("../../src/repository-discovery");
const { scanRepository, writeGraphCache } = require("../../src/scanner");

function fixture(t, files = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-bounded-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bounded-scan-fixture" }));
  fs.mkdirSync(path.join(root, "src"));
  for (let index = 0; index < files; index += 1) fs.writeFileSync(path.join(root, "src", `file-${index}.js`), `export function value${index}() { return ${index}; }\n`);
  return root;
}

function packageFixture(t) {
  const root = fixture(t, 0);
  fs.mkdirSync(path.join(root, "apps", "api", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "core", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "api", "package.json"), JSON.stringify({ name: "@bounded/api" }));
  fs.writeFileSync(path.join(root, "packages", "core", "package.json"), JSON.stringify({ name: "@bounded/core" }));
  fs.writeFileSync(path.join(root, "apps", "api", "src", "route.js"), "export function route() { return true; }\n");
  fs.writeFileSync(path.join(root, "packages", "core", "src", "core.js"), "export function core() { return true; }\n");
  return root;
}

test("bounded scan returns a complete graph only after successful preflight and worker analysis", async (t) => {
  const root = fixture(t);
  const result = await scanRepositoryBounded(root, { maxFiles: 10, maxBytes: 100_000, persistIdentity: false });
  assert.equal(result.schemaVersion, "flopeek-bounded-scan-result/v1");
  assert.equal(result.status, "complete");
  assert.equal(result.cachePromotion.allowed, true);
  assert.equal(result.graph.project.name, "bounded-scan-fixture");
  assert.equal(result.graph.stats.scannedFiles, 2);
  assert.match(result.discovery.inventory.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.verification.schemaVersion, "flopeek-analysis-plan-verification/v1");
  assert.equal(result.verification.valid, true);
});

test("package-scoped bounded scan emits only the selected static subtree with explicit selection evidence", async (t) => {
  const root = packageFixture(t);
  const progress = [];
  const result = await scanRepositoryBounded(root, {
    packagePath: "apps/api",
    onProgress(event) { progress.push(event); },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.cachePromotion.allowed, false);
  assert.equal(result.discovery.selection.status, "selected");
  assert.equal(result.discovery.selection.path, "apps/api");
  assert.equal(result.graph.analysis.packageSelection.path, "apps/api");
  assert.match(result.graph.project.projectId, /^session:/);
  assert.equal(result.graph.stats.scannedFiles, 1);
  assert.equal(result.graph.nodes.some((node) => node.path === "packages/core/src/core.js"), false);
  assert.ok(progress.some((event) => event.phase === "discovery-completed" && event.discovery.selection.path === "apps/api"));
  assert.ok(progress.some((event) => event.phase === "analysis-started" && event.selection.path === "apps/api"));
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("package-scoped bounded scan discards the graph when a selected package resolver control changes", async (t) => {
  const root = packageFixture(t);
  let changed = false;
  const result = await scanRepositoryBounded(root, {
    packagePath: "apps/api",
    onProgress(event) {
      if (event.phase !== "analysis-started" || changed) return;
      changed = true;
      const packagePath = path.join(root, "apps", "api", "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      packageJson.version = "1.0.1";
      fs.writeFileSync(packagePath, JSON.stringify(packageJson));
    },
  });
  assert.equal(changed, true);
  assert.equal(result.status, "failed");
  assert.equal(result.graph, null);
  assert.equal(result.cachePromotion.allowed, false);
  assert.equal(result.failure.code, "repository-changed-during-analysis");
  assert.equal(result.failure.verification.reason, "source-inventory-changed");
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("bounded scan discards a planned graph when the source set changes after discovery", async (t) => {
  const root = fixture(t);
  let changed = false;
  const result = await scanRepositoryBounded(root, {
    maxFiles: 10,
    persistIdentity: false,
    onProgress(event) {
      if (event.phase !== "analysis-started" || changed) return;
      changed = true;
      fs.writeFileSync(path.join(root, "src", "late.js"), "export const late = true;\n");
    },
  });
  assert.equal(changed, true);
  assert.equal(result.status, "failed");
  assert.equal(result.graph, null);
  assert.equal(result.cachePromotion.allowed, false);
  assert.equal(result.failure.code, "repository-changed-during-analysis");
  assert.equal(result.failure.verification.valid, false);
  assert.equal(result.failure.verification.reason, "source-inventory-changed");
});

test("a discovery plan fixes the analyzed source set and later inventory changes invalidate its fingerprint", (t) => {
  const root = fixture(t, 2);
  const discovery = discoverRepository(root, { includeAnalysisPlan: true });
  fs.writeFileSync(path.join(root, "src", "late.js"), "export const late = true;\n");
  const plannedGraph = scanRepository(root, {
    persistIdentity: false,
    initialFilePlan: discovery.analysisPlan.files,
  });
  const current = discoverRepository(root, { includeAnalysisPlan: true });
  assert.equal(plannedGraph.stats.scannedFiles, 2);
  assert.notEqual(current.analysisPlan.fingerprint, discovery.analysisPlan.fingerprint);
});

test("scanner rejects discovery-plan paths outside the repository", (t) => {
  const root = fixture(t, 1);
  assert.throws(() => scanRepository(root, {
    persistIdentity: false,
    initialFilePlan: [{ path: "../outside.js" }],
  }), /repository-relative source paths/);
});

test("bounded scan reports an explicit diagnostic result and no graph when discovery exceeds limits", async (t) => {
  const root = fixture(t, 3);
  const result = await scanRepositoryBounded(root, { maxFiles: 2, persistIdentity: false });
  assert.equal(result.status, "partial-by-budget");
  assert.equal(result.graph, null);
  assert.equal(result.cachePromotion.allowed, false);
  assert.match(result.reason, /file-limit-exceeded/);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});

test("bounded scan cancellation cannot produce or promote a graph", async (t) => {
  const root = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await scanRepositoryBounded(root, { signal: controller.signal, persistIdentity: false });
  assert.equal(result.status, "cancelled");
  assert.equal(result.graph, null);
  assert.equal(result.cachePromotion.allowed, false);
});

test("bounded failure leaves the previous complete cache byte-for-byte unchanged", async (t) => {
  const root = fixture(t, 3);
  const graph = scanRepository(root);
  writeGraphCache(root, graph, { reason: "bounded-scan-test-baseline" });
  const cachePath = path.join(root, ".flopeek", "graph.json");
  const before = fs.readFileSync(cachePath);
  const result = await scanRepositoryBounded(root, { maxFiles: 1 });
  assert.equal(result.status, "partial-by-budget");
  assert.deepEqual(fs.readFileSync(cachePath), before);
});

test("bounded scan CLI returns a versioned envelope and never writes a partial cache", (t) => {
  const root = fixture(t, 3);
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "scan", root, "--max-files", "1", "--format", "json"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, "flopeek-bounded-scan-result/v1");
  assert.equal(report.status, "partial-by-budget");
  assert.equal(report.graph, null);
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "graph.json")), false);
});

test("package-scoped scan CLI keeps the repository-wide cache untouched", (t) => {
  const root = packageFixture(t);
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "scan", root, "--package", "apps/api", "--format", "json"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "complete");
  assert.equal(report.cachePromotion.allowed, false);
  assert.equal(report.discovery.selection.path, "apps/api");
  assert.equal(report.graph.analysis.cacheState.reason, "package-scoped-session");
  assert.equal(report.graph.stats.scannedFiles, 1);
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
  const summary = spawnSync(process.execPath, [cli, "scan", root, "--package", "apps/api"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Static package scope: apps\/api/);
  assert.match(summary.stdout, /Cache: not written \(package-scoped session\)/);
});

test("bounded no-cache CLI promotes only the complete in-memory result", (t) => {
  const root = fixture(t, 2);
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "scan", root, "--max-files", "10", "--no-cache", "--format", "json"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "complete");
  assert.equal(report.graph.stats.scannedFiles, 2);
  assert.equal(report.graph.analysis.cacheState.status, "disabled");
  assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
});
