"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NativeProtocolClient } = require("../../src/native-protocol-client");
const { createRepositoryScanner } = require("../../src/scanner");
const { createStructuralFactBatch } = require("../../src/structural-fact-adapter-host");
const { getAdapterRegistry } = require("../../src/adapter-registry");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST = path.join(ROOT, "native", "flopeek-core", "Cargo.toml");

test("persistent native protocol client preserves one session and reports typed errors", async (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-protocol-client-"));
  const client = new NativeProtocolClient({
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", MANIFEST, "--"],
    cwd: ROOT,
    requestTimeoutMs: 120_000,
  });
  context.after(async () => {
    await client.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const [firstStart, secondStart] = await Promise.all([client.start(), client.start()]);
  assert.equal(firstStart, client);
  assert.equal(secondStart, client);
  const startStats = client.getLastStartStats();
  assert.ok(startStats.spawnedMilliseconds >= 0);
  assert.ok(startStats.readyMilliseconds >= startStats.spawnedMilliseconds);
  assert.equal(startStats.healthRequestId, "native-1");
  await client.start();
  assert.equal(client.getLastStartStats().healthRequestId, "native-1");
  const health = await client.request("health");
  assert.equal(health.implementation, "rust");
  assert.equal(health.publicNodeIdsEnabled, true);
  assert.deepEqual(health.adapterCapabilities, getAdapterRegistry());
  assert.deepEqual(client.getLastResponseStats().requestId, "native-2");
  assert.ok(client.getLastResponseStats().requestBytes > 0);
  assert.ok(client.getLastResponseStats().responseBytes > 0);
  assert.ok(client.getLastResponseStats().parseMilliseconds >= 0);
  const initialized = await client.request("initialize", { projectRoot });
  assert.equal(initialized.store.relativePath, ".flopeek/native-core.sqlite3");
  assert.equal(initialized.storeAuthoritative, false);
  assert.ok(fs.existsSync(path.join(projectRoot, ".flopeek", "native-core.sqlite3")));
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "native-protocol-fixture" }), "utf8");
  fs.writeFileSync(path.join(projectRoot, "src", "orders.ts"), [
    "import { PrismaClient } from '@prisma/client';",
    "import { helper } from './helpers';",
    "const prisma = new PrismaClient();",
    "export function submit() { helper(); prisma.order.create({ data: {} }); }",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(projectRoot, "src", "helpers.ts"), "export function helper() {}\n", "utf8");
  const scanner = createRepositoryScanner(projectRoot, { persistIdentity: false });
  const graph = scanner.scan();
  const batch = createStructuralFactBatch(graph, scanner.snapshotRecords());
  const receipt = await client.request("submitStructuralFacts", batch);
  assert.equal(receipt.acceptedRecords, graph.stats.scannedFiles);
  assert.equal(receipt.stored, false);
  assert.equal(receipt.factsDigest, batch.factsDigest);
  const shadow = await client.request("assembleStructuralGraph", batch);
  assert.equal(shadow.schemaVersion, "flopeek-native-structural-graph-shadow/v1");
  const shadowNodeIds = shadow.nodes.map((node) => node.id).sort();
  const jsNodeIds = graph.nodes.filter((node) => ["file", "symbol", "endpoint", "integration", "external"].includes(node.kind)).map((node) => node.id).sort();
  assert.deepEqual(shadowNodeIds, jsNodeIds);
  const shadowEdges = shadow.edges.map((edge) => `${edge.type}\0${edge.source}\0${edge.target}`).sort();
  const shadowIds = new Set(shadowNodeIds);
  const jsEdges = graph.edges
    .filter((edge) => ["contains", "declares", "handles", "imports", "initializes", "calls", "queries", "queues", "requests", "uses"].includes(edge.type) && shadowIds.has(edge.source) && shadowIds.has(edge.target))
    .map((edge) => `${edge.type}\0${edge.source}\0${edge.target}`)
    .sort();
  assert.deepEqual(shadowEdges, jsEdges);
  await assert.rejects(() => client.request("scan"), { code: "unknown-method" });
});

test("native protocol abort terminates the isolated process and permits a clean session restart", async (context) => {
  const client = new NativeProtocolClient({
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", MANIFEST, "--"],
    cwd: ROOT,
    requestTimeoutMs: 120_000,
  });
  context.after(() => client.close());
  await client.start();
  assert.equal(await client.abort("test cancellation"), true);
  assert.equal(await client.abort("already stopped"), false);
  await client.start();
  const health = await client.request("health");
  assert.equal(health.implementation, "rust");
});
