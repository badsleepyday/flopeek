"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMcpServer } = require("../../src/mcp");
const { startServer } = require("../../src/server");

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function payload(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

test("HTTP and MCP expose the same read-only cache hygiene projection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-cache-hygiene-surfaces-"));
  let app;
  let client;
  let instance;
  try {
    write(root, "package.json", JSON.stringify({ name: "cache-hygiene-surfaces" }));
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n");
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const http = await (await fetch(`http://127.0.0.1:${app.port}/api/cache-hygiene`)).json();
    instance = await createMcpServer({ root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "cache-hygiene-surfaces", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const mcp = payload(await client.callTool({ name: "get_cache_hygiene", arguments: {} }));
    assert.equal(http.schemaVersion, "flopeek-cache-hygiene/v1");
    assert.equal(mcp.schemaVersion, http.schemaVersion);
    assert.deepEqual(mcp.retention, http.retention);
    assert.deepEqual(mcp.projectIdentity, http.projectIdentity);
    assert.equal(JSON.stringify(http).includes(root), false);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
