"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createScanCoordinator } = require("./scan-coordinator");
const { getFlowContextCard, projectView, resolveContextRef } = require("./graph-service");

const CASE_SCHEMA = "flopeek-supported-language-dogfood-cases/v1";
const REPORT_SCHEMA = "flopeek-supported-language-dogfood/v1";

function sourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".flopeek" || entry.name === ".flowpeek" || entry.name === "expectations.json") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function sourceDigest(root) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of sourceFiles(root)) {
    hash.update(relativePath);
    hash.update("\0");
    const content = fs.readFileSync(path.join(root, relativePath));
    const normalized = Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"));
    hash.update(normalized);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function nodeReference(node) {
  if (node.kind === "endpoint") return `endpoint:${node.label}`;
  if (node.kind === "command" && node.entryKind === "django-management-command") return `command:${node.path}:${node.commandName}`;
  if (node.kind === "command") return `command:${node.manifest}:${node.scriptName}`;
  if (node.kind === "schedule") return `schedule:${node.path}:${node.taskName}`;
  if (node.kind === "external") return `external:${node.label}`;
  if (node.kind === "symbol") return `symbol:${node.path}:${node.type}:${node.label}`;
  return `file:${node.path}`;
}

function relationshipKey(relationship) {
  return `${relationship.type}|${relationship.source}|${relationship.target}`;
}

function auditRelationships(graph, expectations) {
  const expected = new Set(expectations.relationships.map(relationshipKey));
  const allowedTypes = new Set(expectations.relationships.map((item) => item.type));
  const allowedSources = new Set(expectations.relationships.map((item) => item.source));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const actual = new Set(graph.edges
    .filter((edge) => allowedTypes.has(edge.type))
    .map((edge) => ({ type: edge.type, source: nodes.get(edge.source), target: nodes.get(edge.target) }))
    .filter((edge) => edge.source && edge.target)
    .map((edge) => ({ type: edge.type, source: nodeReference(edge.source), target: nodeReference(edge.target) }))
    .filter((edge) => allowedSources.has(edge.source))
    .map(relationshipKey));
  const truePositives = [...actual].filter((key) => expected.has(key)).length;
  return {
    expected: expected.size,
    detected: actual.size,
    truePositives,
    falsePositives: actual.size - truePositives,
    falseNegatives: expected.size - truePositives,
    precision: actual.size ? truePositives / actual.size : 0,
    recall: expected.size ? truePositives / expected.size : 1,
  };
}

function semanticLevels(graph) {
  const domain = projectView(graph, { level: "domain" });
  const feature = projectView(graph, { level: "feature", focus: domain.nodes[0]?.id || null });
  const component = projectView(graph, { level: "component", focus: feature.nodes[0]?.id || null });
  const symbol = projectView(graph, { level: "symbol", focus: component.nodes[0]?.id || null });
  return { domain: domain.nodes.length, feature: feature.nodes.length, component: component.nodes.length, symbol: symbol.nodes.length };
}

function toolPayload(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError || !text) throw new Error("MCP did not return a readable tool payload.");
  return JSON.parse(text);
}

async function waitForMcpScan(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = toolPayload(await client.callTool({ name: "get_scan_status", arguments: {} }));
    if (latest.status === "complete") return latest;
    if (latest.status !== "running" && latest.status !== "idle") throw new Error(`MCP initial scan did not complete: ${latest.failure?.message || latest.reason || latest.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error(`Timed out waiting for the MCP initial scan; last status: ${latest?.status || "unavailable"}.`);
}

async function mcpFlowBasis(disposableRoot, flowId) {
  let client;
  let transport;
  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, "cli.js"), "mcp", disposableRoot], cwd: path.resolve(__dirname, ".."), stderr: "pipe" });
    client = new Client({ name: "flopeek-supported-language-dogfood", version: "1.0.0" });
    await client.connect(transport);
    await waitForMcpScan(client);
    const bootstrap = toolPayload(await client.callTool({ name: "get_agent_bootstrap", arguments: {} }));
    const flow = toolPayload(await client.callTool({ name: "get_flow_context_card", arguments: { flowId } }));
    if (!flow.card?.contextRef || flow.card.project?.graphVersion !== bootstrap.graph?.graphVersion) throw new Error("MCP Flow Context Card does not share the bootstrap graph basis.");
    return { graphVersion: bootstrap.graph.graphVersion, contextRef: flow.card.contextRef };
  } finally {
    if (client) await client.close();
    else if (transport) await transport.close();
  }
}

async function evaluateCase(repositoryRoot, definition) {
  const fixtureRoot = path.join(repositoryRoot, "test", "fixtures", definition.fixture);
  const expectations = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "expectations.json"), "utf8"));
  const digest = sourceDigest(fixtureRoot);
  if (digest !== definition.sourceDigest) throw new Error(`${definition.id}: source digest does not match the pinned case definition.`);
  const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), `flopeek-dogfood-${definition.id}-`));
  fs.cpSync(fixtureRoot, disposableRoot, { recursive: true });
  const coordinator = createScanCoordinator(disposableRoot, { cache: false });
  try {
    const initial = await coordinator.refresh(null, "supported-language-dogfood-initial");
    if (initial.outcome.status !== "complete" || !initial.graph) throw new Error(`${definition.id}: initial scan did not produce a complete graph.`);
    const graph = initial.graph;
    const relationshipAudit = auditRelationships(graph, expectations);
    if (relationshipAudit.precision < expectations.minimumPrecision || relationshipAudit.recall < expectations.minimumRecall) throw new Error(`${definition.id}: audited relationship quality is below its fixture threshold.`);
    const flow = graph.flows[0];
    if (!flow) throw new Error(`${definition.id}: no supported static Flow Lens is available.`);
    const initialCard = getFlowContextCard(graph, flow.id);
    if (!initialCard?.card?.contextRef) throw new Error(`${definition.id}: Flow Context Ref is unavailable.`);
    const mcp = await mcpFlowBasis(disposableRoot, flow.id);
    const levels = semanticLevels(graph);
    if (Object.values(levels).some((count) => count < 1)) throw new Error(`${definition.id}: at least one semantic projection is empty.`);
    const target = path.join(disposableRoot, definition.mutationPath);
    fs.appendFileSync(target, definition.mutation, "utf8");
    const refreshed = await coordinator.refresh([definition.mutationPath], "supported-language-dogfood-source-only-edit");
    if (refreshed.outcome.status !== "complete" || !refreshed.graph) throw new Error(`${definition.id}: source-only refresh did not produce a complete graph.`);
    const resolution = resolveContextRef(refreshed.graph, initialCard.card.contextRef);
    if (resolution.status !== "stale") throw new Error(`${definition.id}: source-only edit did not mark the affected Flow Context Ref stale.`);
    return {
      id: definition.id,
      language: definition.language,
      fixture: definition.fixture,
      sourceDigest: digest,
      supportedStaticEntry: { id: flow.id, kind: flow.entry.kind, family: flow.entry.family, displayedSteps: flow.steps.length },
      relationshipAudit,
      semanticLevels: levels,
      mcp: { graphVersion: mcp.graphVersion, contextRefResolved: Boolean(mcp.contextRef) },
      contextResolution: { before: "current", afterSourceOnlyEdit: resolution.status },
      refresh: { fromGraphVersion: graph.state.graphVersion, toGraphVersion: refreshed.graph.state.graphVersion, changedPath: definition.mutationPath },
      limitations: [
        "This is static analysis over a declared adapter subset. It does not execute the target application or prove runtime order, successful behavior, or business intent.",
        "The disposable source-only edit checks graph freshness and Context Ref lifecycle; it is not a test execution or deployment result.",
      ],
    };
  } finally {
    fs.rmSync(disposableRoot, { recursive: true, force: true });
  }
}

async function evaluateSupportedLanguageDogfood(repositoryRoot, options = {}) {
  const casesPath = options.casesPath || path.join(repositoryRoot, "benchmarks", "supported-language-dogfood-cases.json");
  const manifest = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  if (manifest.schemaVersion !== CASE_SCHEMA || !Array.isArray(manifest.cases) || manifest.cases.length < 3) throw new Error("Supported-language dogfood cases are invalid or incomplete.");
  const results = [];
  for (const definition of manifest.cases) results.push(await evaluateCase(repositoryRoot, definition));
  return {
    schemaVersion: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    casesPath: path.relative(repositoryRoot, casesPath).replaceAll("\\", "/"),
    outcomes: results,
    limitation: "This report keeps audited static relationships, semantic projection traversal, and Context Ref freshness separate. It is not a language-support score, runtime benchmark, or release approval.",
  };
}

if (require.main === module) {
  evaluateSupportedLanguageDogfood(process.cwd()).then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CASE_SCHEMA, REPORT_SCHEMA, evaluateSupportedLanguageDogfood, sourceDigest };
