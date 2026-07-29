"use strict";

// Phase telemetry for the same ScanCoordinator authority lifecycle measured by
// benchmark-native-core-client. It intentionally uses disposable copies so a
// profiling run never creates Flopeek metadata or modifies a source corpus.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { createScanCoordinator } = require("../src/scan-coordinator");
const { NativeProtocolClient } = require("../src/native-protocol-client");
const { copyRepository, sourceFiles } = require("./benchmark-native-incremental");
const { releaseNativeOptions, stateRequest } = require("./benchmark-native-core-client");

const QUERY_SAMPLES = Number.isSafeInteger(Number(process.env.FLOPEEK_PROFILE_QUERY_SAMPLES))
  ? Math.max(3, Math.min(101, Number(process.env.FLOPEEK_PROFILE_QUERY_SAMPLES)))
  : 7;

function elapsed(operation) {
  const started = process.hrtime.bigint();
  return Promise.resolve(operation()).then((result) => ({
    result,
    milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
  }));
}

function nodeMemorySnapshot() {
  const usage = process.memoryUsage();
  const resources = process.resourceUsage();
  const reportedPeak = process.platform === "win32" ? resources.maxRSS : resources.maxRSS * 1024;
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    // Node's Windows maxRSS unit has varied across supported runtimes. A
    // reported peak below current RSS is not physically meaningful.
    peakRssBytes: Math.max(usage.rss, reportedPeak),
  };
}

function nativeMemorySnapshot(client) {
  const pid = client?.child?.pid;
  if (!Number.isInteger(pid)) return { status: "unavailable", reason: "native-process-not-started", pid: null };
  try {
    if (process.platform === "win32") {
      const values = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).WorkingSet64; (Get-Process -Id ${pid}).PeakWorkingSet64`], { encoding: "utf8" }).trim().split(/\s+/u).map(Number);
      return { status: "available", pid, rssBytes: values[0], peakRssBytes: values[1], source: "windows-working-set" };
    }
    if (process.platform === "linux") {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const value = (label) => Number(status.match(new RegExp(`^${label}:\\s+(\\d+)\\s+kB$`, "m"))?.[1]) * 1024;
      return { status: "available", pid, rssBytes: value("VmRSS"), peakRssBytes: value("VmHWM"), source: "proc-status" };
    }
    const rssBytes = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
    return { status: "available", pid, rssBytes, peakRssBytes: null, source: "ps-current-rss" };
  } catch (error) {
    return { status: "unavailable", reason: error.message, pid };
  }
}

function combinedMemorySnapshot(nativeProtocol) {
  const node = nodeMemorySnapshot();
  const native = nativeMemorySnapshot(nativeProtocol);
  return {
    node,
    native,
    combinedRssBytes: native.status === "available" ? node.rssBytes + native.rssBytes : null,
    combinedPeakRssBytes: native.status === "available" && Number.isFinite(native.peakRssBytes) ? node.peakRssBytes + native.peakRssBytes : null,
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1));
  return Number(ordered[index].toFixed(3));
}

function latencySummary(samples, transport = []) {
  const availableTransport = transport.filter(Boolean);
  const numeric = (key) => availableTransport.map((entry) => entry[key]).filter(Number.isFinite);
  return {
    samples: samples.length,
    minMs: percentile(samples, 0),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    maxMs: percentile(samples, 100),
    transport: availableTransport.length ? {
      samples: availableTransport.length,
      requestBytes: numeric("requestBytes").reduce((total, value) => total + value, 0),
      responseBytes: numeric("responseBytes").reduce((total, value) => total + value, 0),
      roundTripP50Ms: percentile(numeric("roundTripMilliseconds"), 50),
      roundTripP95Ms: percentile(numeric("roundTripMilliseconds"), 95),
    } : null,
  };
}

function nativeStoreSnapshot(root) {
  const database = path.join(root, ".flopeek", "native-core.sqlite3");
  const wal = `${database}-wal`;
  const size = (candidate) => fs.existsSync(candidate) ? fs.statSync(candidate).size : 0;
  return {
    databasePath: fs.existsSync(database) ? database : null,
    databaseBytes: size(database),
    walBytes: size(wal),
  };
}

async function profileQueries(core, graph, nativeProtocol = null) {
  const node = graph.nodes.find((candidate) => candidate.kind === "file") || graph.nodes[0] || null;
  if (!node) return { schemaVersion: "flopeek-native-query-profile/v1", samplesPerOperation: QUERY_SAMPLES, operations: {} };
  const card = await core.getContextCard(graph, node.id);
  const contextRef = card?.card?.contextRef || null;
  const query = node.label.slice(0, Math.max(1, Math.min(node.label.length, 24)));
  const operations = [
    ["findNodes", () => core.findNodes(graph, { query })],
    ["projectOverview", () => core.getProjectOverview(graph, { mode: "overview", scope: "application", level: "feature" })],
    ["contextCard", () => core.getContextCard(graph, node.id)],
  ];
  if (contextRef) operations.push(["resolveContextRef", () => core.resolveContextRef(graph, contextRef)]);
  if (graph.flows[0]) operations.push(["flowProjection", () => core.getFlowProjection(graph, graph.flows[0].id)]);
  const results = {};
  for (const [name, operation] of operations) {
    const samples = [];
    const transport = [];
    for (let index = 0; index < QUERY_SAMPLES; index += 1) {
      const measurement = await elapsed(operation);
      samples.push(measurement.milliseconds);
      const stats = nativeProtocol?.getLastResponseStats?.();
      if (stats && Number.isFinite(stats.roundTripMilliseconds)) transport.push(stats);
    }
    results[name] = latencySummary(samples, transport);
  }
  return { schemaVersion: "flopeek-native-query-profile/v1", samplesPerOperation: QUERY_SAMPLES, operations: results };
}

async function profileState(coordinator, core, request, phases, nativeProtocol = null) {
  const phaseStart = phases.length;
  const memoryBefore = combinedMemorySnapshot(nativeProtocol);
  const scan = await elapsed(() => coordinator.refresh(request.changedPaths, request.reason));
  const memoryAfter = combinedMemorySnapshot(nativeProtocol);
  assert.equal(scan.result.outcome.status, "complete", scan.result.outcome.failure?.message || "Profile coordinator scan failed.");
  const queries = await profileQueries(core, scan.result.graph, nativeProtocol);
  return {
    milliseconds: Number(scan.milliseconds.toFixed(3)),
    phases: phases.slice(phaseStart),
    memoryBefore,
    memoryAfter,
    database: nativeStoreSnapshot(coordinator.root),
    queries,
    graph: scan.result.graph,
  };
}

async function main() {
  const source = path.resolve(process.argv[2] || "");
  if (!source || !fs.statSync(source).isDirectory()) throw new Error("Supply an existing repository path.");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-profile-"));
  const jsRoot = path.join(sandbox, "javascript");
  const nativeRoot = path.join(sandbox, "native");
  copyRepository(source, jsRoot);
  copyRepository(source, nativeRoot);
  const javascript = createJsCoreClient();
  const nativeProtocol = new NativeProtocolClient(releaseNativeOptions());
  const native = createNativeCoreClient({ native: nativeProtocol, sourceAuthority: "rust" });
  const javascriptPhases = [];
  const nativePhases = [];
  const javascriptCoordinator = createScanCoordinator(jsRoot, { cache: true, coreClient: javascript, onCoreProfile: (entry) => javascriptPhases.push(entry) });
  const nativeCoordinator = createScanCoordinator(nativeRoot, { cache: true, coreClient: native, onCoreProfile: (entry) => nativePhases.push(entry) });
  try {
    const states = {};
    for (const [state, mutate] of [
      ["cold", null],
      ["unchanged", null],
      ["oneFileChange", (root) => {
        const file = sourceFiles(root)[0];
        fs.appendFileSync(file, "\n");
        return path.relative(root, file).replaceAll("\\", "/");
      }],
    ]) {
      const jsChangedPath = mutate?.(jsRoot) || null;
      const nativeChangedPath = mutate?.(nativeRoot) || null;
      assert.equal(nativeChangedPath, jsChangedPath, "Disposable profile copies must mutate the same relative path.");
      const request = stateRequest(state, jsChangedPath);
      const js = await profileState(javascriptCoordinator, javascript, request, javascriptPhases);
      const nativeResult = await profileState(nativeCoordinator, native, request, nativePhases, nativeProtocol);
      assert.equal(
        createCoreCompatibilityDigest(nativeResult.graph),
        createCoreCompatibilityDigest(js.graph),
        `Native CoreClient diverged from JavaScript during ${state}.`,
      );
      assert.deepEqual(nativeResult.graph.stats, js.graph.stats, `Native CoreClient statistics diverged during ${state}.`);
      states[state] = {
        javascriptMs: js.milliseconds,
        nativeMs: nativeResult.milliseconds,
        javascriptPhases: js.phases,
        nativePhases: nativeResult.phases,
        javascriptMemoryBefore: js.memoryBefore,
        javascriptMemoryAfter: js.memoryAfter,
        nativeMemoryBefore: nativeResult.memoryBefore,
        nativeMemoryAfter: nativeResult.memoryAfter,
        javascriptDatabase: js.database,
        nativeDatabase: nativeResult.database,
        javascriptQueryLatency: js.queries,
        nativeQueryLatency: nativeResult.queries,
      };
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "flopeek-native-core-profile/v1",
      repository: path.basename(source),
      states,
      parity: "Every profiled state has exact flopeek-core-compatibility/v1 digest and graph-statistics parity.",
      limitation: "One isolated strict-Rust-source profile run identifies local phase cost and reports sampled process RSS/peak working set. It is not a performance median or cutover proof.",
    }, null, 2)}\n`);
  } finally {
    await native.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = { combinedMemorySnapshot, latencySummary, profileQueries, profileState };
