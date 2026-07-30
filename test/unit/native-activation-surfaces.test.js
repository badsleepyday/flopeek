"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createSurfaceCoreRuntime, FLOPEEK_PACKAGE_ROOT } = require("../../src/core-runtime");
const { createMcpServer } = require("../../src/mcp");
const { startServer } = require("../../src/server");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "typescript-order-flow");

test("normal native activation reads rollout evidence from the Flopeek package, never the target repository", async () => {
  const runtime = createSurfaceCoreRuntime({
    coreMode: "native",
    root: FIXTURE,
  });
  assert.equal(FLOPEEK_PACKAGE_ROOT, ROOT);
  assert.equal(runtime.selection.requestedMode, "native");
  assert.equal(runtime.selection.selectedImplementation, "javascript");
  assert.equal(runtime.selection.fallback.reason, "native-rollout-gate-blocked");
  assert.deepEqual(runtime.selection.rolloutEvidence, {
    schemaVersion: "flopeek-native-rollout-evidence/v2",
    status: "incomplete",
    boundPackageVersion: "0.2.1-beta.4",
  });
  await runtime.core.close();
});

test("normal native MCP and server visibly fall back on an unrelated project root", async (t) => {
  const instance = await createMcpServer({
    root: FIXTURE,
    cache: false,
    coreMode: "native",
    deferInitialScan: true,
  });
  t.after(() => instance.close());
  const mcpScan = await instance.startInitialScan();
  assert.equal(mcpScan.scanOutcome.coreRuntime.requestedMode, "native");
  assert.equal(mcpScan.scanOutcome.coreRuntime.selectedImplementation, "javascript");
  assert.equal(mcpScan.scanOutcome.coreRuntime.fallback.reason, "native-rollout-gate-blocked");

  const app = await startServer({
    root: FIXTURE,
    port: 0,
    cache: false,
    coreMode: "native",
    registerServeWorkspace: false,
  });
  t.after(() => app.close());
  const serverOutcome = app.getScanOutcome();
  assert.equal(serverOutcome.coreRuntime.requestedMode, "native");
  assert.equal(serverOutcome.coreRuntime.selectedImplementation, "javascript");
  assert.equal(serverOutcome.coreRuntime.fallback.reason, "native-rollout-gate-blocked");
});

test("CLI transfers its one selected runtime into MCP and server ownership", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8");
  assert.match(source, /runMcpServer\(\{\s*\.\.\.options,\s*coreClient: ownedCore,\s*coreRuntime: coreRuntime\.selection,\s*ownsCoreClient: true,/u);
  assert.match(source, /startServer\(\{\s*\.\.\.options,\s*coreClient: ownedCore,\s*coreRuntime: coreRuntime\.selection,\s*ownsCoreClient: true,/u);
});
