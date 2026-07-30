"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createNativeCoreClient } = require("../../src/native-core-client");
const { NativeProtocolClient } = require("../../src/native-protocol-client");
const { startServer } = require("../../src/server");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "typescript-order-flow");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");

test("native server retains a handle and explicitly materializes the broad HTTP compatibility surface", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-server-surface-"));
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (source) => path.basename(source) !== ".flopeek" });
  fs.mkdirSync(path.join(root, ".flopeek"), { recursive: true });
  const staleGraph = Buffer.from("{\"staleJavaScriptAuthority\":true}\n");
  fs.writeFileSync(path.join(root, ".flopeek", "graph.json"), staleGraph);
  const native = createNativeCoreClient({
    native: new NativeProtocolClient({
      command: "cargo",
      args: ["run", "--quiet", "--manifest-path", MANIFEST, "--"],
      cwd: ROOT,
      requestTimeoutMs: 120_000,
    }),
    sourceAuthority: "rust",
  });
  let refreshOptions = null;
  let materializationCount = 0;
  const observed = {
    ...native,
    refresh: (targetRoot, options) => {
      refreshOptions = { ...options };
      return native.refresh(targetRoot, options);
    },
    materializeGraph: async (graph) => {
      materializationCount += 1;
      return native.materializeGraph(graph);
    },
  };
  const app = await startServer({
    root,
    port: 0,
    cache: false,
    coreClient: observed,
    registerServeWorkspace: false,
  });
  t.after(async () => {
    await app.close();
    await native.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(refreshOptions.nativeGraphHandle, true);
  assert.equal(app.getGraphHandle().nodes, undefined);
  assert.ok(Array.isArray(app.getGraph().nodes));
  assert.equal(materializationCount, 1);
  const base = `http://127.0.0.1:${app.port}`;
  const graph = await (await fetch(`${base}/api/graph`)).json();
  assert.ok(graph.nodes.length > 0);
  const capabilities = await (await fetch(`${base}/api/capabilities`)).json();
  assert.equal(capabilities.cacheState.status, "disabled");
  const cache = await (await fetch(`${base}/api/cache`)).json();
  assert.equal(cache.status, "disabled");
  assert.deepEqual(fs.readFileSync(path.join(root, ".flopeek", "graph.json")), staleGraph);
  assert.equal(fs.existsSync(path.join(root, ".flopeek", "native-core.sqlite3")), false);

  fs.writeFileSync(path.join(root, "src", "new.service.ts"), "export class NewService {}\n");
  const refreshed = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(refreshed.status, 200);
  const delta = await (await fetch(`${base}/api/delta?fromVersion=1&toVersion=2`)).json();
  assert.equal(delta.schemaVersion, "flopeek-delta/v1");
  assert.equal(delta.fromGraphVersion, 1);
  assert.equal(delta.toGraphVersion, 2);
  assert.equal(app.getGraphHandle().nodes, undefined);
  assert.equal(materializationCount, 2);
  assert.deepEqual(fs.readFileSync(path.join(root, ".flopeek", "graph.json")), staleGraph);
});
