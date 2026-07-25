"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { getActiveBranchGitEvidence, getFlowContextCard } = require("../../src/graph-service");
const { createMcpServer } = require("../../src/mcp");
const { scanRepository, writeGraphCache } = require("../../src/scanner");
const { startServer } = require("../../src/server");

function git(root, args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim(); }
function write(root, relative, content) { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, "utf8"); }
function commit(root, subject) { git(root, ["add", "."]); git(root, ["commit", "-m", subject]); }

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-active-branch-evidence-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "flowpeek@example.invalid"]);
  git(root, ["config", "user.name", "Flowpeek test"]);
  write(root, ".gitignore", ".flowpeek/\n");
  write(root, "package.json", JSON.stringify({ name: "active-branch-evidence" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { status: 'initial' }; }\n");
  commit(root, "add orders endpoint");
  return root;
}

test("active-branch Git evidence is bounded to Context Card paths and reachable local commits", () => {
  const root = repository();
  try {
    const before = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, before, { reason: "active-branch-evidence-baseline" });
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { status: 'changed' }; }\n");
    commit(root, "change orders endpoint");
    const current = scanRepository(root, { persistIdentity: true });
    const currentCard = getFlowContextCard(current, current.flows[0].id).card;
    const statusBefore = git(root, ["status", "--porcelain"]);
    const evidence = getActiveBranchGitEvidence(current, currentCard.contextRef, { limit: 1 });
    assert.equal(evidence.schemaVersion, "flowpeek-active-branch-git-evidence/v1");
    assert.equal(evidence.status, "available");
    assert.equal(evidence.context.resolutionStatus, "current");
    assert.deepEqual(evidence.context.paths, ["src/app/api/orders/route.ts"]);
    assert.equal(evidence.paths[0].commits.length, 1);
    assert.equal(evidence.paths[0].commits[0].subject, "change orders endpoint");
    assert.equal(evidence.paths[0].truncated, true);
    assert.equal(Object.hasOwn(evidence.paths[0].commits[0], "author"), false);
    assert.equal(JSON.stringify(evidence).includes("export async function"), false);
    assert.equal(git(root, ["status", "--porcelain"]), statusBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("active-branch Git evidence abstains for unavailable Context Cards, detached HEAD, and non-Git repositories", () => {
  const root = repository();
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-active-branch-evidence-non-git-"));
  try {
    const graph = scanRepository(root, { persistIdentity: true });
    const ref = getFlowContextCard(graph, graph.flows[0].id).card.contextRef;
    const unresolved = getActiveBranchGitEvidence(graph, "not-a-context-ref");
    assert.equal(unresolved.status, "unavailable");
    assert.match(unresolved.reason, /does not resolve/);
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "--detach", head]);
    const detached = getActiveBranchGitEvidence(graph, ref);
    assert.equal(detached.status, "unavailable");
    assert.match(detached.reason, /detached/);
    write(nonGit, "package.json", JSON.stringify({ name: "non-git" }));
    write(nonGit, "src/app/api/orders/route.ts", "export async function GET() { return {}; }\n");
    const nonGitGraph = scanRepository(nonGit, { persistIdentity: true });
    const nonGitRef = getFlowContextCard(nonGitGraph, nonGitGraph.flows[0].id).card.contextRef;
    const unavailable = getActiveBranchGitEvidence(nonGitGraph, nonGitRef);
    assert.equal(unavailable.status, "unavailable");
    assert.match(unavailable.reason, /not an available local Git work tree/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
});

test("cache-enabled CLI promotes the complete graph before classifying an earlier Context Ref", () => {
  const root = repository();
  try {
    const baseline = scanRepository(root, { persistIdentity: true });
    writeGraphCache(root, baseline, { reason: "active-branch-evidence-cli-baseline" });
    const baselineVersion = baseline.state.graphVersion;
    const earlierRef = getFlowContextCard(baseline, baseline.flows[0].id).card.contextRef;
    write(root, "src/app/api/orders/route.ts", "export async function GET() { return { status: 'changed' }; }\n");
    commit(root, "change orders endpoint");
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const result = JSON.parse(execFileSync(process.execPath, [cli, "git-evidence", root, "--context-ref", earlierRef, "--format", "json"], { encoding: "utf8" }));
    assert.equal(result.status, "available");
    assert.equal(result.context.resolutionStatus, "stale");
    assert.ok(result.project.graphVersion > baselineVersion);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("HTTP, MCP, and CLI expose the same bounded active-branch Git evidence contract", async () => {
  const root = repository();
  let app;
  let instance;
  let client;
  try {
    const graph = scanRepository(root, { persistIdentity: true });
    const contextRef = getFlowContextCard(graph, graph.flows[0].id).card.contextRef;
    app = await startServer({ root, port: 0, registerServeWorkspace: false });
    const http = await (await fetch(`http://127.0.0.1:${app.port}/api/active-branch-git-evidence?contextRef=${encodeURIComponent(contextRef)}&limit=2`)).json();
    assert.equal(http.status, "available");
    instance = await createMcpServer({ root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "active-branch-evidence-test", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "get_active_branch_git_evidence"));
    const result = await client.callTool({ name: "get_active_branch_git_evidence", arguments: { contextRef, limit: 2 } });
    assert.equal(result.isError, undefined);
    const mcp = JSON.parse(result.content.find((item) => item.type === "text").text);
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const command = JSON.parse(execFileSync(process.execPath, [cli, "git-evidence", root, "--context-ref", contextRef, "--limit", "2", "--format", "json"], { encoding: "utf8" }));
    for (const payload of [mcp, command]) {
      assert.equal(payload.schemaVersion, http.schemaVersion);
      assert.equal(payload.status, http.status);
      assert.deepEqual(payload.context.paths, http.context.paths);
      assert.deepEqual(payload.paths, http.paths);
      assert.equal(payload.branch.headRevision, http.branch.headRevision);
    }
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
