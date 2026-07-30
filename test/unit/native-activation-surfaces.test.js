"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createSurfaceCoreRuntime, createVerifiedNativeProtocolClient, FLOPEEK_PACKAGE_ROOT } = require("../../src/core-runtime");
const { createMcpServer } = require("../../src/mcp");
const { startServer } = require("../../src/server");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
const bundledPacket = () => JSON.parse(fs.readFileSync(path.join(ROOT, "packaging", "native-rollout-evidence.json"), "utf8"));
const expectedBundledFallback = () => bundledPacket().status === "complete"
  ? "native-public-core-unavailable"
  : "native-rollout-gate-blocked";

test("normal native activation reads rollout evidence from the Flopeek package, never the target repository", async () => {
  const runtime = createSurfaceCoreRuntime({
    coreMode: "native",
    root: FIXTURE,
  });
  assert.equal(FLOPEEK_PACKAGE_ROOT, ROOT);
  assert.equal(runtime.selection.requestedMode, "native");
  assert.equal(runtime.selection.selectedImplementation, "javascript");
  assert.equal(runtime.selection.fallback.reason, expectedBundledFallback());
  assert.deepEqual(runtime.selection.rolloutEvidence, {
    schemaVersion: "flopeek-native-rollout-evidence/v2",
    status: bundledPacket().status,
    boundPackageVersion: "0.2.1-beta.4",
  });
  await runtime.core.close();
});

test("normal native surface cannot bypass the bundled packet with an injected core", async () => {
  const injected = {
    implementation: "native-experimental",
    close: async () => {},
  };
  const runtime = createSurfaceCoreRuntime({
    coreMode: "native",
    enableNativeCore: true,
    nativeCore: injected,
  });
  assert.notEqual(runtime.core, injected);
  assert.equal(runtime.selection.selectedImplementation, "javascript");
  assert.equal(runtime.selection.fallback.reason, expectedBundledFallback());
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
  assert.equal(mcpScan.scanOutcome.coreRuntime.fallback.reason, expectedBundledFallback());

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
  assert.equal(serverOutcome.coreRuntime.fallback.reason, expectedBundledFallback());
});

test("CLI transfers its one selected runtime into MCP and server ownership", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8");
  assert.match(source, /runMcpServer\(\{\s*\.\.\.options,\s*coreClient: ownedCore,\s*coreRuntime: coreRuntime\.selection,\s*ownsCoreClient: true,/u);
  assert.match(source, /startServer\(\{\s*\.\.\.options,\s*coreClient: ownedCore,\s*coreRuntime: coreRuntime\.selection,\s*ownsCoreClient: true,/u);
});

test("rollout-approved protocol execution ignores FLOPEEK_NATIVE_CORE and pins the verified binary", () => {
  const previous = process.env.FLOPEEK_NATIVE_CORE;
  process.env.FLOPEEK_NATIVE_CORE = "binary-B-unverified";
  const constructed = [];
  class ProtocolProbe {
    constructor(options) {
      constructed.push(options);
      Object.assign(this, options);
    }
  }
  try {
    const client = createVerifiedNativeProtocolClient({
      available: true,
      binary: "binary-A-verified",
    }, ROOT, ProtocolProbe);
    assert.equal(client.command, "binary-A-verified");
    assert.deepEqual(client.args, []);
    assert.equal(client.cwd, ROOT);
    assert.equal(constructed.length, 1);
    assert.equal(constructed[0].command, "binary-A-verified");
  } finally {
    if (previous === undefined) delete process.env.FLOPEEK_NATIVE_CORE;
    else process.env.FLOPEEK_NATIVE_CORE = previous;
  }
});

test("rollout-approved protocol execution fails closed without a verified binary", () => {
  assert.throws(
    () => createVerifiedNativeProtocolClient({ available: false, binary: "binary-B" }, ROOT),
    /exact verified binary path/,
  );
  assert.throws(
    () => createVerifiedNativeProtocolClient({ available: true, binary: null }, ROOT),
    /exact verified binary path/,
  );
});
