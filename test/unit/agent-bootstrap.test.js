const assert = require("node:assert/strict");
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
  assert.ok(bootstrap.workflow.some((step) => step.tools.includes("get_handoff_context")));
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
