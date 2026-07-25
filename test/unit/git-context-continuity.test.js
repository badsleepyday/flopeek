"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { getFlowContextCard, getGitContextContinuity } = require("../../src/graph-service");
const { createMcpServer } = require("../../src/mcp");
const { scanRepository } = require("../../src/scanner");
const { startServer } = require("../../src/server");

function git(root, args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim(); }
function write(root, relative, content) { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, "utf8"); }
function commit(root, subject) { git(root, ["add", "."]); git(root, ["commit", "-m", subject]); }

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-git-context-continuity-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "flopeek@example.invalid"]);
  git(root, ["config", "user.name", "Flopeek test"]);
  write(root, ".gitignore", ".flopeek/\n");
  write(root, "package.json", JSON.stringify({ name: "git-context-continuity" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { status: 'initial' }; }\n");
  commit(root, "add orders endpoint");
  const before = git(root, ["rev-parse", "HEAD"]);
  write(root, "src/app/api/orders/route.ts", "export async function POST() { return { status: 'changed' }; }\n");
  commit(root, "change orders endpoint");
  return { root, before, after: git(root, ["rev-parse", "HEAD"]) };
}

test("Git Context continuity distinguishes exact static flow identity from same-path candidates", () => {
  const fixture = repository();
  try {
    const graph = scanRepository(fixture.root, { persistIdentity: true });
    const card = getFlowContextCard(graph, graph.flows[0].id).card;
    const statusBefore = git(fixture.root, ["status", "--porcelain"]);
    const result = getGitContextContinuity(graph, card.contextRef, { from: fixture.before, to: fixture.after });
    assert.equal(result.schemaVersion, "flopeek-git-context-continuity/v1");
    assert.equal(result.status, "available");
    assert.equal(result.context.kind, "flow");
    assert.deepEqual(result.context.paths, ["src/app/api/orders/route.ts"]);
    assert.equal(result.snapshots.before.match.status, "exact-static-flow-absent");
    assert.equal(result.snapshots.after.match.status, "exact-static-flow-present-same-steps");
    assert.ok(result.snapshots.before.match.pathCandidates[0].candidates.length > 0);
    assert.equal(JSON.stringify(result).includes("export async function"), false);
    assert.equal(git(fixture.root, ["status", "--porcelain"]), statusBefore);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("Git Context continuity abstains instead of guessing for unavailable Context Cards or snapshots", () => {
  const fixture = repository();
  try {
    const graph = scanRepository(fixture.root, { persistIdentity: true });
    const unresolved = getGitContextContinuity(graph, "not-a-context-ref", { from: fixture.before, to: fixture.after });
    assert.equal(unresolved.status, "unavailable");
    assert.match(unresolved.reason, /does not resolve/);
    const card = getFlowContextCard(graph, graph.flows[0].id).card;
    const missing = getGitContextContinuity(graph, card.contextRef, { from: "missing-ref", to: fixture.after });
    assert.equal(missing.status, "unavailable");
    assert.match(missing.reason, /snapshots could not be created/);
    assert.equal(missing.snapshots.before, null);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("HTTP, MCP, and CLI expose the same Git Context continuity projection", async () => {
  const fixture = repository();
  let app;
  let instance;
  let client;
  try {
    const graph = scanRepository(fixture.root, { persistIdentity: true });
    const contextRef = getFlowContextCard(graph, graph.flows[0].id).card.contextRef;
    app = await startServer({ root: fixture.root, port: 0, registerServeWorkspace: false });
    const http = await (await fetch(`http://127.0.0.1:${app.port}/api/git-context-continuity?contextRef=${encodeURIComponent(contextRef)}&from=${fixture.before}&to=${fixture.after}`)).json();
    assert.equal(http.status, "available");
    instance = await createMcpServer({ root: fixture.root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "git-context-continuity-test", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_git_context_continuity"));
    const result = await client.callTool({ name: "get_git_context_continuity", arguments: { contextRef, from: fixture.before, to: fixture.after } });
    assert.equal(result.isError, undefined);
    const mcp = JSON.parse(result.content.find((item) => item.type === "text").text);
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const command = JSON.parse(execFileSync(process.execPath, [cli, "git-continuity", fixture.root, "--context-ref", contextRef, "--from", fixture.before, "--to", fixture.after, "--format", "json"], { encoding: "utf8" }));
    for (const payload of [mcp, command]) {
      assert.equal(payload.schemaVersion, http.schemaVersion);
      assert.equal(payload.status, http.status);
      assert.deepEqual(payload.context, http.context);
      assert.deepEqual(payload.snapshots.before.match, http.snapshots.before.match);
      assert.deepEqual(payload.snapshots.after.match, http.snapshots.after.match);
      assert.equal(payload.snapshots.before.commit.revision, http.snapshots.before.commit.revision);
      assert.equal(payload.snapshots.after.commit.revision, http.snapshots.after.commit.revision);
    }
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
