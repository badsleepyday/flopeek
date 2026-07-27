const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AGENT_BOOTSTRAP_SCHEMA, createAgentBootstrap } = require("../../src/agent-bootstrap");
const { scanRepository } = require("../../src/scanner");

test("agent bootstrap exposes a bounded evidence workflow without source contents or absolute roots", () => {
  const root = path.resolve(__dirname, "..", "fixtures", "typescript-order-flow");
  const graph = scanRepository(root, { persistIdentity: false });
  const bootstrap = createAgentBootstrap(graph);
  const serialized = JSON.stringify(bootstrap);

  assert.equal(bootstrap.schemaVersion, AGENT_BOOTSTRAP_SCHEMA);
  assert.equal(bootstrap.policy.strategy, "graph-first-with-source-fallback");
  assert.equal(bootstrap.policy.staticIsRuntimeTruth, false);
  assert.equal(bootstrap.policy.agentProposalCreatesParserFact, false);
  assert.ok(bootstrap.workflow.some((step) => step.tools.includes("refresh_graph")));
  assert.ok(bootstrap.workflow.some((step) => step.tools.includes("get_scan_status")));
  assert.ok(bootstrap.workflow.some((step) => step.tools.includes("get_handoff_context")));
  assert.ok(bootstrap.workflow.some((step) => step.tools.includes("get_work_dependency_status")));
  assert.ok(bootstrap.graph.inventory.applicationFlows > 0);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("export class"), false);
});

test("agent bootstrap explicitly requires source fallback when no application flow is available", () => {
  const graph = {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    project: { projectId: "fixture", name: "fixture", git: {} },
    state: { graphVersion: 1, status: "current", updatedAt: new Date().toISOString() },
    analysis: { coverage: {}, cacheState: { status: "valid", diagnostics: [] } },
    stats: {}, nodes: [], edges: [], flows: [],
  };
  const bootstrap = createAgentBootstrap(graph);
  assert.equal(bootstrap.readiness.applicationFlowsAvailable, false);
  assert.equal(bootstrap.readiness.sourceFallbackRequired, true);
  assert.match(bootstrap.limitations.join(" "), /runtime order/);
});

test("agent bootstrap exposes initial scan state without inventing graph evidence", () => {
  const bootstrap = createAgentBootstrap(null, {
    project: { name: "fixture", branch: "main", revision: "abc123" },
    scanOutcome: {
      schemaVersion: "flopeek-scan-outcome/v1",
      status: "running",
      activeGraph: { available: false, projectId: null, graphVersion: null },
    },
  });
  assert.equal(bootstrap.graph.status, "unavailable");
  assert.equal(bootstrap.readiness.graphAvailable, false);
  assert.equal(bootstrap.scan.status, "running");
  assert.ok(bootstrap.workflow[0].tools.includes("get_scan_status"));
  assert.match(bootstrap.limitations.join(" "), /No complete Flopeek graph/);
});

test("agent bootstrap preserves an explicit static package-scope boundary", () => {
  const graph = {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    project: { projectId: "fixture", name: "fixture", git: {} },
    state: { graphVersion: 1, status: "current", updatedAt: new Date().toISOString() },
    analysis: {
      coverage: {},
      cacheState: { status: "disabled", diagnostics: [] },
      packageSelection: { kind: "static-package-path", status: "selected", path: "apps/api", manifest: "apps/api/package.json", packageName: "@fixture/api" },
    },
    stats: {}, nodes: [], edges: [], flows: [],
  };
  const bootstrap = createAgentBootstrap(graph);
  assert.equal(bootstrap.graph.packageSelection.path, "apps/api");
  assert.match(bootstrap.limitations.join(" "), /selected static package subtree/);
});

test("CLI bootstrap reuses a current persistent graph identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-bootstrap-cache-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), ".flopeek/\n", "utf8");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bootstrap-cache-fixture" }), "utf8");
    fs.writeFileSync(path.join(root, "src", "main.rs"), "fn main() { println!(\"ready\"); }\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
    execFileSync("git", ["config", "user.email", "flopeek@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Flopeek Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const scanned = JSON.parse(execFileSync(process.execPath, [cli, "scan", root, "--format", "json"], { encoding: "utf8" }));
    const bootstrap = JSON.parse(execFileSync(process.execPath, [cli, "bootstrap", root, "--format", "json"], { encoding: "utf8" }));

    assert.equal(scanned.state.graphVersion, 1);
    assert.equal(bootstrap.project.revision, scanned.project.git.revision);
    assert.equal(bootstrap.graph.graphVersion, scanned.state.graphVersion);
    assert.equal(bootstrap.graph.cache.status, "valid");
    assert.equal(bootstrap.graph.updatedAt, scanned.state.updatedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
