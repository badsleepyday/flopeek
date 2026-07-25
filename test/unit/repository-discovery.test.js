"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { RepositoryDiscoveryError, discoverRepository, verifyAnalysisPlan } = require("../../src/repository-discovery");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "apps", "api", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "core", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "workspace", workspaces: ["apps/*", "packages/*"] }));
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  fs.writeFileSync(path.join(root, "apps", "api", "package.json"), JSON.stringify({ name: "@fixture/api" }));
  fs.writeFileSync(path.join(root, "packages", "core", "package.json"), JSON.stringify({ name: "@fixture/core" }));
  fs.writeFileSync(path.join(root, "apps", "api", "src", "route.ts"), "export function route() {}\n");
  fs.writeFileSync(path.join(root, "packages", "core", "src", "core.py"), "def core():\n    return True\n");
  fs.writeFileSync(path.join(root, "node_modules", "ignored", "hidden.ts"), "export const hidden = true;\n");
  return root;
}

test("repository discovery reports deterministic adapters, packages, scope, and scan readiness", (t) => {
  const root = fixture(t);
  const result = discoverRepository(root);
  assert.equal(result.schemaVersion, "flowpeek-repository-discovery/v1");
  assert.equal(result.status, "complete");
  assert.equal(result.decision.safeToStartFullScan, true);
  assert.equal(result.inventory.candidateFiles, 2);
  assert.deepEqual(result.adapters.map((adapter) => [adapter.id, adapter.files]), [["python", 1], ["typescript", 1]]);
  assert.deepEqual(result.workspace.packages.map((item) => item.name), ["workspace", "@fixture/api", "@fixture/core"]);
  assert.equal(result.workspace.packages[0].scope, "project-control");
  assert.ok(result.workspace.manifests.some((item) => item.kind === "pnpm-workspace"));
  assert.equal(result.workspace.manifests.some((item) => item.path.includes("node_modules")), false);
});

test("package-scoped discovery selects one local static package subtree and preserves its resolver controls", (t) => {
  const root = fixture(t);
  const result = discoverRepository(root, { packagePath: "apps/api", includeAnalysisPlan: true });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.selection, {
    kind: "static-package-path",
    status: "selected",
    requestedPath: "apps/api",
    path: "apps/api",
    manifest: "apps/api/package.json",
    packageName: "@fixture/api",
    limitations: [
      "The selected package path is a bounded static source subtree, not proof of workspace membership, dependency ownership, build activation, or runtime topology.",
      "Scoped scans use a session-only graph identity and do not replace the repository-wide graph cache.",
    ],
  });
  assert.equal(result.inventory.candidateFiles, 1);
  assert.deepEqual(result.workspace.packages.map((item) => item.name), ["@fixture/api"]);
  assert.deepEqual(result.analysisPlan.directories, ["apps/api", "apps/api/src"]);
  assert.deepEqual(result.analysisPlan.controlDirectories, [".", "apps", "apps/api"]);
  assert.equal(result.analysisPlan.selection.path, "apps/api");
  assert.equal(Object.isFrozen(result.analysisPlan.selection), true);

  fs.writeFileSync(path.join(root, "packages", "core", "src", "later.py"), "def later():\n    return True\n");
  assert.equal(verifyAnalysisPlan(root, result.analysisPlan).valid, true);

  fs.writeFileSync(path.join(root, "apps", "api", "src", "later.ts"), "export const later = true;\n");
  const packageChange = verifyAnalysisPlan(root, result.analysisPlan);
  assert.equal(packageChange.valid, false);
  assert.equal(packageChange.reason, "source-inventory-changed");
});

test("package-scoped discovery rejects parent traversal and paths without a local package manifest", (t) => {
  const root = fixture(t);
  assert.throws(() => discoverRepository(root, { packagePath: "../outside" }), (error) => error instanceof RepositoryDiscoveryError && error.code === "invalid-package-path");
  assert.throws(() => discoverRepository(root, { packagePath: "apps/../packages/core" }), (error) => error instanceof RepositoryDiscoveryError && error.code === "invalid-package-path");
  assert.throws(() => discoverRepository(root, { packagePath: "apps" }), (error) => error instanceof RepositoryDiscoveryError && error.code === "package-not-found");
});

test("package selection remains subject to the repository-owned static source scope", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".flowpeek"));
  fs.writeFileSync(path.join(root, ".flowpeek", "config.json"), JSON.stringify({
    schemaVersion: 1,
    sourceRoots: ["apps/api"],
    testRoots: [],
    fixtureRoots: [],
    exclude: [],
    flowEntries: { tests: false, fixtures: false },
  }));
  const result = discoverRepository(root, { packagePath: "packages/core" });
  assert.equal(result.selection.path, "packages/core");
  assert.equal(result.inventory.candidateFiles, 0);
  assert.equal(result.scope.counts.excluded, 1);
});

test("package-scoped immutable plans reject selected-package and ancestor resolver-control mutations", (t) => {
  const root = fixture(t);
  const selectedPlan = discoverRepository(root, { packagePath: "apps/api", includeAnalysisPlan: true }).analysisPlan;
  const selectedPackagePath = path.join(root, "apps", "api", "package.json");
  const selectedPackage = JSON.parse(fs.readFileSync(selectedPackagePath, "utf8"));
  selectedPackage.version = "1.0.1";
  fs.writeFileSync(selectedPackagePath, JSON.stringify(selectedPackage));
  const selectedMutation = verifyAnalysisPlan(root, selectedPlan);
  assert.equal(selectedMutation.valid, false);
  assert.equal(selectedMutation.reason, "source-inventory-changed");

  const ancestorPlan = discoverRepository(root, { packagePath: "apps/api", includeAnalysisPlan: true }).analysisPlan;
  const rootPackagePath = path.join(root, "package.json");
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  rootPackage.imports = { "#api": "./apps/api/src/route.ts" };
  fs.writeFileSync(rootPackagePath, JSON.stringify(rootPackage));
  const ancestorMutation = verifyAnalysisPlan(root, ancestorPlan);
  assert.equal(ancestorMutation.valid, false);
  assert.equal(ancestorMutation.reason, "source-inventory-changed");
});

test("repository discovery refuses a full scan when declared file or byte bounds are exceeded", (t) => {
  const root = fixture(t);
  const result = discoverRepository(root, { maxFiles: 1, maxBytes: 1 });
  assert.equal(result.status, "bounded");
  assert.equal(result.inventory.complete, true);
  assert.equal(result.decision.safeToStartFullScan, false);
  assert.deepEqual(result.reasons, ["file-limit-exceeded", "byte-limit-exceeded"]);
  assert.equal(result.inventory.candidateFiles, 2);
});

test("repository discovery emits a stable internal analysis plan and changes its fingerprint when source inventory changes", (t) => {
  const root = fixture(t);
  const first = discoverRepository(root, { includeAnalysisPlan: true });
  const repeated = discoverRepository(root, { includeAnalysisPlan: true });
  assert.equal(first.inventory.fingerprint, repeated.inventory.fingerprint);
  assert.equal(first.analysisPlan.files.length, first.inventory.candidateFiles);
  assert.equal(Object.isFrozen(first.analysisPlan), true);
  assert.equal(Object.isFrozen(first.analysisPlan.files), true);
  assert.equal(Object.isFrozen(first.analysisPlan.files[0]), true);
  assert.equal(Object.keys(first).includes("analysisPlan"), false);

  fs.writeFileSync(path.join(root, "apps", "api", "src", "later.ts"), "export const later = true;\n");
  const changed = discoverRepository(root, { includeAnalysisPlan: true });
  assert.notEqual(changed.inventory.fingerprint, first.inventory.fingerprint);
});

test("shared-plan verification detects source and directory changes without re-running repository discovery", (t) => {
  const root = fixture(t);
  const discovery = discoverRepository(root, { includeAnalysisPlan: true });
  const unchanged = verifyAnalysisPlan(root, discovery.analysisPlan);
  assert.equal(unchanged.schemaVersion, "flowpeek-analysis-plan-verification/v1");
  assert.equal(unchanged.valid, true);
  assert.equal(unchanged.actualFingerprint, discovery.inventory.fingerprint);

  fs.writeFileSync(path.join(root, "apps", "api", "src", "late.ts"), "export const late = true;\n");
  const sourceChanged = verifyAnalysisPlan(root, discovery.analysisPlan);
  assert.equal(sourceChanged.valid, false);
  assert.equal(sourceChanged.reason, "source-inventory-changed");

  fs.rmSync(path.join(root, "apps", "api", "src", "late.ts"));
  fs.mkdirSync(path.join(root, "apps", "api", "new-source"));
  const directoryChanged = verifyAnalysisPlan(root, discovery.analysisPlan);
  assert.equal(directoryChanged.valid, false);
  assert.equal(directoryChanged.reason, "source-directory-added");
});

test("shared-plan verification ignores non-source, non-control edits", (t) => {
  const root = fixture(t);
  const discovery = discoverRepository(root, { includeAnalysisPlan: true });
  fs.writeFileSync(path.join(root, "apps", "api", "README.md"), "Operational notes.\n");
  const verification = verifyAnalysisPlan(root, discovery.analysisPlan);
  assert.equal(verification.valid, true);
  assert.equal(verification.actualFingerprint, discovery.inventory.fingerprint);
});

test("shared-plan verification rejects resolver-control edits", (t) => {
  const root = fixture(t);
  const discovery = discoverRepository(root, { includeAnalysisPlan: true });
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.imports = { "#core": "./packages/core/src/core.py" };
  fs.writeFileSync(packagePath, JSON.stringify(packageJson));
  const verification = verifyAnalysisPlan(root, discovery.analysisPlan);
  assert.equal(verification.valid, false);
  assert.equal(verification.reason, "source-inventory-changed");
});

test("repository discovery fingerprint changes when resolver control files change", (t) => {
  const root = fixture(t);
  const first = discoverRepository(root, { includeAnalysisPlan: true });
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.imports = { "#core": "./packages/core/src/core.py" };
  fs.writeFileSync(packagePath, JSON.stringify(packageJson));
  const changed = discoverRepository(root, { includeAnalysisPlan: true });
  assert.ok(first.inventory.controlFiles >= 4);
  assert.notEqual(changed.inventory.fingerprint, first.inventory.fingerprint);
});

test("repository discovery accepts an exact file and byte limit", (t) => {
  const root = fixture(t);
  const baseline = discoverRepository(root);
  const exact = discoverRepository(root, {
    maxFiles: baseline.inventory.candidateFiles,
    maxBytes: baseline.inventory.candidateBytes,
  });
  assert.equal(exact.status, "complete");
  assert.equal(exact.decision.safeToStartFullScan, true);
});

test("repository discovery exposes deterministic time-budget truncation", (t) => {
  const root = fixture(t);
  let tick = 0;
  const result = discoverRepository(root, { timeBudgetMs: 3, now: () => tick++ });
  assert.equal(result.status, "bounded");
  assert.equal(result.inventory.complete, false);
  assert.ok(result.reasons.includes("time-budget-exceeded"));
  assert.equal(result.decision.safeToStartFullScan, false);
});

test("repository discovery validates all resource limits", (t) => {
  const root = fixture(t);
  for (const options of [{ maxFiles: 0 }, { maxBytes: -1 }, { timeBudgetMs: 1.5 }]) {
    assert.throws(() => discoverRepository(root, options), (error) => error instanceof RepositoryDiscoveryError && error.code === "invalid-limit");
  }
});

test("discover CLI reports bounded preflight without writing Flowpeek metadata", (t) => {
  const root = fixture(t);
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "discover", root, "--max-files", "1", "--format", "json"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "bounded");
  assert.equal(report.decision.safeToStartFullScan, false);
  assert.equal(fs.existsSync(path.join(root, ".flowpeek")), false);
});

test("discover CLI summary makes package overlap with total manifests explicit", (t) => {
  const root = fixture(t);
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "discover", root, "--format", "summary"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 packages \/ 4 total manifests \(package manifests included\)/);
});

test("discover CLI reports the selected static package boundary", (t) => {
  const root = fixture(t);
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "discover", root, "--package", "apps/api", "--format", "json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.selection.status, "selected");
  assert.equal(report.selection.path, "apps/api");
  assert.equal(report.inventory.candidateFiles, 1);
});

test("discover CLI preserves invalid package-path errors", (t) => {
  const root = fixture(t);
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  const result = spawnSync(process.execPath, [cli, "discover", root, "--package", "../outside"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packagePath must not contain parent-directory traversal/);
});
