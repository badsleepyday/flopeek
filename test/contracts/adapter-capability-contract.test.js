const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanRepository } = require("../../src/scanner");
const { projectView } = require("../../src/graph-service");
const { startServer } = require("../../src/server");

test("graph, agent context, and capability API expose the same adapter registry identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-capabilities-"));
  let app;
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "capabilities" }));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export const main = () => true;");
    const graph = scanRepository(root);
    const context = projectView(graph).aiContext;
    assert.deepEqual(context.adapterCapabilities, graph.analysis.adapterCapabilities);
    app = await startServer({ root, port: 0 });
    const response = await fetch(`http://127.0.0.1:${app.port}/api/capabilities`);
    assert.equal(response.status, 200);
    const api = await response.json();
    assert.deepEqual(api.adapterCapabilities, graph.analysis.adapterCapabilities);
    assert.equal(api.adapterCapabilities.schema, "flopeek-adapter-capabilities/v2");
    const csharp = api.adapterCapabilities.adapters.find((adapter) => adapter.id === "csharp");
    assert.equal(csharp.parser, "csharp-roslyn");
    assert.equal(csharp.requiredToolchain, ".NET SDK");
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
