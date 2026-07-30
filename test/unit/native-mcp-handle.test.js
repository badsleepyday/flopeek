"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMcpServer } = require("../../src/mcp");
const { createNativeCoreClient } = require("../../src/native-core-client");
const { NativeProtocolClient } = require("../../src/native-protocol-client");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");

test("MCP keeps the primary native graph handle-only in Node", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-mcp-handle-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const native = createNativeCoreClient({
    native: new NativeProtocolClient({
      command: "cargo",
      args: ["run", "--quiet", "--manifest-path", MANIFEST, "--"],
      cwd: ROOT,
      requestTimeoutMs: 120_000,
    }),
    sourceAuthority: "rust",
  });
  t.after(async () => {
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let receivedOptions = null;
  const observed = {
    ...native,
    refresh: (targetRoot, options) => {
      receivedOptions = { ...options };
      return native.refresh(targetRoot, options);
    },
  };
  const instance = await createMcpServer({ root, cache: true, coreClient: observed });
  const graph = instance.coordinator.currentGraph();
  assert.equal(receivedOptions.nativeGraphHandle, true);
  assert.equal(graph.analysis.graphState.transport, "handle-only");
  assert.equal(Object.hasOwn(graph, "nodes"), false);
  assert.equal(Object.hasOwn(graph, "edges"), false);
  assert.equal(Object.hasOwn(graph, "flows"), false);
  const overview = await native.getProjectOverview(graph, { mode: "overview", scope: "application" });
  assert.ok(overview.display.catalog.nodes.total > 0);
});
