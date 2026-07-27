"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function text(result) {
  return result.content.find((item) => item.type === "text").text;
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await check();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for MCP startup state; last result: ${JSON.stringify(latest)}`);
}

test("stdio MCP exposes tools and unavailable readiness before its delayed initial scan completes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-mcp-startup-"));
  let client;
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mcp-startup-fixture" }), "utf8");
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export function ready() { return true; }\n", "utf8");
    const mcpPath = path.join(__dirname, "..", "..", "src", "mcp.js");
    const serverProgram = `require(process.argv[1]).runMcpServer({ root: process.argv[2], cache: false, maxFiles: 20, maxBytes: 1000000, timeBudgetMs: 30000, analysisDelayMs: 2000 }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });`;
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    client = new Client({ name: "flopeek-mcp-startup-client", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["-e", serverProgram, mcpPath, root],
      cwd: path.join(__dirname, "..", ".."),
      stderr: "pipe",
    }));

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_agent_bootstrap"));

    const before = JSON.parse(text(await client.callTool({ name: "get_agent_bootstrap", arguments: {} })));
    assert.equal(before.graph.status, "unavailable");
    assert.equal(before.scan.status, "running");

    await waitFor(async () => {
      const status = JSON.parse(text(await client.callTool({ name: "get_scan_status", arguments: {} })));
      return status.status === "complete" ? status : null;
    });
    const after = JSON.parse(text(await client.callTool({ name: "get_agent_bootstrap", arguments: {} })));
    assert.equal(after.readiness.graphAvailable, true);
    assert.equal(after.scan.status, "complete");
  } finally {
    if (client) await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
