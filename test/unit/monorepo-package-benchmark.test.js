"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanRepositoryBounded } = require("../../src/bounded-scan");

const ROOT = path.resolve(__dirname, "../..");
const BENCHMARK_FILE = path.join(ROOT, "benchmarks", "monorepo-package-selection.json");

test("monorepo package selection benchmark matches its pinned fixture and contract boundaries", async (t) => {
  assert.ok(fs.existsSync(BENCHMARK_FILE), "monorepo-package-selection.json must exist");
  const benchmark = JSON.parse(fs.readFileSync(BENCHMARK_FILE, "utf8"));
  assert.equal(benchmark.schemaVersion, "flopeek-monorepo-package-selection-benchmark/v1");

  const sourceFixturePath = path.join(ROOT, benchmark.fixture.path);
  assert.ok(fs.existsSync(sourceFixturePath), "fixture directory must exist");
  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-monorepo-package-benchmark-"));
  t.after(() => fs.rmSync(fixturePath, { recursive: true, force: true }));
  fs.cpSync(sourceFixturePath, fixturePath, {
    recursive: true,
    filter: (source) => ![".flopeek", ".flowpeek"].includes(path.basename(source)),
  });

  for (const pkg of benchmark.packageSelection.packages) {
    const result = await scanRepositoryBounded(fixturePath, {
      packagePath: pkg.path,
      persistIdentity: false,
    });
    assert.equal(result.status, "complete", `package ${pkg.name} scan must complete`);
    assert.equal(result.discovery.selection.status, "selected");
    assert.equal(result.discovery.selection.path, pkg.path);
    assert.equal(result.cachePromotion.allowed, false, "package-scoped scan must not allow cache promotion");
    assert.equal(result.graph.stats.scannedFiles, pkg.expectedScannedFiles, `${pkg.name} scanned file count mismatch`);
    assert.equal(fs.existsSync(path.join(fixturePath, ".flopeek")), false, "package scan must not leave cache on disk");
  }
});
