"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { resolveContextRef } = require("../../src/graph-service");
const { createScanCoordinator } = require("../../src/scan-coordinator");
const { scanRepository, writeGraphCache } = require("../../src/scanner");

const SOURCE = path.join(__dirname, "..", "fixtures", "typescript-order-flow");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-scan-coordinator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(SOURCE, root, { recursive: true });
  return root;
}

function changeService(root) {
  const relativePath = "src/orders/orders.service.ts";
  fs.appendFileSync(path.join(root, ...relativePath.split("/")), "\nexport const coordinatorMarker = true;\n");
  return relativePath;
}

function addScopedPackages(root) {
  fs.mkdirSync(path.join(root, "apps", "api", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "core", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "api", "package.json"), JSON.stringify({ name: "@coordinator/api" }));
  fs.writeFileSync(path.join(root, "packages", "core", "package.json"), JSON.stringify({ name: "@coordinator/core" }));
  fs.writeFileSync(path.join(root, "apps", "api", "src", "route.ts"), "export function route() { return true; }\n");
  fs.writeFileSync(path.join(root, "packages", "core", "src", "core.ts"), "export function core() { return true; }\n");
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitInitialRepository(root) {
  git(root, ["init"]);
  git(root, ["config", "user.email", "flowpeek-test@example.invalid"]);
  git(root, ["config", "user.name", "Flowpeek Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
}

test("bounded cache-disabled coordinator preserves one session identity and advances stale Context Refs", async (t) => {
  const root = fixture(t);
  const phases = [];
  const progressEvents = [];
  const coordinator = createScanCoordinator(root, {
    cache: false,
    maxFiles: 20,
    maxBytes: 1_000_000,
    timeBudgetMs: 30_000,
    onProgress: (event) => {
      phases.push(event.phase);
      progressEvents.push(event);
    },
  });
  const first = await coordinator.refresh(null, "initial");
  assert.equal(first.outcome.schemaVersion, "flowpeek-scan-outcome/v1");
  assert.equal(first.outcome.status, "complete");
  assert.equal(first.graph.state.graphVersion, 1);
  const node = first.graph.nodes.find((candidate) => candidate.label === "Orders Service");
  const firstRef = createContextRef(first.graph.project.projectId, "node", node.id, first.graph.state.graphVersion);

  const changedPath = changeService(root);
  const second = await coordinator.refresh([changedPath], "filesystem");
  assert.equal(second.outcome.status, "complete");
  assert.equal(second.graph.project.projectId, first.graph.project.projectId);
  assert.equal(second.graph.state.graphVersion, 2);
  assert.equal(resolveContextRef(second.graph, firstRef).status, "stale");
  assert.ok(phases.includes("discovery-started"));
  assert.ok(phases.includes("analysis-started"));
  assert.equal(phases.filter((phase) => phase === "terminal").length, 2);
  assert.equal(progressEvents.some((event) => event.phase === "terminal" && event.outcome.status === "running"), false);
  assert.equal(fs.existsSync(path.join(root, ".flowpeek")), false);
});

test("package-scoped coordinator always uses an ephemeral bounded session and exposes the selected subtree", async (t) => {
  const root = fixture(t);
  addScopedPackages(root);
  const durable = scanRepository(root);
  writeGraphCache(root, durable, { reason: "package-scope-durable-baseline" });
  const cachePath = path.join(root, ".flowpeek", "graph.json");
  const cacheBefore = fs.readFileSync(cachePath);
  const coordinator = createScanCoordinator(root, { cache: true, packagePath: "apps/api" });
  const result = await coordinator.refresh(null, "package-initial");
  assert.equal(coordinator.bounded, true);
  assert.equal(coordinator.cacheEnabled, false);
  assert.equal(result.outcome.mode, "bounded-full-analysis");
  assert.equal(result.outcome.bounds.packagePath, "apps/api");
  assert.equal(result.outcome.discovery.selection.status, "selected");
  assert.equal(result.outcome.discovery.selection.path, "apps/api");
  assert.equal(result.outcome.cachePromotion.allowed, false);
  assert.equal(result.graph.analysis.cacheState.status, "disabled");
  assert.equal(result.graph.analysis.cacheState.reason, "package-scoped-session");
  assert.equal(result.graph.analysis.packageSelection.path, "apps/api");
  assert.match(result.graph.project.projectId, /^session:/);
  assert.notEqual(result.graph.project.projectId, durable.project.projectId);
  assert.equal(result.graph.nodes.some((node) => node.path === "packages/core/src/core.ts"), false);
  assert.deepEqual(fs.readFileSync(cachePath), cacheBefore);
});

test("bounded coordinator serves the last complete cache without promoting an incomplete result", async (t) => {
  const root = fixture(t);
  const baseline = scanRepository(root);
  writeGraphCache(root, baseline, { reason: "coordinator-baseline" });
  const cachePath = path.join(root, ".flowpeek", "graph.json");
  const cacheBefore = fs.readFileSync(cachePath);

  const coordinator = createScanCoordinator(root, { cache: true, maxFiles: 1 });
  const result = await coordinator.refresh(null, "initial");
  assert.equal(result.outcome.status, "partial-by-budget");
  assert.equal(result.outcome.activeGraph.source, "last-complete-cache");
  assert.equal(result.outcome.activeGraph.freshness, "stale-unverified");
  assert.equal(result.outcome.cachePromotion.performed, false);
  assert.equal(result.graph.state.graphVersion, 1);
  assert.deepEqual(fs.readFileSync(cachePath), cacheBefore);
});

test("scan outcome separates scoped source freshness from attached Git HEAD freshness", async (t) => {
  const root = fixture(t);
  commitInitialRepository(root);
  const baseline = scanRepository(root);
  writeGraphCache(root, baseline, { reason: "freshness-baseline" });
  fs.writeFileSync(path.join(root, "README.md"), "outside the configured source scope\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "docs-only-head-change"]);

  const completeCoordinator = createScanCoordinator(root, { cache: false });
  const complete = await completeCoordinator.refresh(null, "complete-after-docs-commit");
  assert.equal(complete.outcome.status, "complete");
  assert.equal(complete.graph.state.sourceFingerprint, baseline.state.sourceFingerprint);
  assert.notEqual(complete.graph.state.sourceRevision, baseline.state.sourceRevision);
  assert.equal(complete.outcome.activeGraph.scopedSourceFreshness.status, "current");
  assert.equal(complete.outcome.activeGraph.attachedHeadFreshness.status, "matched");

  const coordinator = createScanCoordinator(root, { cache: true, maxFiles: 1 });
  const result = await coordinator.refresh(null, "bounded-after-docs-commit");
  assert.equal(result.outcome.status, "partial-by-budget");
  assert.equal(result.outcome.activeGraph.freshness, "stale-unverified");
  assert.equal(result.outcome.activeGraph.scopedSourceFreshness.status, "stale-unverified");
  assert.equal(result.outcome.activeGraph.attachedHeadFreshness.status, "mismatched");
  assert.notEqual(result.outcome.activeGraph.attachedHeadFreshness.scannedRevision, result.outcome.activeGraph.attachedHeadFreshness.attachedHeadRevision);
});

test("bounded coordinator rejects a cached fallback from an obsolete configured project identity", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".flowpeek"), { recursive: true });
  fs.writeFileSync(path.join(root, ".flowpeek", "config.json"), JSON.stringify({
    schemaVersion: 1,
    projectId: "project:alpha",
  }));
  const baseline = scanRepository(root);
  writeGraphCache(root, baseline, { reason: "project-alpha-baseline" });
  fs.writeFileSync(path.join(root, ".flowpeek", "config.json"), JSON.stringify({
    schemaVersion: 1,
    projectId: "project:bravo",
  }));

  const coordinator = createScanCoordinator(root, { cache: true, maxFiles: 1 });
  const result = await coordinator.refresh(null, "identity-change");
  assert.equal(result.outcome.status, "partial-by-budget");
  assert.equal(result.graph, null);
  assert.equal(result.outcome.activeGraph.available, false);
  assert.equal(result.outcome.activeGraph.source, "none");
  assert.equal(result.outcome.activeGraph.freshness, "unavailable");
});

test("unbounded coordinator exposes the same terminal outcome around incremental scanner reuse", async (t) => {
  const root = fixture(t);
  const coordinator = createScanCoordinator(root, { cache: false });
  const first = await coordinator.refresh(null, "initial");
  const changedPath = changeService(root);
  const second = await coordinator.refresh([changedPath], "filesystem");
  assert.equal(first.outcome.mode, "incremental-session");
  assert.equal(second.outcome.mode, "incremental-session");
  assert.equal(second.outcome.refresh.mode, "incremental");
  assert.equal(second.graph.analysis.refresh.analyzedFiles, 1);
  assert.equal(second.outcome.activeGraph.graphVersion, 2);
});

test("bounded coordinator publishes queryable running state and accepts cancellation without a graph", async (t) => {
  const root = fixture(t);
  for (let index = 0; index < 80; index += 1) {
    fs.writeFileSync(path.join(root, `generated-${index}.ts`), `export function generated${index}() { return ${index}; }\n`);
  }
  let runningOutcome = null;
  let cancellation = null;
  let concurrentRefresh = null;
  let coordinator;
  coordinator = createScanCoordinator(root, {
    cache: false,
    maxFiles: 200,
    maxBytes: 5_000_000,
    timeBudgetMs: 30_000,
    onProgress: ({ phase }) => {
      if (phase !== "analysis-started" || cancellation) return;
      runningOutcome = coordinator.currentOutcome();
      concurrentRefresh = coordinator.refresh(null, "concurrent").then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
      cancellation = coordinator.cancel();
    },
  });
  const result = await coordinator.refresh(null, "cancel-test");
  assert.equal(runningOutcome.status, "running");
  assert.equal(runningOutcome.progress.phase, "analysis-started");
  assert.equal((await concurrentRefresh).error?.code, "FLOWPEEK_SCAN_IN_PROGRESS");
  assert.equal(cancellation.accepted, true);
  assert.equal(result.outcome.status, "cancelled");
  assert.equal(result.outcome.cachePromotion.performed, false);
  assert.equal(result.graph, null);
  assert.equal(coordinator.isRunning(), false);
});
