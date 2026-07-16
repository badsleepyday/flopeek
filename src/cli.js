#!/usr/bin/env node

const path = require("node:path");
const { execFile } = require("node:child_process");
const packageInfo = require("../package.json");
const { runMcpServer } = require("./mcp");
const { startServer } = require("./server");
const { benchmarkRepository, printBenchmark } = require("./benchmark");
const { createProductProof, printProductProof } = require("./product-proof");
const { compareGitSnapshots, createGitSnapshot } = require("./history");
const { getAgentBootstrap, getChangeImpact } = require("./graph-service");
const { doctorAgentIntegration, installAgentIntegration, uninstallAgentIntegration } = require("./agent-integration");
const { agentComparisonSummary, evaluateAgentComparison, loadAgentComparisonRuns } = require("./agent-comparison");
const { evaluateOrientation, loadOrientationCases, orientationSummary } = require("./orientation-benchmark");
const { applyShowcaseChange, printShowcase, resetShowcase, showcasePublicResult, showcaseStatus, startShowcase } = require("./showcase");
const { getGitChangedPaths, graphToMermaid, readGraphCache, scanRepository, writeGraphCache } = require("./scanner");
const { summarizeCacheResult } = require("./graph-cache");
const { readGraphDelta, readLatestGraphDelta } = require("./graph-state");
const { activateOnWorkspaceHub, startWorkspaceServer } = require("./workspace-server");

function parseArgs(argv) {
  const result = { command: "serve", evaluation: null, showcaseAction: "run", root: process.cwd(), port: 4780, portFallback: true, global: false, workspaceId: null, serviceLabel: null, open: true, cache: true, format: "summary", changed: [], base: null, commit: "HEAD", from: "HEAD~1", to: "HEAD", fromVersion: null, toVersion: null, force: false, iterations: 3, platforms: [], dryRun: false, strict: false, casesFile: null, runsFile: null, condition: "both", keepWorkspace: false };
  const values = [...argv];
  if (["scan", "impact", "snapshot", "history", "delta", "benchmark", "proof", "evaluate", "showcase", "bootstrap", "install", "uninstall", "doctor", "serve", "mcp", "help", "version", "--help", "-h", "--version", "-v"].includes(values[0])) result.command = values.shift().replace(/^--?/, "") || "help";
  if (result.command === "evaluate" && ["orientation", "agent-comparison"].includes(values[0])) result.evaluation = values.shift();
  if (result.command === "showcase" && ["apply", "reset", "status"].includes(values[0])) result.showcaseAction = values.shift();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--port") result.port = Number(values[++index] || result.port);
    else if (value === "--strict-port") result.portFallback = false;
    else if (value === "--global" || value === "-g") result.global = true;
    else if (value === "--workspace") result.workspaceId = values[++index] || null;
    else if (value === "--service-label") result.serviceLabel = values[++index] || null;
    else if (value === "--format") result.format = values[++index] || result.format;
    else if (value === "--json") result.format = "json";
    else if (value === "--mermaid") result.format = "mermaid";
    else if (value === "--no-cache") result.cache = false;
    else if (value === "--no-open") result.open = false;
    else if (value === "--changed") result.changed.push(...String(values[++index] || "").split(",").map((path) => path.trim()).filter(Boolean));
    else if (value === "--base") result.base = values[++index] || null;
    else if (value === "--commit") result.commit = values[++index] || result.commit;
    else if (value === "--from") result.from = values[++index] || result.from;
    else if (value === "--to") result.to = values[++index] || result.to;
    else if (value === "--from-version") result.fromVersion = Number(values[++index]);
    else if (value === "--to-version") result.toVersion = Number(values[++index]);
    else if (value === "--force") result.force = true;
    else if (value === "--iterations") result.iterations = Number(values[++index] || result.iterations);
    else if (value === "--platform") result.platforms.push(...String(values[++index] || "").split(",").map((item) => item.trim()).filter(Boolean));
    else if (value === "--dry-run") result.dryRun = true;
    else if (value === "--strict") result.strict = true;
    else if (value === "--keep-workspace") result.keepWorkspace = true;
    else if (value === "--cases") result.casesFile = path.resolve(values[++index] || "");
    else if (value === "--runs") result.runsFile = path.resolve(values[++index] || "");
    else if (value === "--condition") result.condition = values[++index] || result.condition;
    else if (!value.startsWith("-")) result.root = path.resolve(value);
  }
  return result;
}

function openBrowser(url) {
  if (process.platform === "win32") execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true });
  else if (process.platform === "darwin") execFile("open", [url]);
  else execFile("xdg-open", [url]);
}

function printHelp() {
  console.log(`Flowpeek — project technical map

Package identity:
  flowpeek --version

Agent tools (MCP over stdio):
  flowpeek mcp [repository]
  flowpeek bootstrap [repository] [--format summary|json]

Agent host integration (project-local and non-destructive):
  flowpeek install [repository] [--platform auto|codex|claude|cursor|gemini|all] [--dry-run] [--format summary|json]
  flowpeek doctor [repository] [--platform codex|claude|cursor|gemini|all] [--strict] [--format summary|json]
  flowpeek uninstall [repository] [--platform auto|codex|claude|cursor|gemini|all] [--dry-run] [--format summary|json]

Graph workflow:
  flowpeek scan [repository] [--format summary|json|mermaid] [--no-cache]
  flowpeek impact [repository] [--changed path[,path] | --base git-ref] [--format summary|json]
  flowpeek snapshot [repository] [--commit git-ref] [--force] [--format summary|json]
  flowpeek history [repository] [--from git-ref] [--to git-ref] [--format summary|json]
  flowpeek delta [repository] [--from-version number --to-version number] [--format summary|json]
  flowpeek benchmark [repository] [--iterations 3] [--format summary|json]
  flowpeek proof [repository] [--iterations 3] [--format summary|json]
  flowpeek evaluate orientation [suite-root] --cases <file> [--condition baseline|flowpeek|both] [--format summary|json]
  flowpeek evaluate agent-comparison [suite-root] --cases <file> --runs <file> [--format summary|json]

Guided product demonstration:
  flowpeek showcase [--port 4780] [--strict-port] [--no-open] [--keep-workspace] [--format summary|json]
  flowpeek showcase apply|reset|status <temporary-workspace> [--format summary|json]

Optional compact local viewer:
  flowpeek serve [repository] [-g|--global] [--port 4780] [--strict-port] [--workspace id] [--service-label name] [--no-open]

Global mode activates projects behind one workspace hub/web port. A later command
using the same hub port adds or selects its project without stopping the hub.
Per-project mode remains available; occupied ports advance unless --strict-port.

For compatibility, a repository path without a command starts the viewer.`);
}

function printSummary(graph, cacheWritten = true) {
  const { stats, project } = graph;
  console.log(`${project.name} (${project.git.branch})`);
  console.log(`${stats.scannedFiles} files / ${stats.nodes} nodes / ${stats.edges} edges`);
  console.log(`${stats.endpoints} endpoints / ${stats.services} services / ${stats.calls || 0} direct calls / ${stats.tests} tests`);
  console.log(cacheWritten ? `Cache: ${path.join(project.root, ".flowpeek", "graph.json")}` : "Cache: not written (--no-cache)");
}

function printImpact(impact) {
  console.log(`${impact.matchedPaths.length} changed files mapped / ${impact.affectedNodes.length} affected nodes`);
  if (impact.deletedPaths.length) console.log(`${impact.deletedPaths.length} deleted files recovered from ${impact.historicalBaseline ? "the prior local graph" : "no baseline"}`);
  console.log(`${impact.affectedEndpoints.length} affected endpoints / ${impact.recommendedTests.length} recommended tests / ${impact.dependencyNodes.length} static dependencies`);
  if (impact.unmatchedPaths.length) console.log(`Not present in current graph: ${impact.unmatchedPaths.join(", ")}`);
}

function printSnapshot(result) {
  const { commit } = result.snapshot;
  console.log(`${result.created ? "Created" : "Reused"} snapshot ${commit.shortRevision} (${commit.requestedRef})`);
  if (commit.subject) console.log(commit.subject);
  console.log(`Snapshot: ${result.path}`);
}

function snapshotPayload(result) {
  return {
    created: result.created,
    path: result.path,
    commit: result.snapshot.commit,
    generatedAt: result.snapshot.graph.generatedAt,
    stats: result.snapshot.graph.stats,
    limitation: "The snapshot is static commit content, excludes uncommitted changes, and does not execute code or configuration.",
  };
}

function printHistory(history) {
  console.log(`${history.before.commit.shortRevision} → ${history.after.commit.shortRevision}`);
  console.log(`${history.changedPaths.length} changed paths / ${history.topology.summary.addedNodes} added nodes / ${history.topology.summary.removedNodes} removed nodes`);
  console.log(`${history.flows.summary.addedFlows} added flows / ${history.flows.summary.removedFlows} removed flows / ${history.flows.summary.changedFlows} changed flows`);
}

function printDelta(delta) {
  console.log(`Graph v${delta.fromGraphVersion} → v${delta.toGraphVersion} (${delta.reason})`);
  console.log(`${delta.changedPaths.length} changed paths / ${delta.summary.addedNodes} added nodes / ${delta.summary.removedNodes} removed nodes / ${delta.summary.changedNodes} changed nodes`);
  console.log(delta.topologyChanged ? "Static topology changed." : "Source changed without a static topology change.");
}

function printIntegration(result) {
  console.log(`${result.action}: ${result.ok ? "ready" : "blocked"}${result.dryRun ? " (dry run)" : ""}`);
  console.log(`Platforms: ${result.platforms.join(", ") || "none"}`);
  for (const item of result.plan) console.log(`${item.status.padEnd(9)} ${item.platform} ${item.kind}: ${item.path}${item.reason ? ` - ${item.reason}` : ""}`);
}

function printDoctor(result) {
  console.log(`Agent integration doctor: ${result.ok ? "ready" : "attention required"}`);
  console.log(`${result.summary.passed} passed / ${result.summary.warnings} warnings / ${result.summary.errors} errors`);
  for (const check of result.checks) console.log(`${check.status.padEnd(7)} ${check.id}: ${check.message}`);
}

function printBootstrap(result) {
  console.log(`${result.project.name} graph v${result.graph.graphVersion} (${result.graph.status})`);
  console.log(`${result.graph.inventory.nodes} nodes / ${result.graph.inventory.edges} edges / ${result.graph.inventory.applicationFlows} application flows`);
  console.log(`Strategy: ${result.policy.strategy}`);
  console.log("Start with get_handoff_context for a known task, then inspect raw node or Flow Lens evidence before editing source.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help" || options.command === "h") return printHelp();
  if (options.command === "version" || options.command === "v") return console.log(packageInfo.version);
  if (options.command === "mcp") return runMcpServer(options);
  if (options.command === "showcase") {
    if (options.showcaseAction !== "run") {
      const result = options.showcaseAction === "apply"
        ? applyShowcaseChange(options.root)
        : options.showcaseAction === "reset"
          ? resetShowcase(options.root)
          : showcaseStatus(options.root);
      if (options.format === "json") console.log(JSON.stringify(result, null, 2));
      else if (options.format === "summary") console.log(`${result.showcaseId}: ${result.status} (${result.changePath})${result.changed === undefined ? "" : result.changed ? " - source updated" : " - no change required"}`);
      else throw new Error("Showcase actions support summary or json formats.");
      return;
    }
    const instance = await startShowcase({ port: options.port, portFallback: options.portFallback, keepWorkspace: options.keepWorkspace });
    if (options.format === "json") console.log(JSON.stringify(showcasePublicResult(instance), null, 2));
    else if (options.format === "summary") printShowcase(instance);
    else {
      await instance.close();
      throw new Error("Showcase output supports summary or json formats.");
    }
    if (options.open) openBrowser(instance.url);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await instance.close();
      process.exit(0);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  if (options.command === "evaluate") {
    if (!options.casesFile) throw new Error(`${options.evaluation === "agent-comparison" ? "Agent comparison" : "Orientation"} evaluation requires --cases <file>.`);
    let result;
    let summary;
    if (options.evaluation === "orientation") {
      result = evaluateOrientation(options.root, loadOrientationCases(options.casesFile), { condition: options.condition });
      summary = orientationSummary(result);
    } else if (options.evaluation === "agent-comparison") {
      if (!options.runsFile) throw new Error("Agent comparison evaluation requires --runs <file>.");
      result = evaluateAgentComparison(options.root, loadOrientationCases(options.casesFile), loadAgentComparisonRuns(options.runsFile));
      summary = agentComparisonSummary(result);
    } else throw new Error("Supported evaluations are orientation and agent-comparison.");
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else if (options.format === "summary") console.log(summary);
    else throw new Error("Evaluation supports summary or json formats.");
    return;
  }
  if (["install", "uninstall", "doctor"].includes(options.command)) {
    const integrationOptions = { platforms: options.platforms.length ? options.platforms : options.command === "doctor" ? "all" : "auto", dryRun: options.dryRun, strict: options.strict };
    const result = options.command === "install"
      ? installAgentIntegration(options.root, integrationOptions)
      : options.command === "uninstall"
        ? uninstallAgentIntegration(options.root, integrationOptions)
        : doctorAgentIntegration(options.root, integrationOptions);
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else if (options.format === "summary") options.command === "doctor" ? printDoctor(result) : printIntegration(result);
    else throw new Error("Agent integration output supports summary or json formats.");
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (options.command === "bootstrap") {
    const graph = scanRepository(options.root);
    const result = getAgentBootstrap(graph);
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else if (options.format === "summary") printBootstrap(result);
    else throw new Error("Bootstrap output supports summary or json formats.");
    return;
  }
  if (options.command === "scan") {
    // `--no-cache` is the safe inspection mode: it must not leave Flowpeek
    // metadata behind merely to obtain a generated project identity.
    const graph = scanRepository(options.root, { persistIdentity: options.cache });
    graph.analysis.cacheState = options.cache
      ? summarizeCacheResult(writeGraphCache(graph.project.root, graph, { reason: "cli-scan" }))
      : { status: "disabled", path: path.join(graph.project.root, ".flowpeek", "graph.json"), diagnostics: [], contract: null, migrated: false };
    if (options.format === "json") console.log(JSON.stringify(graph, null, 2));
    else if (options.format === "mermaid") console.log(graphToMermaid(graph));
    else if (options.format === "summary") printSummary(graph, options.cache);
    else throw new Error("--format must be summary, json, or mermaid.");
    return;
  }
  if (options.command === "impact") {
    const graph = scanRepository(options.root, { persistIdentity: options.cache });
    const previousGraph = readGraphCache(options.root, { expectedProjectId: graph.project.projectId });
    const changedPaths = options.changed.length ? options.changed : getGitChangedPaths(graph.project.root, options.base);
    graph.analysis.cacheState = options.cache
      ? summarizeCacheResult(writeGraphCache(graph.project.root, graph, { reason: "cli-impact", changedPaths }))
      : { status: "disabled", path: path.join(graph.project.root, ".flowpeek", "graph.json"), diagnostics: [], contract: null, migrated: false };
    const impact = getChangeImpact(graph, changedPaths, { previousGraph });
    if (options.format === "json") console.log(JSON.stringify(impact, null, 2));
    else if (options.format === "summary") printImpact(impact);
    else throw new Error("Impact output supports summary or json formats.");
    return;
  }
  if (options.command === "snapshot") {
    const result = createGitSnapshot(options.root, { ref: options.commit, force: options.force });
    if (options.format === "json") console.log(JSON.stringify(snapshotPayload(result), null, 2));
    else if (options.format === "summary") printSnapshot(result);
    else throw new Error("Snapshot output supports summary or json formats.");
    return;
  }
  if (options.command === "history") {
    const result = compareGitSnapshots(options.root, { from: options.from, to: options.to });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else if (options.format === "summary") printHistory(result);
    else throw new Error("History output supports summary or json formats.");
    return;
  }
  if (options.command === "delta") {
    const delta = options.fromVersion !== null && options.toVersion !== null
      ? readGraphDelta(options.root, options.fromVersion, options.toVersion)
      : readLatestGraphDelta(options.root);
    if (!delta) throw new Error("No matching persisted graph delta was found.");
    if (options.format === "json") console.log(JSON.stringify(delta, null, 2));
    else if (options.format === "summary") printDelta(delta);
    else throw new Error("Delta output supports summary or json formats.");
    return;
  }
  if (options.command === "benchmark") {
    const result = benchmarkRepository(options.root, { iterations: options.iterations });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else if (options.format === "summary") printBenchmark(result);
    else throw new Error("Benchmark output supports summary or json formats.");
    return;
  }
  if (options.command === "proof") {
    const graph = scanRepository(options.root, { persistIdentity: false });
    const result = createProductProof(graph, { localBenchmark: benchmarkRepository(options.root, { iterations: options.iterations }) });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else if (options.format === "summary") printProductProof(result);
    else throw new Error("Proof output supports summary or json formats.");
    return;
  }
  if (options.command !== "serve") throw new Error(`Unknown command: ${options.command}`);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("--port must be a valid TCP port.");

  if (options.global) {
    let activated = null;
    try {
      activated = await activateOnWorkspaceHub({ port: options.port, workspaceId: options.workspaceId, root: options.root, serviceLabel: options.serviceLabel });
    } catch (error) {
      if (error?.name !== "TimeoutError" && error?.cause?.code !== "ECONNREFUSED" && error?.code !== "ECONNREFUSED") throw error;
    }
    const url = `http://127.0.0.1:${activated?.hubPort || options.port}`;
    if (activated) {
      console.log(`Activated ${activated.project.serviceLabel} in existing workspace ${activated.workspace.workspaceId}: ${url}`);
      console.log(`Project ID: ${activated.project.projectId}`);
      if (options.open) openBrowser(url);
      return;
    }
    const hub = await startWorkspaceServer({
      port: options.port,
      portFallback: options.portFallback,
      workspaceId: options.workspaceId,
      projects: [{ root: options.root, serviceLabel: options.serviceLabel }],
    });
    const hubUrl = `http://127.0.0.1:${hub.port}`;
    console.log(`Flowpeek workspace hub: ${hubUrl}`);
    console.log(`Serve workspace: ${hub.workspaceId}`);
    console.log(`Active projects: ${hub.workspace().projectCount}`);
    if (hub.portBinding.fallback) console.log(`Port ${hub.portBinding.requestedPort} was occupied; the hub uses ${hub.port} without stopping the existing process.`);
    if (options.open) openBrowser(hubUrl);
    const closeHub = () => hub.close().then(() => process.exit(0));
    process.once("SIGINT", closeHub);
    process.once("SIGTERM", closeHub);
    return;
  }

  const app = await startServer(options);
  const url = `http://127.0.0.1:${app.port}`;
  console.log(`Compact Project Flow Explorer viewer: ${url}`);
  console.log(`Scanning: ${app.root}`);
  console.log(`Serve workspace: ${app.serveInstance.workspaceId}`);
  console.log(`Project ID: ${app.serveInstance.project.projectId}`);
  if (app.portBinding.fallback) console.log(`Port ${app.portBinding.requestedPort} was occupied; this instance uses ${app.port} without stopping the existing process.`);
  if (options.open) openBrowser(url);
  const close = () => app.server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error) => {
  console.error(`Flowpeek command failed: ${error.message}`);
  process.exitCode = 1;
});
