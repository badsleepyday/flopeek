#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync, spawn } = require("node:child_process");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { createNativeIncrementalSession } = require("../src/native-incremental-coordinator");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "flopeek-native-soak-evidence/v1";
const EVENTS_PER_MODE = 1000;
const EVENT_BLOCK = Object.freeze([
  ...Array(50).fill("content-only-edit"),
  ...Array(15).fill("symbol-addition"),
  ...Array(10).fill("symbol-removal"),
  ...Array(10).fill("file-add-delete"),
  ...Array(5).fill("rename"),
  ...Array(5).fill("manifest-config-reconciliation"),
  ...Array(5).fill("no-op"),
]);

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function write(root, relative, body) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function eventSchedule(count = EVENTS_PER_MODE) {
  if (!Number.isSafeInteger(count) || count <= 0 || count % EVENT_BLOCK.length !== 0) {
    throw new Error("Soak event count must be a positive multiple of 100.");
  }
  return Array.from({ length: count }, (_, index) => EVENT_BLOCK[index % EVENT_BLOCK.length]);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function plateauEvidence(series) {
  if (!Array.isArray(series) || series.length < 600 || !series.every(Number.isFinite)) {
    throw new Error("RSS plateau requires at least 600 finite raw samples.");
  }
  // The first half of a long run is warm-up by contract. Compare the final
  // 100 samples with the immediately preceding 200 so an allocator capacity
  // step during warm-up is not misclassified as linear retention.
  const prior = series.slice(-300, -100);
  const final = series.slice(-100);
  const priorMedian = median(prior);
  const finalMedian = median(final);
  const priorMaximum = Math.max(...prior);
  const finalMaximum = Math.max(...final);
  const medianGrowthBytes = finalMedian - priorMedian;
  const maximumGrowthBytes = finalMaximum - priorMaximum;
  const plateau = medianGrowthBytes <= 8 * 1024 * 1024
    && maximumGrowthBytes <= 16 * 1024 * 1024;
  return {
    plateau,
    priorWindowSamples: prior.length,
    finalWindowSamples: final.length,
    priorMedianBytes: priorMedian,
    finalMedianBytes: finalMedian,
    medianGrowthBytes,
    priorMaximumBytes: priorMaximum,
    finalMaximumBytes: finalMaximum,
    maximumGrowthBytes,
    acceptance: {
      maximumMedianGrowthBytes: 8 * 1024 * 1024,
      maximumPeakGrowthBytes: 16 * 1024 * 1024,
    },
  };
}

function nativeRss(session) {
  const pid = session.child?.pid;
  if (!Number.isSafeInteger(pid)) throw new Error("Native soak process is not running.");
  if (process.platform === "linux") {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/mu)?.[1]);
    if (!Number.isFinite(rssKb)) throw new Error("Native Linux RSS is unavailable.");
    return rssKb * 1024;
  }
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim()) * 1024;
}

function createNativeRssSampler(session) {
  const pid = session.child?.pid;
  if (!Number.isSafeInteger(pid)) throw new Error("Native soak process is not running.");
  if (process.platform !== "win32") {
    return {
      sample: async () => nativeRss(session),
      close: async () => {},
    };
  }
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference = 'Stop'; while (($line = [Console]::In.ReadLine()) -ne $null) { $rss = (Get-Process -Id ([int]$line)).WorkingSet64; [Console]::Out.WriteLine($rss); [Console]::Out.Flush() }",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = [];
  let failure = null;
  let stderr = "";
  const fail = (error) => {
    if (!failure) failure = error;
    while (pending.length) pending.shift().reject(failure);
  };
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", fail);
  child.on("exit", (code) => {
    if (code !== 0 && pending.length) {
      fail(new Error(`Persistent Windows RSS sampler exited ${code}: ${stderr.trim()}`));
    }
  });
  lines.on("line", (line) => {
    const current = pending.shift();
    if (!current) return;
    const value = Number(line.trim());
    if (!Number.isFinite(value)) {
      current.reject(new Error(`Persistent Windows RSS sampler returned an invalid value: ${line}`));
      return;
    }
    current.resolve(value);
  });
  return {
    sample: () => {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        child.stdin.write(`${pid}\n`, (error) => {
          if (error) fail(error);
        });
      });
    },
    close: async () => {
      lines.close();
      if (child.exitCode != null) return;
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

function sqliteSizes(root) {
  const database = path.join(root, ".flopeek", "native-core.sqlite3");
  const size = (file) => fs.existsSync(file) ? fs.statSync(file).size : 0;
  return { databaseBytes: size(database), walBytes: size(`${database}-wal`) };
}

function createFixture(root, mode) {
  write(root, "package.json", `${JSON.stringify({
    name: `native-soak-${mode}`,
    version: "1.0.0",
    scripts: { start: "node src/index.js" },
  }, null, 2)}\n`);
  write(root, "src/index.ts", "import { stable } from './symbols';\nexport function entry() { return stable(); }\n");
  write(root, "src/content.ts", "export const content = 0;\n");
  write(root, "src/symbols.ts", "export function stable() { return 1; }\n");
  write(root, "src/rename-a.ts", "export const renamed = 'a';\n");
}

function mutate(root, state, event, sequence) {
  if (event === "content-only-edit") {
    write(root, "src/content.ts", `// content revision ${sequence}\nexport const content = 0;\n`);
    return ["src/content.ts"];
  }
  if (event === "symbol-addition") {
    const name = `added${sequence}`;
    state.symbols.push(name);
    write(root, "src/symbols.ts", [
      "export function stable() { return 1; }",
      ...state.symbols.map((symbol) => `export function ${symbol}() { return ${sequence}; }`),
      "",
    ].join("\n"));
    return ["src/symbols.ts"];
  }
  if (event === "symbol-removal") {
    state.symbols.shift();
    write(root, "src/symbols.ts", [
      "export function stable() { return 1; }",
      ...state.symbols.map((symbol) => `export function ${symbol}() { return 1; }`),
      "",
    ].join("\n"));
    return ["src/symbols.ts"];
  }
  if (event === "file-add-delete") {
    const relative = "src/transient.ts";
    if (state.transient) fs.rmSync(path.join(root, ...relative.split("/")));
    else write(root, relative, `export const transient${sequence} = true;\n`);
    state.transient = !state.transient;
    return [relative];
  }
  if (event === "rename") {
    const from = state.renameA ? "src/rename-a.ts" : "src/rename-b.ts";
    const to = state.renameA ? "src/rename-b.ts" : "src/rename-a.ts";
    fs.renameSync(path.join(root, ...from.split("/")), path.join(root, ...to.split("/")));
    state.renameA = !state.renameA;
    return [from, to];
  }
  if (event === "manifest-config-reconciliation") {
    write(root, "package.json", `${JSON.stringify({
      name: state.packageName,
      version: "1.0.0",
      scripts: { start: "node src/index.js", [`soak-${sequence}`]: "node src/content.ts" },
    }, null, 2)}\n`);
    return ["package.json"];
  }
  if (event === "no-op") return [];
  throw new Error(`Unknown soak event: ${event}.`);
}

async function runMode({ mode, binary, root, count = EVENTS_PER_MODE }) {
  createFixture(root, mode);
  const session = createNativeIncrementalSession({ command: binary, args: [] }, {
    cwd: ROOT,
    requestTimeoutMs: 60_000,
  });
  const native = createNativeCoreClient({ native: session, sourceAuthority: "rust" });
  const javascript = createJsCoreClient();
  const cacheDisabled = mode === "cache-disabled";
  const scanOptions = cacheDisabled ? { persistIdentity: false } : {};
  const profile = [];
  let graph = await native.scan(root, {
    ...scanOptions,
    onProfile: (entry) => profile.push(entry),
  });
  const state = {
    symbols: [],
    transient: false,
    renameA: true,
    packageName: `native-soak-${mode}`,
  };
  const events = [];
  let previousVersion = graph.state.graphVersion;
  const rssSampler = createNativeRssSampler(session);
  try {
    for (const [index, event] of eventSchedule(count).entries()) {
      const sequence = index + 1;
      const changedPaths = mutate(root, state, event, sequence);
      profile.length = 0;
      graph = await native.scan(root, {
        ...scanOptions,
        changedPaths,
        onProfile: (entry) => profile.push(entry),
      });
      const oracle = javascript.scan(root, {
        persistIdentity: !cacheDisabled,
        ...(cacheDisabled ? { sessionProjectId: graph.project.projectId } : {}),
      });
      const nativeDigest = createCoreCompatibilityDigest(graph);
      const javascriptDigest = createCoreCompatibilityDigest(oracle);
      if (nativeDigest !== javascriptDigest) {
        throw new Error(`${mode} soak parity diverged at event ${sequence} (${event}).`);
      }
      if (event === "no-op") {
        if (graph.state.graphVersion !== previousVersion) {
          throw new Error(`${mode} no-op unexpectedly advanced graph version.`);
        }
      } else if (graph.state.graphVersion <= previousVersion) {
        throw new Error(`${mode} changed event did not advance graph version.`);
      }
      previousVersion = graph.state.graphVersion;
      if (cacheDisabled && fs.existsSync(path.join(root, ".flopeek"))) {
        throw new Error("Cache-disabled soak wrote repository metadata.");
      }
      if (!cacheDisabled
        && (fs.existsSync(path.join(root, ".flopeek", "graph.json"))
          || !fs.existsSync(path.join(root, ".flopeek", "native-core.sqlite3")))) {
        throw new Error("Persistent soak violated SQLite-only native authority.");
      }
      if (global.gc && sequence % 25 === 0) global.gc();
      const lifecycle = profile.findLast((entry) => entry.phase === "native-core-lifecycle-profile") || null;
      if (cacheDisabled
        && (!Number.isSafeInteger(lifecycle?.sessionHistoryLimit)
          || lifecycle.retainedSessionGraphs > lifecycle.sessionHistoryLimit)) {
        throw new Error("Cache-disabled session history exceeded its declared bound.");
      }
      const nodeRssBytes = process.memoryUsage().rss;
      const rustRssBytes = await rssSampler.sample();
      events.push({
        sequence,
        event,
        changedPaths,
        graphVersion: graph.state.graphVersion,
        compatibilityDigest: nativeDigest,
        nodeRssBytes,
        rustRssBytes,
        combinedRssBytes: nodeRssBytes + rustRssBytes,
        sqlite: sqliteSizes(root),
        sessionHistory: cacheDisabled ? {
          limit: lifecycle.sessionHistoryLimit,
          retained: lifecycle.retainedSessionGraphs,
          expiredThroughVersion: lifecycle.expiredThroughVersion ?? null,
        } : null,
      });
    }
  } finally {
    await rssSampler.close();
    await native.close();
  }
  const combined = plateauEvidence(events.map((event) => event.combinedRssBytes));
  const node = plateauEvidence(events.map((event) => event.nodeRssBytes));
  const rust = plateauEvidence(events.map((event) => event.rustRssBytes));
  const eventCounts = Object.fromEntries([...new Set(EVENT_BLOCK)]
    .map((event) => [event, events.filter((entry) => entry.event === event).length]));
  return {
    mode,
    events: events.length,
    eventCounts,
    graphVersion: events.at(-1).graphVersion,
    rssPlateau: { combined, node, rust },
    raw: events,
    assertions: {
      exactParityEveryEvent: true,
      staleEdgesObserved: false,
      dualAuthorityObserved: false,
      unhandledProcessDeath: false,
      boundedSessionHistory: cacheDisabled
        ? events.every((event) => event.sessionHistory.retained <= event.sessionHistory.limit)
        : true,
      rssPlateau: combined.plateau && node.plateau && rust.plateau,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const binary = path.resolve(argument(argv, "--binary") || "");
  const output = argument(argv, "--output");
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile() || !output) {
    throw new Error("Usage: verify-native-soak --binary <exact candidate binary> --output <json>.");
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-soak-"));
  try {
    const modes = [];
    for (const mode of ["persistent", "cache-disabled"]) {
      modes.push(await runMode({
        mode,
        binary,
        root: path.join(sandbox, mode),
      }));
    }
    const passed = modes.every((mode) => mode.assertions.rssPlateau);
    const evidence = {
      schemaVersion: SCHEMA,
      generatedAt: new Date().toISOString(),
      binarySha256: sha256(fs.readFileSync(binary)),
      eventMix: {
        "content-only-edit": "50%",
        "symbol-addition": "15%",
        "symbol-removal": "10%",
        "file-add-delete": "10%",
        rename: "5%",
        "manifest-config-reconciliation": "5%",
        "no-op": "5%",
      },
      modes,
      summary: {
        modes: modes.length,
        totalRefreshEvents: modes.reduce((total, mode) => total + mode.events, 0),
        status: passed ? "passed" : "blocked",
      },
    };
    const resolved = path.resolve(output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`);
    if (!passed) {
      throw new Error("Native soak RSS did not reach a bounded plateau; raw blocked evidence was retained.");
    }
    process.stdout.write(`Verified ${evidence.summary.totalRefreshEvents} candidate-bound soak refresh events.\n`);
    return evidence;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Native soak blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EVENTS_PER_MODE,
  EVENT_BLOCK,
  SCHEMA,
  eventSchedule,
  plateauEvidence,
  runMode,
};
