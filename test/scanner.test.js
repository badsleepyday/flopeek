const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { createRepositoryScanner, graphToMermaid, readGraphCache, saveDescription, scanRepository, writeGraphCache } = require("../src/scanner");
const { benchmarkRepository } = require("../src/benchmark");
const { checkoutArguments, parseArguments: parseCorpusArguments, renameWithRetry, resolveCorpusRepositories, revisionMatches, scanRepositoryWithTimeout, scoreFocus, validateRealRepositoryCorpus } = require("../src/real-repository-corpus");
const { compareGitSnapshots, createGitSnapshot } = require("../src/history");
const { getChangeImpact, getChangedContexts, getContextCard, getFlowComparison, getFlowContextCard, getFlowProjection, getRelatedImplementations, projectView, resolveContextRef } = require("../src/graph-service");
const { startServer, watchRepository } = require("../src/server");
const { GraphCacheError, atomicWriteJson, readGraphCacheResult } = require("../src/graph-cache");
const { GraphSchemaError, parseGraphCache } = require("../src/graph-schema");
const { readGraphDelta, readGraphStateResult } = require("../src/graph-state");
const { createContextRef } = require("../src/context-card");
const { createFlowProjection } = require("../src/flow-lens");
const { createSemanticFlowSuggestion } = require("../src/semantic-flow-suggestion");
const { createMcpServer } = require("../src/mcp");
const { selectLatestSdk } = require("../src/csharp-adapter");

// This is an integration-test scheduling deadline, not a product latency guarantee.
const SSE_INTEGRATION_DEADLINE_MS = 15_000;

const GO_TOOLCHAIN_AVAILABLE = (() => {
  try {
    execFileSync(process.platform === "win32" ? "go.exe" : "go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const CSHARP_TOOLCHAIN_AVAILABLE = (() => {
  try {
    execFileSync(process.platform === "win32" ? "dotnet.exe" : "dotnet", ["--info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function write(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function readSseEvent(reader, predicate, timeoutMs = SSE_INTEGRATION_DEADLINE_MS) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(deadline - Date.now(), 1);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for an SSE event.")), remaining);
      reader.read().then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    if (result.done) throw new Error("SSE stream closed before the expected event.");
    buffer += decoder.decode(result.value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = raw.split("\n").reduce((value, line) => {
        if (line.startsWith("event: ")) value.event = line.slice(7);
        if (line.startsWith("data: ")) value.data += line.slice(6);
        return value;
      }, { event: "message", data: "" });
      if (predicate(event)) return event;
    }
  }
  throw new Error("Timed out waiting for an SSE event.");
}

function createSseEventReader(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(predicate, timeoutMs = SSE_INTEGRATION_DEADLINE_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = Math.max(deadline - Date.now(), 1);
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out waiting for an SSE event.")), remaining);
          reader.read().then((value) => {
            clearTimeout(timer);
            resolve(value);
          }, (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        if (result.done) throw new Error("SSE stream closed before the expected event.");
        buffer += decoder.decode(result.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = raw.split("\n").reduce((value, line) => {
            if (line.startsWith("event: ")) value.event = line.slice(7);
            if (line.startsWith("data: ")) value.data += line.slice(6);
            return value;
          }, { event: "message", data: "" });
          if (predicate(event)) return event;
        }
      }
      throw new Error("Timed out waiting for an SSE event.");
    },
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reserveLoopbackPort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await wait(35);
  }
  throw new Error("Timed out waiting for the expected Flopeek state.");
}

async function assertNoSseEvent(reader, predicate, timeoutMs = 600) {
  try {
    await reader.next(predicate, timeoutMs);
  } catch (error) {
    assert.equal(error.message, "Timed out waiting for an SSE event.");
    return;
  }
  assert.fail("Received an unexpected SSE event.");
}

function writeBoundedActiveFixture(root, fileCount = 48, functionsPerFile = 150) {
  write(root, "package.json", JSON.stringify({ name: "bounded-active-fixture" }));
  const declarations = Array.from({ length: functionsPerFile }, (_, index) => `export function step${index}() { return ${index}; }`).join("\n");
  for (let index = 0; index < fileCount; index += 1) write(root, `src/generated-${index}.ts`, declarations);
}

test("scanner builds an endpoint-to-service flow and finds related tests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-flow-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "checkout-example" }));
    write(root, "src/checkout/checkout.routes.ts", "import { CheckoutController } from './checkout.controller';\nrouter.post('/checkout', CheckoutController.create);");
    write(root, "src/checkout/checkout.controller.ts", "import { PaymentService } from '../payment/payment.service';\nexport class CheckoutController { static create() { return PaymentService.authorize(); } }");
    write(root, "src/payment/payment.service.ts", "import { PaymentRepository } from './payment.repository';\nimport Stripe from 'stripe';\nexport class PaymentService { static authorize() { return PaymentRepository.save(); } }");
    write(root, "src/payment/payment.repository.ts", "export class PaymentRepository { static save() {} }");
    write(root, "src/payment/payment.service.spec.ts", "import { PaymentService } from './payment.service';\ntest('authorizes', () => PaymentService.authorize());");

    const graph = scanRepository(root);
    const endpoint = graph.nodes.find((node) => node.kind === "endpoint" && node.label === "POST /checkout");
    const service = graph.nodes.find((node) => node.label === "Payment Service");
    const testNode = graph.nodes.find((node) => node.type === "test");
    assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length);
    assert.ok(graph.stats.classes >= 1);
    assert.ok(endpoint);
    assert.ok(service);
    assert.ok(testNode);
    assert.ok(graph.edges.some((edge) => edge.source === endpoint.id && edge.target.includes("checkout.routes")));
    assert.ok(graph.edges.some((edge) => edge.source === testNode.id && edge.target === service.id));
    assert.ok(graph.flows.some((flow) => flow.entryId === endpoint.id && flow.steps.some((step) => step.id === service.id)));
    const lens = getFlowProjection(graph, `flow:${endpoint.id}`);
    assert.equal(lens.schemaVersion, "flopeek-flow-lens/v1");
    assert.equal(lens.flow.entryId, endpoint.id);
    assert.match(lens.flow.contextRef, /^fp:\/\/local\/.+\/flow\//);
    assert.equal(lens.steps[0].role, "entry");
    assert.ok(lens.steps.some((step) => step.node.id === service.id && step.role === "orchestration"));
    assert.ok(lens.steps.every((step) => step.index === 1 || step.transition || lens.truncation.missingTransitionEvidence.includes(step.id)));
    assert.ok(lens.steps.filter((step) => step.transition).every((step) => step.transition.id.startsWith("edge:") && step.transition.evidence));
    assert.ok(lens.limitations.some((limitation) => limitation.includes("not a runtime trace")));
    assert.match(graphToMermaid(graph), /POST \/checkout/);
    const paymentService = graph.nodes.find((node) => node.kind === "symbol" && node.type === "class" && node.label === "PaymentService");
    assert.ok(paymentService);
    assert.ok(paymentService.methods.includes("authorize"));
    assert.ok(graph.edges.some((edge) => edge.source === paymentService.id && edge.target === service.id && edge.type === "declares"));
    const impact = getChangeImpact(graph, ["src/payment/payment.service.ts"]);
    assert.deepEqual(impact.matchedPaths, ["src/payment/payment.service.ts"]);
    assert.ok(impact.affectedEndpoints.some((node) => node.label === "POST /checkout"));
    assert.ok(impact.recommendedTests.some((node) => node.path === "src/payment/payment.service.spec.ts"));
    assert.ok(impact.dependencyNodes.some((node) => node.path === "src/payment/payment.repository.ts"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("literal package scripts create bounded command Flow Lenses and inventory unsupported shell forms", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-command-entry-"));
  try {
    write(root, "package.json", JSON.stringify({
      name: "command-entry-example",
      scripts: {
        serve: "node src/main.ts",
        composed: "node src/main.ts && node src/other.ts",
        flagged: "node --test src/main.ts",
        framework: "vite",
      },
    }));
    write(root, "src/main.ts", "import { save } from './store';\nexport function main() { return save(); }\nmain();");
    write(root, "src/store.ts", "export function save() { return 'saved'; }");

    const graph = scanRepository(root);
    const command = graph.nodes.find((node) => node.id === "command:package.json:serve");
    assert.ok(command);
    assert.equal(command.label, "npm run serve");
    assert.equal(command.analysis.parser, "package-json");
    assert.ok(graph.edges.some((edge) => edge.source === command.id && edge.type === "declares-command-target" && edge.target === "file:src/main.ts"));
    assert.deepEqual(graph.analysis.entryPoints.supported.packageScripts, [{
      id: command.id,
      manifest: "package.json",
      scriptName: "serve",
      runner: "node",
      targetPath: "src/main.ts",
      targetId: "file:src/main.ts",
    }]);
    assert.deepEqual(graph.analysis.entryPoints.unsupported.packageScripts.map((item) => [item.scriptName, item.reason]), [
      ["composed", "shell-syntax-or-quoting"],
      ["flagged", "not-a-direct-runner-and-source-target"],
      ["framework", "not-a-direct-runner-and-source-target"],
    ]);
    assert.equal(graph.analysis.entryPoints.unsupported.packageScripts.some((item) => Object.hasOwn(item, "command")), false);
    const entryMap = projectView(graph, { mode: "requests", scope: "application" });
    assert.ok(entryMap.nodes.some((node) => node.memberIds.includes(command.id)));
    assert.equal(entryMap.aiContext.projection.meaning.includes("command invocation"), true);
    assert.equal(entryMap.aiContext.entryPoints.supported.packageScripts[0].scriptName, "serve");
    assert.deepEqual(entryMap.aiContext.entryPoints.unsupported.packageScriptReasonCounts, {
      "not-a-direct-runner-and-source-target": 2,
      "shell-syntax-or-quoting": 1,
    });

    const flow = graph.flows.find((candidate) => candidate.entryId === command.id);
    assert.ok(flow);
    assert.equal(flow.entry.schemaVersion, "flopeek-static-flow-entry/v1");
    assert.equal(flow.entry.kind, "package-script");
    assert.equal(flow.entry.declaration.targetPath, "src/main.ts");
    const lens = getFlowProjection(graph, flow.id);
    assert.equal(lens.flow.entry.kind, "package-script");
    assert.equal(lens.steps[0].role, "command-entry");
    assert.equal(lens.steps[1].id, "file:src/main.ts");
    assert.equal(lens.entryEvidence.binding, "exact-literal-target");
    assert.equal(lens.handlerEvidence, null);
    assert.equal(lens.semanticSuggestion.status, "abstained");
    assert.equal(lens.flowInterface.boundary.kind, "package-script");
    assert.deepEqual(lens.flowInterface.boundary.command, {
      adapter: "package-script",
      manifest: "package.json",
      scriptName: "serve",
      commandName: null,
      runner: "node",
      targetPath: "src/main.ts",
      targetId: "file:src/main.ts",
    });
    const packet = getFlowContextCard(graph, flow.id);
    assert.equal(packet.card.flow.entry.kind, "package-script");
    assert.match(packet.card.technicalSummary.text, /package-script/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Django management commands create bounded command Flow Lenses without claiming registration or execution", () => {
  const fixture = path.join(__dirname, "fixtures", "django-management-command-flow");
  const graph = scanRepository(fixture, { persistIdentity: false });
  const command = graph.nodes.find((node) => node.entryKind === "django-management-command");
  assert.ok(command);
  assert.equal(command.label, "python manage.py rebuild_index");
  assert.equal(command.analysis.confidence, "exact");
  assert.ok(graph.edges.some((edge) => edge.source === command.id && edge.type === "declares-command-target" && edge.target === "symbol:polls/management/commands/rebuild_index.py:class:Command"));
  assert.deepEqual(graph.analysis.entryPoints.supported.djangoManagementCommands, [{
    id: command.id,
    path: "polls/management/commands/rebuild_index.py",
    commandName: "rebuild_index",
    targetPath: "polls/management/commands/rebuild_index.py",
    targetId: "symbol:polls/management/commands/rebuild_index.py:class:Command",
  }]);
  const flow = graph.flows.find((candidate) => candidate.entryId === command.id);
  assert.ok(flow);
  assert.equal(flow.entry.kind, "framework-command");
  const lens = getFlowProjection(graph, flow.id);
  assert.equal(lens.entryEvidence.binding, "exact-framework-command-target");
  assert.equal(lens.steps[0].role, "command-entry");
  assert.equal(lens.steps[1].id, "symbol:polls/management/commands/rebuild_index.py:class:Command");
  assert.equal(lens.flowInterface.boundary.kind, "framework-command");
  assert.deepEqual(lens.flowInterface.boundary.command, {
    adapter: "django",
    manifest: null,
    scriptName: null,
    commandName: "rebuild_index",
    runner: null,
    targetPath: "polls/management/commands/rebuild_index.py",
    targetId: "symbol:polls/management/commands/rebuild_index.py:class:Command",
  });
  assert.match(lens.limitations.join("\n"), /does not prove app registration/i);
  const packet = getFlowContextCard(graph, flow.id);
  assert.equal(packet.card.flow.entry.kind, "framework-command");
  assert.match(packet.card.technicalSummary.text, /framework-command/);
});

test("literal node-cron schedules create bounded scheduler Flow Lenses and inventory unsupported registrations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scheduled-entry-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "scheduled-entry-example" }));
    write(root, "src/jobs.ts", [
      'import cron from "node-cron";',
      'import { persistSnapshot } from "./store";',
      "export function refreshSnapshot() { return persistSnapshot(); }",
      'cron.schedule("0 * * * *", refreshSnapshot);',
      'cron.schedule("not a cron expression", refreshSnapshot);',
      'cron.schedule("0 * * * *", () => refreshSnapshot());',
      'function deferRegistration() { cron.schedule("0 * * * *", refreshSnapshot); }',
    ].join("\n"));
    write(root, "src/store.ts", "export function persistSnapshot() { return 'stored'; }");

    const graph = scanRepository(root);
    const schedule = graph.nodes.find((node) => node.kind === "schedule" && node.taskName === "refreshSnapshot");
    assert.ok(schedule);
    assert.equal(schedule.analysis.parser, "typescript-ast");
    assert.equal(schedule.analysis.status, "literal-node-cron-schedule");
    assert.ok(graph.edges.some((edge) => edge.source === schedule.id && edge.type === "schedules" && edge.target === "symbol:src/jobs.ts:function:refreshSnapshot"));
    assert.deepEqual(graph.analysis.entryPoints.supported.nodeCronSchedules, [{
      id: schedule.id,
      path: "src/jobs.ts",
      expression: "0 * * * *",
      taskName: "refreshSnapshot",
      targetPath: "src/jobs.ts",
      targetId: "symbol:src/jobs.ts:function:refreshSnapshot",
    }]);
    assert.deepEqual(graph.analysis.entryPoints.unsupported.nodeCronSchedules.map((item) => item.reason), [
      "non-literal-or-unsupported-cron-expression",
      "task-is-not-an-unshadowed-identifier",
      "registration-is-not-module-scope",
    ]);
    assert.equal(graph.analysis.entryPoints.unsupported.nodeCronSchedules.some((item) => Object.hasOwn(item, "expression")), false);

    const entryMap = projectView(graph, { mode: "requests", scope: "application" });
    assert.ok(entryMap.nodes.some((node) => node.memberIds.includes(schedule.id)));
    assert.equal(entryMap.aiContext.entryPoints.supported.nodeCronSchedules[0].taskName, "refreshSnapshot");
    assert.deepEqual(entryMap.aiContext.entryPoints.unsupported.nodeCronScheduleReasonCounts, {
      "non-literal-or-unsupported-cron-expression": 1,
      "registration-is-not-module-scope": 1,
      "task-is-not-an-unshadowed-identifier": 1,
    });

    const flow = graph.flows.find((candidate) => candidate.entryId === schedule.id);
    assert.ok(flow);
    assert.equal(flow.entry.schemaVersion, "flopeek-static-flow-entry/v1");
    assert.equal(flow.entry.kind, "scheduled-task");
    assert.equal(flow.entry.declaration.expression, "0 * * * *");
    const lens = getFlowProjection(graph, flow.id);
    assert.equal(lens.steps[0].role, "scheduled-entry");
    assert.equal(lens.steps[1].id, "symbol:src/jobs.ts:function:refreshSnapshot");
    assert.equal(lens.entryEvidence.binding, "exact-local-task");
    assert.equal(lens.handlerEvidence, null);
    assert.equal(lens.semanticSuggestion.status, "abstained");
    assert.equal(lens.flowInterface.boundary.kind, "scheduled-task");
    assert.deepEqual(lens.flowInterface.boundary.schedule, {
      adapter: "node-cron",
      expression: "0 * * * *",
      taskName: "refreshSnapshot",
      targetPath: "src/jobs.ts",
    });
    assert.deepEqual(lens.flowInterface.boundary.task, {
      status: "available",
      id: "symbol:src/jobs.ts:function:refreshSnapshot",
      evidenceClass: "parser-fact",
    });
    const packet = getFlowContextCard(graph, flow.id);
    assert.equal(packet.card.flow.entry.kind, "scheduled-task");
    assert.match(packet.card.technicalSummary.text, /scheduled-task/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI summary separates supported static entry families", () => {
  const fixture = path.join(__dirname, "fixtures", "node-cron-schedule-flow");
  const output = execFileSync(process.execPath, [path.join(__dirname, "..", "src", "cli.js"), "scan", fixture, "--no-cache", "--format", "summary"], { encoding: "utf8" });
  assert.match(output, /0 HTTP entries \/ 0 command entries \/ 1 scheduled entries/);
});

test("literal package script flows retain HTTP Context Ref and Viewer-entry parity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-command-entry-server-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "command-entry-server-example", scripts: { serve: "node src/main.ts" } }));
    write(root, "src/main.ts", "import { save } from './store';\nexport function main() { return save(); }\nmain();");
    write(root, "src/store.ts", "export function save() { return 'saved'; }");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const catalog = await (await fetch(`${baseUrl}/api/entry-flows?query=serve`)).json();
    assert.equal(catalog.entryFamilies.command, 1);
    assert.equal(catalog.flows.length, 1);
    const flow = catalog.flows[0];
    assert.equal(flow.entry.kind, "package-script");
    const lens = await (await fetch(`${baseUrl}/api/flow-lens?flow=${encodeURIComponent(flow.id)}`)).json();
    assert.equal(lens.flow.entry.declaration.runner, "node");
    assert.equal(lens.steps[0].role, "command-entry");
    const packet = await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(flow.id)}`)).json();
    assert.equal(packet.card.contextRef, lens.flow.contextRef);
    assert.equal(packet.card.flow.entry.kind, "package-script");
    const resolution = await (await fetch(`${baseUrl}/api/context/resolve?ref=${encodeURIComponent(lens.flow.contextRef)}`)).json();
    assert.equal(resolution.status, "current");
    const viewer = await (await fetch(`${baseUrl}/api/view?mode=requests&scope=application`)).json();
    assert.ok(viewer.nodes.some((node) => node.memberIds.includes(flow.entryId)));
    assert.equal(viewer.aiContext.projection.meaning.includes("command invocation"), true);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("node-cron schedule entries retain Viewer, HTTP, and MCP flow parity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scheduled-entry-surfaces-"));
  let app;
  let client;
  let instance;
  try {
    write(root, "package.json", JSON.stringify({ name: "scheduled-entry-surface-example" }));
    write(root, "src/jobs.ts", [
      'import cron from "node-cron";',
      'import { persistSnapshot } from "./store";',
      "export function refreshSnapshot() { return persistSnapshot(); }",
      'cron.schedule("0 * * * *", refreshSnapshot);',
    ].join("\n"));
    write(root, "src/store.ts", "export function persistSnapshot() { return 'stored'; }");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const httpCatalog = await (await fetch(`${baseUrl}/api/entry-flows?query=refresh`)).json();
    assert.equal(httpCatalog.entryFamilies.scheduler, 1);
    const httpFlow = httpCatalog.flows[0];
    assert.equal(httpFlow.entry.kind, "scheduled-task");
    const httpLens = await (await fetch(`${baseUrl}/api/flow-lens?flow=${encodeURIComponent(httpFlow.id)}`)).json();
    assert.equal(httpLens.entryEvidence.binding, "exact-local-task");
    assert.equal(httpLens.steps[0].role, "scheduled-entry");
    const viewer = await (await fetch(`${baseUrl}/api/view?mode=requests&scope=application`)).json();
    assert.ok(viewer.nodes.some((node) => node.memberIds.includes(httpFlow.entryId)));

    instance = await createMcpServer({ root, cache: true });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "flopeek-scheduler-entry-client", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const mcpResult = await client.callTool({ name: "get_entry_flows", arguments: { query: "refresh" } });
    assert.equal(mcpResult.isError, undefined);
    const mcpCatalog = JSON.parse(mcpResult.content.find((item) => item.type === "text").text);
    assert.equal(mcpCatalog.entryFamilies.scheduler, 1);
    assert.equal(mcpCatalog.flows[0].id, httpFlow.id);
    assert.equal(mcpCatalog.flows[0].entry.kind, httpFlow.entry.kind);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Flow Lens keeps static branches, boundaries, and display bounds explicit", () => {
  const node = (id, type, depth) => ({ id, label: id, type, kind: type === "endpoint" ? "endpoint" : "file", path: `src/${id}.ts`, analysis: { confidence: "exact" }, depth });
  const nodes = [
    node("GET /orders", "endpoint", 0), node("routes", "route", 1), node("orders", "service", 2),
    node("orders-db", "database", 3), node("orders-queue", "queue", 3), node("supplier", "external", 3),
    ...Array.from({ length: 18 }, (_, index) => node(`continuation-${index + 1}`, "module", index + 4)),
  ];
  const edges = [
    { source: "GET /orders", target: "routes", type: "handles", confidence: "exact", evidence: { file: "src/routes.ts" } },
    { source: "routes", target: "orders", type: "imports", confidence: "exact", evidence: { file: "src/routes.ts" } },
    { source: "orders", target: "orders-db", type: "uses", confidence: "exact", evidence: { file: "src/orders.ts" } },
    { source: "orders", target: "orders-queue", type: "uses", confidence: "exact", evidence: { file: "src/orders.ts" } },
    { source: "orders", target: "supplier", type: "requests", confidence: "exact", evidence: { file: "src/orders.ts" } },
    ...Array.from({ length: 18 }, (_, index) => ({ source: index ? `continuation-${index}` : "orders-db", target: `continuation-${index + 1}`, type: "uses", confidence: "exact", evidence: { file: "src/orders.ts" } })),
  ];
  const graph = {
    project: { projectId: "project:flow-lens-test" },
    state: { graphVersion: 7 },
    nodes,
    edges,
  };
  const flow = { id: "flow:orders", title: "GET /orders", entryId: "GET /orders", steps: nodes.map((item) => ({ id: item.id, label: item.label, type: item.type, depth: item.depth })) };
  const lens = createFlowProjection(graph, flow);
  const expandedLens = createFlowProjection(graph, flow, { maxSteps: 24 });
  assert.equal(lens.steps.length, 12);
  assert.equal(lens.truncation.requestedMaxSteps, 12);
  assert.equal(lens.truncation.displayTruncated, true);
  assert.equal(lens.truncation.displayTruncationReason, "requested-step-limit-reached");
  assert.equal(lens.truncation.sourceTraversalStepBound, 24);
  assert.equal(expandedLens.steps.length, nodes.length);
  assert.equal(expandedLens.truncation.requestedMaxSteps, 24);
  assert.equal(expandedLens.truncation.displayTruncated, false);
  assert.equal(expandedLens.truncation.displayTruncationReason, null);
  assert.equal(expandedLens.truncation.sourceTraversalMayBeTruncated, true);
  assert.equal(expandedLens.truncation.sourceTraversalTruncationReason, "source-traversal-bound-reached");
  assert.equal(lens.steps.find((step) => step.id === "orders").branch.kind, "fan-out");
  assert.deepEqual(lens.staticBoundaries.map((boundary) => boundary.category).sort(), ["async", "external", "persistence"]);
  assert.ok(lens.steps.slice(1).every((step) => step.transition || lens.truncation.missingTransitionEvidence.includes(step.id)));
  assert.equal(lens.verification, null);
  assert.match(lens.limitations[0], /not a runtime trace/);
  for (const maxSteps of [0, 25, 1.5, "12"]) assert.throws(() => createFlowProjection(graph, flow, { maxSteps }), /integer from 1 through 24/);
});

test("scanner profiling reports bounded phases without changing graph evidence", () => {
  const profile = [];
  const graph = scanRepository(path.join(__dirname, "fixtures", "typescript-order-flow"), { persistIdentity: false, onProfile: (entry) => profile.push(entry) });
  assert.deepEqual(profile.map((entry) => entry.phase), ["scope-and-identity", "source-analysis", "resolver-context", "graph-assembly"]);
  assert.equal(profile.every((entry) => Number.isFinite(entry.milliseconds) && entry.milliseconds >= 0), true);
  assert.equal(graph.flows.some((flow) => flow.title === "POST /orders"), true);
  assert.equal(Object.hasOwn(graph.analysis, "performance"), false);
});

test("graph reports machine-readable parser coverage for mixed-language repositories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-coverage-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "coverage-example" }));
    write(root, "src/handler.ts", "export const handler = () => 'ok';");
    write(root, "cmd/server.go", "package main\nfunc main() {}\n");

    const graph = scanRepository(root);
    assert.equal(graph.schemaVersion, 5);
    assert.deepEqual(graph.analysis.coverage.summary, {
      scannedFiles: 2,
      parsedFiles: GO_TOOLCHAIN_AVAILABLE ? 2 : 1,
      parsedWithDiagnosticsFiles: 0,
      inventoryOnlyFiles: GO_TOOLCHAIN_AVAILABLE ? 0 : 1,
      parseFailedFiles: 0,
    });
    const go = graph.analysis.coverage.byLanguage.find((language) => language.language === "go");
    assert.deepEqual(go, GO_TOOLCHAIN_AVAILABLE
      ? { language: "go", files: 1, parsed: 1, parsedWithDiagnostics: 0, inventoryOnly: 0, parseFailed: 0, parsers: ["go-parser"] }
      : { language: "go", files: 1, parsed: 0, parsedWithDiagnostics: 0, inventoryOnly: 1, parseFailed: 0, parsers: ["inventory"] });
    assert.match(graph.analysis.coverage.interpretation, /not runtime execution coverage/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("C# Roslyn analysis extracts usings, class declarations, and methods", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-csharp-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "csharp-example" }));
    write(root, "src/OrdersService.cs", "using System;\nusing Acme.Data;\nnamespace Acme; public class OrdersService { public void Submit() {} private int Count() => 1; }");
    const graph = scanRepository(root);
    const file = graph.nodes.find((node) => node.id === "file:src/OrdersService.cs");
    const service = graph.nodes.find((node) => node.id === "symbol:src/OrdersService.cs:class:OrdersService");
    if (!CSHARP_TOOLCHAIN_AVAILABLE) {
      assert.equal(file.analysis.parser, "inventory");
      assert.equal(file.analysis.status, "inventory-only");
      assert.equal(service, undefined);
      assert.equal(graph.nodes.some((node) => node.id === "external:System"), false);
      return;
    }
    assert.equal(file.analysis.parser, "csharp-roslyn");
    assert.equal(file.analysis.status, "parsed");
    assert.deepEqual(service.methods, ["Submit", "Count"]);
    assert.ok(graph.nodes.some((node) => node.id === "external:System"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("C# helper selects the newest installed SDK numerically", () => {
  assert.equal(selectLatestSdk(["9.0.400", "10.0.100", "10.0.302", "preview"]), "10.0.302");
  assert.equal(selectLatestSdk(["10.0.300-preview.1", "10.0.300"]), "10.0.300");
  assert.equal(selectLatestSdk(["invalid", "preview"]), null);
});

test("PHP AST analysis extracts use imports, declarations, methods, and direct local calls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-php-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "php-example" }));
    write(root, "src/OrdersService.php", `<?php
namespace App\\Services;
use App\\Support\\Audit;
use Vendor\\Queue as Jobs;

class OrdersService {
  public function submit(string $id): void {
    record($id);
    Audit::record($id);
    Jobs::push($id);
  }
  private function save(string $id): void {}
}

interface Persists { public function persist(): void; }
trait HasAudit { public function audit(): void {} }
enum QueueState { case Ready; }
function record(string $id): string { return $id; }
`);
    const graph = scanRepository(root);
    const file = graph.nodes.find((node) => node.id === "file:src/OrdersService.php");
    const service = graph.nodes.find((node) => node.id === "symbol:src/OrdersService.php:class:OrdersService");
    const record = graph.nodes.find((node) => node.id === "symbol:src/OrdersService.php:function:record");
    assert.equal(file.analysis.parser, "php-parser");
    assert.equal(file.analysis.status, "parsed");
    assert.deepEqual(service.methods, ["submit", "save"]);
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/OrdersService.php:class:Persists"));
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/OrdersService.php:class:HasAudit"));
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/OrdersService.php:class:QueueState"));
    assert.ok(graph.nodes.some((node) => node.id === "external:App"));
    assert.ok(graph.nodes.some((node) => node.id === "external:Vendor"));
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === service.id && edge.target === record.id && edge.confidence === "exact"));
    assert.ok(graph.analysis.capabilities.some((capability) => capability.parser === "php-parser"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Tree-sitter Java analysis extracts imports, types, and methods without a JDK", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-java-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "java-example" }));
    write(root, "src/OrdersService.java", `package com.acme.orders;
import java.util.List;
import com.acme.audit.Audit;
public class OrdersService { public void submit(String id) {} private int count() { return 1; } }
interface Store { void save(); }
`);
    const graph = scanRepository(root);
    const file = graph.nodes.find((node) => node.id === "file:src/OrdersService.java");
    const service = graph.nodes.find((node) => node.id === "symbol:src/OrdersService.java:class:OrdersService");
    assert.equal(file.analysis.parser, "tree-sitter-java");
    assert.equal(file.analysis.status, "parsed");
    assert.deepEqual(service.methods, ["submit", "count"]);
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/OrdersService.java:class:Store"));
    assert.ok(graph.nodes.some((node) => node.id === "external:com.acme.audit.Audit"));
    assert.equal(graph.nodes.some((node) => node.id === "external:java.util.List"), false);
    assert.ok(graph.analysis.capabilities.some((capability) => capability.parser === "tree-sitter-java"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Tree-sitter Java resolves only unqualified unique local static method calls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-java-static-calls-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "java-static-call-example" }));
    write(root, "src/Orders.java", `public class Orders {
  public static void submit(String id) { validate(id); Orders.validate(id); }
  private static void validate(String id) {}
  public static void maybe() { overloaded("value"); }
  private static void overloaded(String value) {}
  private static void overloaded(int value) {}
  public void dispatch() { validate("instance"); }
}
`);
    const graph = scanRepository(root);
    const submit = graph.nodes.find((node) => node.id === "symbol:src/Orders.java:function:Orders.submit");
    const validate = graph.nodes.find((node) => node.id === "symbol:src/Orders.java:function:Orders.validate");
    const maybe = graph.nodes.find((node) => node.id === "symbol:src/Orders.java:function:Orders.maybe");
    assert.ok(submit);
    assert.ok(validate);
    assert.ok(maybe);
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === submit.id && edge.target === validate.id && edge.confidence === "exact"));
    assert.equal(graph.edges.filter((edge) => edge.type === "calls" && edge.source === submit.id && edge.target === validate.id).length, 1);
    assert.equal(graph.nodes.some((node) => node.id === "symbol:src/Orders.java:function:Orders.overloaded"), false);
    assert.equal(graph.edges.some((edge) => edge.type === "calls" && edge.source === maybe.id), false);
    assert.ok(graph.analysis.calls.supported.includes("direct unqualified unique local static Java method calls"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Tree-sitter Rust analysis extracts types, methods, and direct local calls without Rust tooling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "rust-example" }));
    write(root, "src/orders.rs", `use std::collections::HashMap;
use crate::service::validate;
use serde::Serialize;

struct Orders;
trait Persists { fn persist(&self); }
impl Orders { fn submit(&self, id: &str) { validate(id); } fn save(&self) {} }
fn validate(id: &str) { let _ = id; }
`);
    const graph = scanRepository(root);
    const file = graph.nodes.find((node) => node.id === "file:src/orders.rs");
    const orders = graph.nodes.find((node) => node.id === "symbol:src/orders.rs:class:Orders");
    const validate = graph.nodes.find((node) => node.id === "symbol:src/orders.rs:function:validate");
    assert.equal(file.analysis.parser, "tree-sitter-rust");
    assert.equal(file.analysis.status, "parsed");
    assert.deepEqual(orders.methods, ["submit", "save"]);
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/orders.rs:class:Persists"));
    assert.ok(graph.nodes.some((node) => node.id === "external:serde"));
    assert.equal(graph.nodes.some((node) => node.id === "external:std" || node.id === "external:crate"), false);
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === orders.id && edge.target === validate.id && edge.confidence === "exact"));
    assert.ok(graph.analysis.capabilities.some((capability) => capability.parser === "tree-sitter-rust"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Tree-sitter Rust analysis does not require iterator helper methods", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-node20-"));
  const iteratorPrototype = Object.getPrototypeOf(new Map().values());
  const originalMap = Object.getOwnPropertyDescriptor(iteratorPrototype, "map");
  try {
    Object.defineProperty(iteratorPrototype, "map", { configurable: true, writable: true, value: undefined });
    write(root, "package.json", JSON.stringify({ name: "rust-node20-example" }));
    write(root, "src/orders.rs", "struct Orders;\nimpl Orders { fn submit(&self) {} }\n");
    const graph = scanRepository(root);
    const orders = graph.nodes.find((node) => node.id === "symbol:src/orders.rs:class:Orders");
    assert.deepEqual(orders.methods, ["submit"]);
  } finally {
    if (originalMap) Object.defineProperty(iteratorPrototype, "map", originalMap);
    else delete iteratorPrototype.map;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Rust crate, self, and super imports resolve to local modules and direct named calls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-rust-modules-"));
  try {
    write(root, "Cargo.toml", `[package]
name = "rust-module-example"
version = "0.1.0"
`);
    write(root, "src/lib.rs", `mod helpers;
mod area;
use crate::helpers::{parse as parse_value};

pub fn execute_root() { parse_value(); }
`);
    write(root, "src/helpers.rs", "pub fn parse() {}\n");
    write(root, "src/area/mod.rs", "pub mod child;\npub mod shared;\n");
    write(root, "src/area/child.rs", `mod local;
use super::shared::normalize;
use self::local::normalize as normalize_local;

pub fn execute_child() { normalize(); }
pub fn execute_self() { normalize_local(); }
`);
    write(root, "src/area/shared.rs", "pub fn normalize() {}\n");
    write(root, "src/area/child/local.rs", "pub fn normalize() {}\n");

    const graph = scanRepository(root);
    const rootFile = graph.nodes.find((node) => node.id === "file:src/lib.rs");
    const helpersFile = graph.nodes.find((node) => node.id === "file:src/helpers.rs");
    const childFile = graph.nodes.find((node) => node.id === "file:src/area/child.rs");
    const sharedFile = graph.nodes.find((node) => node.id === "file:src/area/shared.rs");
    const localFile = graph.nodes.find((node) => node.id === "file:src/area/child/local.rs");
    const executeRoot = graph.nodes.find((node) => node.id === "symbol:src/lib.rs:function:execute_root");
    const parse = graph.nodes.find((node) => node.id === "symbol:src/helpers.rs:function:parse");
    const executeChild = graph.nodes.find((node) => node.id === "symbol:src/area/child.rs:function:execute_child");
    const normalize = graph.nodes.find((node) => node.id === "symbol:src/area/shared.rs:function:normalize");
    const executeSelf = graph.nodes.find((node) => node.id === "symbol:src/area/child.rs:function:execute_self");
    const localNormalize = graph.nodes.find((node) => node.id === "symbol:src/area/child/local.rs:function:normalize");
    assert.ok(graph.edges.some((edge) => edge.type === "imports" && edge.source === rootFile.id && edge.target === helpersFile.id));
    assert.ok(graph.edges.some((edge) => edge.type === "imports" && edge.source === childFile.id && edge.target === sharedFile.id));
    assert.ok(graph.edges.some((edge) => edge.type === "imports" && edge.source === childFile.id && edge.target === localFile.id));
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === executeRoot.id && edge.target === parse.id && edge.confidence === "exact"));
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === executeChild.id && edge.target === normalize.id && edge.confidence === "exact"));
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === executeSelf.id && edge.target === localNormalize.id && edge.confidence === "exact"));
    assert.equal(graph.nodes.some((node) => node.id === "external:crate" || node.id === "external:super"), false);
    assert.ok(graph.analysis.resolution.internal.includes("static Rust crate/self/super modules in conventional Cargo src roots"));
    assert.ok(graph.analysis.calls.supported.includes("direct local Rust functions and named crate/self/super imports"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Tree-sitter Java and Rust parsers scan sources larger than their default bridge buffer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-large-tree-sitter-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "large-tree-sitter-example" }));
    const padding = "// padding that exceeds the default parser bridge buffer\n".repeat(800);
    write(root, "src/Large.java", `${padding}class Large { void scan() {} }\n`);
    write(root, "src/large.rs", `${padding}fn scan() {}\n`);
    const graph = scanRepository(root);
    assert.equal(graph.nodes.find((node) => node.id === "file:src/Large.java").analysis.status, "parsed");
    assert.equal(graph.nodes.find((node) => node.id === "file:src/large.rs").analysis.status, "parsed");
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/Large.java:class:Large"));
    assert.ok(graph.nodes.some((node) => node.id === "symbol:src/large.rs:function:scan"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Go parser extracts structural facts without interpreting comments or executing source", { skip: !GO_TOOLCHAIN_AVAILABLE }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-go-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "go-example" }));
    write(root, "cmd/server.go", `package main

import (
  "net/http"
  "github.com/acme/clock"
)

// import "fake/comment" and func fake() {} are comments, not facts.
const note = "func fake() {}"

type Server struct{}
type Health interface { Check() error }

func (server *Server) Handle(_ http.ResponseWriter) {}
func main() { _ = clock.Now }
`);

    const graph = scanRepository(root);
    const file = graph.nodes.find((node) => node.id === "file:cmd/server.go");
    const server = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:class:Server");
    const health = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:class:Health");
    const handle = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:Server.Handle");
    const main = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:main");
    const clock = graph.nodes.find((node) => node.id === "external:github.com");

    assert.equal(file.analysis.parser, "go-parser");
    assert.equal(file.analysis.status, "parsed");
    assert.deepEqual(server.methods, ["Handle"]);
    assert.ok(health);
    assert.ok(handle);
    assert.ok(main);
    assert.ok(clock);
    assert.ok(graph.edges.some((edge) => edge.source === file.id && edge.target === clock.id && edge.type === "uses" && edge.evidence.parser === "go-parser"));
    assert.equal(graph.nodes.some((node) => node.id === "external:fake"), false);
    assert.equal(graph.nodes.some((node) => node.id === "external:net"), false);
    assert.ok(graph.analysis.capabilities.some((capability) => capability.parser === "go-parser"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incremental Go scans reparse only the changed source file", { skip: !GO_TOOLCHAIN_AVAILABLE }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-go-incremental-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "go-incremental" }));
    write(root, "cmd/api.go", "package main\ntype API struct{}\nfunc (api *API) Serve() {}\n");
    write(root, "cmd/worker.go", "package main\nfunc RunWorker() {}\n");

    const scanner = createRepositoryScanner(root);
    scanner.scan();
    write(root, "cmd/api.go", "package main\ntype API struct{}\nfunc (api *API) Serve() {}\nfunc (api *API) Health() {}\n");
    const graph = scanner.scan(["cmd/api.go"]);
    const api = graph.nodes.find((node) => node.id === "symbol:cmd/api.go:class:API");

    assert.equal(graph.analysis.refresh.mode, "incremental");
    assert.equal(graph.analysis.refresh.analyzedFiles, 1);
    assert.equal(graph.analysis.refresh.reusedFiles, 1);
    assert.deepEqual(api.methods, ["Serve", "Health"]);
    assert.ok(graph.nodes.some((node) => node.id === "symbol:cmd/worker.go:function:RunWorker"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("static Go modules resolve only unique internal package files and refresh after Go changes", { skip: !GO_TOOLCHAIN_AVAILABLE }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-go-modules-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "go-modules" }));
    write(root, "go.mod", "module example.com/acme/inventory\n\ngo 1.25\n");
    write(root, "cmd/server.go", `package main

import "example.com/acme/inventory/internal/catalog"

func main() { catalog.Load() }
`);
    write(root, "internal/catalog/catalog.go", "package catalog\nfunc Load() {}\n");

    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    const server = first.nodes.find((node) => node.id === "file:cmd/server.go");
    const catalog = first.nodes.find((node) => node.id === "file:internal/catalog/catalog.go");
    const main = first.nodes.find((node) => node.id === "symbol:cmd/server.go:function:main");
    const load = first.nodes.find((node) => node.id === "symbol:internal/catalog/catalog.go:function:Load");
    assert.ok(first.edges.some((edge) => edge.source === server.id && edge.target === catalog.id && edge.type === "imports"));
    assert.ok(first.edges.some((edge) => edge.source === main.id && edge.target === load.id && edge.type === "calls"));
    assert.equal(first.nodes.some((node) => node.id === "external:example.com"), false);

    write(root, "internal/catalog/helpers.go", "package catalog\nfunc Validate() {}\n");
    const second = scanner.scan(["internal/catalog/helpers.go"]);
    const catalogPackage = second.nodes.find((node) => node.id === "go-package:internal/catalog");
    const helper = second.nodes.find((node) => node.id === "file:internal/catalog/helpers.go");
    assert.equal(second.analysis.refresh.mode, "incremental");
    assert.equal(second.analysis.refresh.analyzedFiles, 1);
    assert.ok(catalogPackage);
    assert.ok(second.edges.some((edge) => edge.source === server.id && edge.target === catalogPackage.id && edge.type === "imports"));
    assert.ok(second.edges.some((edge) => edge.source === catalogPackage.id && edge.target === catalog.id && edge.type === "contains"));
    assert.ok(second.edges.some((edge) => edge.source === catalogPackage.id && edge.target === helper.id && edge.type === "contains"));
    assert.ok(second.edges.some((edge) => edge.source === main.id && edge.target === load.id && edge.type === "calls"));
    assert.equal(second.nodes.some((node) => node.id === "external:example.com"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Go direct calls connect only unshadowed local functions and resolved package selectors", { skip: !GO_TOOLCHAIN_AVAILABLE }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-go-calls-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "go-calls" }));
    write(root, "go.mod", "module example.com/acme/calls\n\ngo 1.25\n");
    write(root, "internal/clock/clock.go", "package clock\nfunc Now() {}\n");
    write(root, "cmd/server.go", `package main

import clock "example.com/acme/calls/internal/clock"

type Server struct{}

func validate() {}
func Boot() { validate(); clock.Now() }
func Shadowed(validate func()) { validate() }
func Masked() { validate := func() {}; validate() }
func (server *Server) Handle() {}
func (server *Server) Run() { server.Handle(); validate() }
`);

    const graph = scanRepository(root);
    const boot = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:Boot");
    const validate = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:validate");
    const shadowed = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:Shadowed");
    const masked = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:Masked");
    const run = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:Server.Run");
    const handle = graph.nodes.find((node) => node.id === "symbol:cmd/server.go:function:Server.Handle");
    const now = graph.nodes.find((node) => node.id === "symbol:internal/clock/clock.go:function:Now");

    assert.ok(graph.edges.some((edge) => edge.source === boot.id && edge.target === validate.id && edge.type === "calls" && edge.confidence === "exact"));
    assert.ok(graph.edges.some((edge) => edge.source === boot.id && edge.target === now.id && edge.type === "calls" && edge.confidence === "exact"));
    assert.ok(graph.edges.some((edge) => edge.source === run.id && edge.target === validate.id && edge.type === "calls"));
    assert.equal(graph.edges.some((edge) => edge.source === shadowed.id && edge.target === validate.id && edge.type === "calls"), false);
    assert.equal(graph.edges.some((edge) => edge.source === masked.id && edge.target === validate.id && edge.type === "calls"), false);
    assert.equal(graph.edges.some((edge) => edge.source === run.id && edge.target === handle.id && edge.type === "calls"), false);
    assert.ok(graph.analysis.calls.supported.includes("direct local Go function calls and aliased Go package selectors resolved inside the repository"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("direct local and named-import function calls create symbol edges for impact analysis", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-calls-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "call-example" }));
    write(root, "src/validation.ts", "export function normalizeOrder() { return 'ok'; }\nexport function validateOrder() { return normalizeOrder(); }");
    write(root, "src/checkout.ts", "import { validateOrder } from './validation';\nexport function submitOrder() { return validateOrder(); }");
    write(root, "src/shadow.ts", "import { validateOrder } from './validation';\nexport function shadowedValidate(validateOrder: () => string) { return validateOrder(); }");
    write(root, "src/legacy.cjs", "const { validateOrder: checkOrder } = require('./validation');\nfunction submitLegacy() { return checkOrder(); }");

    const graph = scanRepository(root);
    const validate = graph.nodes.find((node) => node.kind === "symbol" && node.path === "src/validation.ts" && node.label === "validateOrder");
    const normalize = graph.nodes.find((node) => node.kind === "symbol" && node.path === "src/validation.ts" && node.label === "normalizeOrder");
    const submit = graph.nodes.find((node) => node.kind === "symbol" && node.path === "src/checkout.ts" && node.label === "submitOrder");
    const shadowed = graph.nodes.find((node) => node.kind === "symbol" && node.path === "src/shadow.ts" && node.label === "shadowedValidate");
    const legacy = graph.nodes.find((node) => node.kind === "symbol" && node.path === "src/legacy.cjs" && node.label === "submitLegacy");
    assert.ok(graph.edges.some((edge) => edge.source === validate.id && edge.target === normalize.id && edge.type === "calls" && edge.confidence === "exact"));
    assert.ok(graph.edges.some((edge) => edge.source === submit.id && edge.target === validate.id && edge.type === "calls" && edge.confidence === "exact"));
    assert.ok(graph.edges.some((edge) => edge.source === legacy.id && edge.target === validate.id && edge.type === "calls" && edge.confidence === "exact"));
    assert.equal(graph.edges.some((edge) => edge.source === shadowed.id && edge.target === validate.id && edge.type === "calls"), false);
    assert.equal(graph.stats.calls, 3);
    assert.ok(graph.analysis.calls.supported.includes("direct identifier calls to named ES/CommonJS imports resolved inside the repository"));

    const impact = getChangeImpact(graph, ["src/validation.ts"]);
    assert.ok(impact.affectedNodes.some((node) => node.id === submit.id));
    assert.ok(impact.affectedNodes.some((node) => node.path === "src/checkout.ts"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("static Prisma and BullMQ instances become runtime integration nodes with exact usage edges", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-runtime-integrations-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "runtime-integrations" }));
    write(root, "src/orders.ts", "import { PrismaClient } from '@prisma/client';\nimport { Queue } from 'bullmq';\nconst prisma = new PrismaClient();\nconst orders = new Queue('orders');\nexport function submit() { prisma.order.create({ data: {} }); orders.add('created', {}); }");

    const graph = scanRepository(root);
    const file = graph.nodes.find((node) => node.id === "file:src/orders.ts");
    const submit = graph.nodes.find((node) => node.id === "symbol:src/orders.ts:function:submit");
    const prisma = graph.nodes.find((node) => node.id === "runtime:src/orders.ts:database:prisma");
    const orders = graph.nodes.find((node) => node.id === "runtime:src/orders.ts:queue:orders");
    assert.equal(prisma.label, "Prisma client");
    assert.equal(orders.label, "orders Queue");
    assert.ok(graph.edges.some((edge) => edge.source === file.id && edge.target === prisma.id && edge.type === "initializes"));
    assert.ok(graph.edges.some((edge) => edge.source === file.id && edge.target === orders.id && edge.type === "initializes"));
    assert.ok(graph.edges.some((edge) => edge.source === submit.id && edge.target === prisma.id && edge.type === "queries"));
    assert.ok(graph.edges.some((edge) => edge.source === submit.id && edge.target === orders.id && edge.type === "queues"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("direct-call analysis tolerates for statements without an initializer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-for-loop-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "for-loop-example" }));
    write(root, "src/loop.ts", "export function tick() {}\nexport function run() { for (;;) { tick(); break; } }");
    const graph = scanRepository(root);
    const run = graph.nodes.find((node) => node.id === "symbol:src/loop.ts:function:run");
    const tick = graph.nodes.find((node) => node.id === "symbol:src/loop.ts:function:tick");
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === run.id && edge.target === tick.id));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("change impact recovers deleted-file dependents from a matching prior graph", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-deleted-impact-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "deleted-impact-example" }));
    write(root, "src/orders/orders.routes.ts", "import { OrdersService } from './orders.service';\nrouter.post('/orders', () => OrdersService.create());");
    write(root, "src/orders/orders.service.ts", "export class OrdersService { static create() { return 'ok'; } }");
    write(root, "src/orders/orders.service.spec.ts", "import { OrdersService } from './orders.service';\ntest('creates', () => OrdersService.create());");
    const previousGraph = scanRepository(root);
    writeGraphCache(root, previousGraph);
    assert.equal(readGraphCache(root)?.project.name, "deleted-impact-example");
    fs.rmSync(path.join(root, "src", "orders", "orders.service.ts"));

    const graph = scanRepository(root);
    const impact = getChangeImpact(graph, ["src/orders/orders.service.ts"], { previousGraph: readGraphCache(root) });
    assert.deepEqual(impact.deletedPaths, ["src/orders/orders.service.ts"]);
    assert.equal(impact.matchedPaths.length, 0);
    assert.equal(impact.historicalBaseline, true);
    assert.ok(impact.deletedNodes.some((node) => node.path === "src/orders/orders.service.ts"));
    assert.ok(impact.affectedEndpoints.some((node) => node.label === "POST /orders"));
    assert.ok(impact.recommendedTests.some((node) => node.path === "src/orders/orders.service.spec.ts"));
    assert.ok(impact.affectedNodes.some((node) => node.path === "src/orders/orders.routes.ts" && node.relationship === "historical-dependent"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Git graph snapshots persist commit graphs and compare static before-after flows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-history-"));
  let app;
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "flopeek@example.test"]);
    git(root, ["config", "user.name", "Flopeek Test"]);
    write(root, "package.json", JSON.stringify({ name: "history-example" }));
    write(root, "src/orders.routes.ts", "router.get('/orders', () => ({ ok: true }));");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "add orders endpoint"]);
    const beforeRevision = git(root, ["rev-parse", "HEAD"]);
    const first = createGitSnapshot(root, { ref: beforeRevision });
    assert.equal(first.created, true);
    assert.ok(fs.existsSync(first.path));
    assert.equal(first.snapshot.graph.project.root, fs.realpathSync(root));
    assert.equal(createGitSnapshot(root, { ref: beforeRevision }).created, false);

    write(root, "src/orders.routes.ts", "router.post('/orders', () => ({ ok: true }));");
    git(root, ["add", "src/orders.routes.ts"]);
    git(root, ["commit", "-m", "change orders endpoint"]);
    const afterRevision = git(root, ["rev-parse", "HEAD"]);
    const comparison = compareGitSnapshots(root, { from: beforeRevision, to: afterRevision });
    assert.deepEqual(comparison.changedPaths, ["src/orders.routes.ts"]);
    assert.ok(comparison.topology.addedNodes.some((node) => node.id === "endpoint:src/orders.routes.ts:POST:/orders"));
    assert.ok(comparison.topology.removedNodes.some((node) => node.id === "endpoint:src/orders.routes.ts:GET:/orders"));
    assert.equal(comparison.flows.summary.addedFlows, 1);
    assert.equal(comparison.flows.summary.removedFlows, 1);
    assert.match(comparison.limitation, /uncommitted working-tree changes/);
    app = await startServer({ root, port: 0 });
    const apiComparison = await (await fetch(`http://127.0.0.1:${app.port}/api/history?from=${beforeRevision}&to=${afterRevision}`)).json();
    assert.equal(apiComparison.schemaVersion, "flopeek-git-history-comparison/v1");
    assert.equal(apiComparison.flows.summary.addedFlows, 1);
    const snapshotResponse = await fetch(`http://127.0.0.1:${app.port}/api/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: afterRevision }),
    });
    const snapshotPayload = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotPayload.created, false);
    assert.equal(snapshotPayload.commit.revision, afterRevision);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("incremental scanner reparses only changed source files while rebuilding global relationships", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-incremental-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "incremental-example" }));
    write(root, "src/orders/orders.routes.ts", "import { quote } from '@orders/service';\nrouter.get('/orders', () => quote());");
    write(root, "src/orders/service.ts", "export function quote() { return 100; }");
    write(root, "src/orders/service.spec.ts", "import { quote } from './service';\ntest('quotes', () => quote());");
    const scanner = createRepositoryScanner(root);
    const initial = scanner.scan();
    assert.equal(initial.analysis.refresh.mode, "initial");
    assert.equal(initial.analysis.refresh.analyzedFiles, 3);
    assert.equal(initial.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/orders/orders.routes.ts" && edge.target === "file:src/orders/service.ts"), false);

    write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "./src", paths: { "@orders/*": ["orders/*"] } } }));
    const configured = scanner.scan(["tsconfig.json"]);
    assert.deepEqual(configured.analysis.refresh, {
      strategy: "incremental-content-analysis",
      mode: "incremental",
      analyzedFiles: 0,
      reusedFiles: 3,
      removedFiles: 0,
      changedPaths: ["tsconfig.json"],
    });
    assert.ok(configured.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/orders/orders.routes.ts" && edge.target === "file:src/orders/service.ts"));

    write(root, "src/orders/service.ts", "export function quote() { return 120; }\nexport function applyDiscount() { return 10; }");
    const incremental = scanner.scan(["src/orders/service.ts"]);
    assert.deepEqual(incremental.analysis.refresh, {
      strategy: "incremental-content-analysis",
      mode: "incremental",
      analyzedFiles: 1,
      reusedFiles: 2,
      removedFiles: 0,
      changedPaths: ["src/orders/service.ts"],
    });
    assert.ok(incremental.nodes.some((node) => node.id === "symbol:src/orders/service.ts:function:applyDiscount"));
    const full = scanRepository(root);
    assert.deepEqual(incremental.nodes, full.nodes);
    assert.deepEqual(incremental.edges, full.edges);
    assert.deepEqual(incremental.flows, full.flows);
    assert.deepEqual(incremental.stats, full.stats);

    write(root, "src/orders/tax.ts", "export function tax() { return 11; }");
    const added = scanner.scan(["src/orders/tax.ts"]);
    assert.equal(added.analysis.refresh.analyzedFiles, 1);
    assert.equal(added.analysis.refresh.reusedFiles, 3);
    assert.ok(added.nodes.some((node) => node.id === "file:src/orders/tax.ts"));
    fs.rmSync(path.join(root, "src", "orders", "tax.ts"));
    const deleted = scanner.scan(["src/orders/tax.ts"]);
    assert.equal(deleted.analysis.refresh.analyzedFiles, 0);
    assert.equal(deleted.analysis.refresh.reusedFiles, 3);
    assert.equal(deleted.analysis.refresh.removedFiles, 1);
    assert.equal(deleted.nodes.some((node) => node.id === "file:src/orders/tax.ts"), false);

    write(root, "src/orders/discount.ts", "export function discount() { return 5; }");
    const directoryEvent = scanner.scan(["src/orders"]);
    assert.equal(directoryEvent.analysis.refresh.mode, "incremental");
    assert.equal(directoryEvent.analysis.refresh.analyzedFiles, 1);
    assert.deepEqual(directoryEvent.analysis.refresh.changedPaths, ["src/orders/discount.ts"]);
    assert.ok(directoryEvent.nodes.some((node) => node.id === "file:src/orders/discount.ts"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incremental import resolution cache is invalidated when source topology changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-incremental-resolution-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "incremental-resolution" }));
    write(root, "src/entry.ts", "import { run } from './service';\nrun();");
    const scanner = createRepositoryScanner(root);
    const initial = scanner.scan();
    assert.equal(initial.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/entry.ts"), false);

    write(root, "src/service.ts", "export function run() { return true; }");
    const added = scanner.scan(["src/service.ts"]);
    assert.equal(added.analysis.refresh.mode, "incremental");
    assert.equal(added.analysis.refresh.analyzedFiles, 1);
    assert.ok(added.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/entry.ts" && edge.target === "file:src/service.ts"));
    assert.ok(added.edges.some((edge) => edge.type === "calls" && edge.source === "file:src/entry.ts" && edge.target === "symbol:src/service.ts:function:run"));

    fs.rmSync(path.join(root, "src", "service.ts"));
    const removed = scanner.scan(["src/service.ts"]);
    assert.equal(removed.analysis.refresh.removedFiles, 1);
    assert.equal(removed.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/entry.ts"), false);
    assert.equal(removed.edges.some((edge) => edge.type === "calls" && edge.source === "file:src/entry.ts"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incremental Rust scans refresh crate-module resolution when a module is created", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-incremental-rust-resolution-"));
  try {
    write(root, "Cargo.toml", `[package]
name = "incremental-rust-resolution"
version = "0.1.0"
`);
    write(root, "src/lib.rs", `use crate::helpers::run;

pub fn execute() { run(); }
`);
    const scanner = createRepositoryScanner(root);
    const initial = scanner.scan();
    assert.equal(initial.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/lib.rs"), false);

    write(root, "src/helpers.rs", "pub fn run() {}\n");
    const added = scanner.scan(["src/helpers.rs"]);
    assert.equal(added.analysis.refresh.mode, "incremental");
    assert.equal(added.analysis.refresh.analyzedFiles, 1);
    assert.equal(added.analysis.refresh.reusedFiles, 1);
    assert.ok(added.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/lib.rs" && edge.target === "file:src/helpers.rs"));
    assert.ok(added.edges.some((edge) => edge.type === "calls" && edge.source === "symbol:src/lib.rs:function:execute" && edge.target === "symbol:src/helpers.rs:function:run"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incremental benchmark is read-only and records reproducible scan metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-benchmark-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "benchmark-example" }));
    write(root, "src/payment.ts", "export function pay() { return true; }");
    const result = benchmarkRepository(root, { iterations: 1 });
    assert.equal(result.benchmark, "flopeek-incremental-scan/v1");
    assert.equal(result.project.name, "benchmark-example");
    assert.equal(result.selectedPath, "src/payment.ts");
    assert.equal(result.sourceFiles, 1);
    assert.equal(result.parsedFiles, 1);
    assert.equal(result.parserCoverage.summary.parsedFiles, 1);
    assert.equal(result.fullRescanMs.samples.length, 1);
    assert.equal(result.incrementalRescanMs.samples.length, 1);
    assert.equal(result.refresh.analyzedFiles, 1);
    assert.equal(result.refresh.reusedFiles, 0);
    assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local viewer serves a benchmark comparison payload with Rust coverage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-benchmark-viewer-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "benchmark-viewer-example" }));
    write(root, "src/lib.rs", "pub fn calculate() -> u8 { 1 }");
    app = await startServer({ root, port: 0 });
    const response = await fetch(`http://127.0.0.1:${app.port}/api/benchmark`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ iterations: 1 }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.benchmark, "flopeek-incremental-scan/v1");
    assert.equal(result.iterations, 1);
    assert.equal(result.fullRescanMs.samples.length, 1);
    assert.equal(result.incrementalRescanMs.samples.length, 1);
    assert.equal(result.parserCoverage.byLanguage.find((language) => language.language === "rs").parsed, 1);
    assert.match(result.interpretation, /local CPU-time comparison/);

    const proofResponse = await fetch(`http://127.0.0.1:${app.port}/api/product-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ iterations: 1 }),
    });
    assert.equal(proofResponse.status, 200);
    const proof = await proofResponse.json();
    assert.equal(proof.schemaVersion, "flopeek-product-proof/v1");
    assert.equal(proof.localBenchmark.status, "available");
    assert.equal(proof.localBenchmark.result.iterations, 1);
    assert.equal(proof.headlineMetrics.auditedRelationships, 92);
    assert.equal(proof.claimBoundary.universalSpeedup, false);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real-repository corpus scoring reports false positives and false negatives within an audited scope", () => {
  const graph = { edges: [
    { source: "symbol:example:function:run", target: "symbol:example:function:one", type: "calls" },
    { source: "symbol:example:function:run", target: "symbol:example:function:unexpected", type: "calls" },
    { source: "symbol:example:function:other", target: "symbol:example:function:one", type: "calls" },
  ] };
  assert.deepEqual(scoreFocus(graph, {
    label: "example",
    source: "symbol:example:function:run",
    type: "calls",
    expectedTargets: ["symbol:example:function:one", "symbol:example:function:missing"],
  }), {
    label: "example",
    source: "symbol:example:function:run",
    type: "calls",
    expected: 2,
    actual: 2,
    truePositives: 1,
    falsePositives: ["symbol:example:function:unexpected"],
    falseNegatives: ["symbol:example:function:missing"],
  });
});

test("real-repository corpus can prepare missing repositories through an explicit clone directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-real-corpus-"));
  try {
    const manifest = { repositories: [
      { id: "first", url: "https://example.test/first.git", revision: "abc1234" },
      { id: "second", url: "https://example.test/second.git", revision: "def5678" },
    ] };
    const explicit = path.join(root, "explicit-second");
    const clones = [];
    const repositories = resolveCorpusRepositories(manifest, { second: explicit }, path.join(root, "clones"), (repository, destination) => {
      clones.push({ id: repository.id, destination });
      fs.mkdirSync(destination, { recursive: true });
      return destination;
    });
    assert.deepEqual(clones, [{ id: "first", destination: path.join(root, "clones", "first") }]);
    assert.deepEqual(repositories, { first: path.join(root, "clones", "first"), second: explicit });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real-repository corpus accepts a pinned abbreviated revision against its full SHA", () => {
  assert.equal(revisionMatches("0a68c77931ae2da1000000000000000000000000", "0a68c77"), true);
  assert.equal(revisionMatches("0a68c77931ae2da1000000000000000000000000", "f293848"), false);
});

test("real-repository corpus trusts only the temporary checkout for Windows Git", () => {
  const root = String.raw`E:\benchmarks\pnpm.flopeek-clone-123`;
  assert.deepEqual(checkoutArguments(root, "abc1234"), [
    "-c",
    `safe.directory=${root}`,
    "-C",
    root,
    "checkout",
    "--detach",
    "abc1234",
  ]);
});

test("real-repository corpus retries transient Windows checkout rename locks", () => {
  let attempts = 0;
  const waits = [];
  renameWithRetry("temporary", "destination", {
    attempts: 4,
    delayMs: 7,
    rename: () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("file is locked");
        error.code = "EPERM";
        throw error;
      }
    },
    wait: (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [7, 7]);
});

test("real-repository corpus reports progress and preserves a partial result on repository failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-corpus-progress-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    write(root, "README.md", "fixture");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture"]);
    const revision = git(root, ["rev-parse", "HEAD"]);
    const manifest = { name: "corpus/v1", repositories: [
      { id: "first", revision, focuses: [{ label: "first scope", source: "source:a", type: "calls", expectedTargets: ["target:b"] }] },
      { id: "second", revision, focuses: [{ label: "second scope", source: "source:c", type: "calls", expectedTargets: [] }] },
    ] };
    const progress = [];
    assert.throws(() => validateRealRepositoryCorpus(manifest, { first: root, second: root }, {
      scanRepository: (_checkout, repository) => {
        if (repository.id === "second") throw Object.assign(new Error("scan timed out"), { code: "corpus-scan-timeout" });
        return { project: { name: "fixture" }, edges: [{ source: "source:a", target: "target:b", type: "calls" }] };
      },
      onProgress: (event) => progress.push(event),
    }), (error) => {
      assert.equal(error.code, "corpus-scan-timeout");
      assert.equal(error.result.complete, false);
      assert.equal(error.result.completedRepositories, 1);
      assert.equal(error.result.truePositives, 1);
      assert.equal(error.result.failure.repository, "second");
      return true;
    });
    assert.deepEqual(progress.map((event) => event.phase), ["scan-start", "scan-complete", "scope-complete", "scan-start"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real-repository corpus CLI accepts a bounded per-repository timeout", () => {
  assert.equal(parseCorpusArguments([]).timeoutMs, 300000);
  assert.equal(parseCorpusArguments(["--timeout-ms", "45000"]).timeoutMs, 45000);
  assert.throws(() => parseCorpusArguments(["--timeout-ms", "999"]), /between 1000 and 900000/);
});

test("real-repository corpus worker enforces its process timeout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-corpus-timeout-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "timeout-fixture" }));
    write(root, "src/main.ts", "export const main = true;");
    assert.throws(() => scanRepositoryWithTimeout(root, { focuses: [] }, 1), (error) => error.code === "corpus-scan-timeout");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("pinned real-repository manifest retains independently audited multi-repository scope", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "benchmarks", "real-repository-corpus.json"), "utf8"));
  const focuses = manifest.repositories.flatMap((repository) => repository.focuses.map((focus) => ({ repository: repository.id, ...focus })));
  assert.deepEqual(manifest.repositories.map((repository) => repository.id), ["pnpm", "nest", "sveltekit", "vite", "symfony"]);
  assert.equal(focuses.length, 14);
  assert.equal(focuses.reduce((total, focus) => total + focus.expectedTargets.length, 0), 92);
  assert.equal(new Set(focuses.map((focus) => `${focus.repository}:${focus.source}:${focus.type}`)).size, focuses.length);
});

test("local server serves the UI and persists a human description", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-flow-server-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "server-example" }));
    write(root, "src/ping.routes.ts", "router.get('/ping', () => ({ ok: true }));");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    const homeMarkup = await home.text();
    assert.match(homeMarkup, /analysis-coverage/);
    assert.match(homeMarkup, /Detected static flows/);
    assert.match(homeMarkup, /open-project-home/);
    assert.match(homeMarkup, /open-product-proof/);
    const currentHome = await fetch(`${baseUrl}/`);
    assert.match(await currentHome.text(), /context-ref-input/);
    const appScript = await fetch(`${baseUrl}/app.js`);
    assert.equal(appScript.status, 200);
    const appSource = await appScript.text();
    assert.match(appSource, /renderCoverageSummary/);
    assert.match(appSource, /if \(!node\) \{\s*await renderRawInspector\(id\);/);
    assert.match(appSource, /openFlowLens/);
    assert.match(appSource, /copy-flow-context-ref/);
    assert.match(appSource, /\/api\/flow-context-card/);
    assert.match(appSource, /lens\.truncation\.requestedMaxSteps/);
    assert.match(appSource, /\/api\/flow-verifications/);
    assert.match(appSource, /semanticSuggestionSection/);
    assert.match(appSource, /semanticFeedbackSection/);
    assert.match(appSource, /traceHistorySection/);
    assert.match(appSource, /applyFlowLensFocus/);
    assert.match(appSource, /open-semantic-review/);
    assert.match(appSource, /openSemanticReviewQueue/);
    assert.match(appSource, /openProjectHome/);
    assert.match(appSource, /openProductProof/);
    assert.match(appSource, /Proof, with boundaries/);
    assert.match(appSource, /review-queue-batch-accept/);

    const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
    const endpoint = graph.nodes.find((node) => node.kind === "endpoint");
    assert.equal(endpoint.label, "GET /ping");
    const projectBriefPacket = await (await fetch(`${baseUrl}/api/brief?kind=project`)).json();
    assert.equal(projectBriefPacket.schemaVersion, "flopeek-brief-packet/v1");
    assert.equal(projectBriefPacket.brief.kind, "project");
    assert.equal(projectBriefPacket.brief.projectIdentity.projectId, graph.project.projectId);
    assert.equal(projectBriefPacket.brief.freshnessStatus, "current");
    assert.equal(projectBriefPacket.brief.sections.runtimeEvidence.status, "unavailable");
    const handoffContextResponse = await fetch(`${baseUrl}/api/handoff-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIntent: "inspect the payment endpoint safely", tokenBudget: 1200, desiredEvidenceDepth: "summary" }),
    });
    assert.equal(handoffContextResponse.status, 200);
    const handoffContext = await handoffContextResponse.json();
    assert.equal(handoffContext.schemaVersion, "flopeek-handoff-context/v1");
    assert.equal(handoffContext.budget.status, "within-budget");
    assert.ok(handoffContext.budget.estimatedCharacterCount <= handoffContext.budget.characterBudget);
    const qualityResponse = await fetch(`${baseUrl}/api/handoff-quality`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cases: [{ id: "server-orientation", request: { taskIntent: "Locate the ping endpoint.", tokenBudget: 2048 } }] }),
    });
    assert.equal(qualityResponse.status, 200);
    const handoffQuality = await qualityResponse.json();
    assert.equal(handoffQuality.schemaVersion, "flopeek-handoff-quality/v1");
    assert.equal(handoffQuality.qualityGate.status, "passed");
    assert.equal(handoffQuality.summary.agentTaskOutcomes.unavailable, 1);
    const runtimeGraph = await (await fetch(`${baseUrl}/api/graph`)).json();
    const runtimeEndpoint = runtimeGraph.nodes.find((node) => node.kind === "endpoint");
    assert.ok(runtimeEndpoint);
    const runtimeCard = await (await fetch(`${baseUrl}/api/context-card?id=${encodeURIComponent(runtimeEndpoint.id)}`)).json();
    const runtimeSubjectRef = runtimeCard.card.contextRef;
    const runtimeResponse = await fetch(`${baseUrl}/api/runtime-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "server-runtime-v1",
        subjectRef: runtimeSubjectRef,
        kind: "request-observation",
        outcome: "succeeded",
        observedAt: "2026-07-15T00:00:00.000Z",
        summary: "Local health probe returned an expected status category.",
        source: "server integration test",
        statusCode: 200,
        durationMs: 12,
      }),
    });
    assert.equal(runtimeResponse.status, 201);
    const runtimeResult = await runtimeResponse.json();
    assert.equal(runtimeResult.record.evidenceClass, "runtime-evidence");
    const runtimeList = await (await fetch(`${baseUrl}/api/runtime-evidence`)).json();
    assert.equal(runtimeList.records.length, 1);
    assert.equal(runtimeList.records[0].freshnessStatus, "current");
    const workspaceResponse = await fetch(`${baseUrl}/api/handoff-workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "server-handoff-v1", author: "Server test", purpose: "Provide a portable project handoff." }),
    });
    assert.equal(workspaceResponse.status, 201);
    const workspaceResult = await workspaceResponse.json();
    const workspaceView = await (await fetch(`${baseUrl}/api/handoff-workspace`)).json();
    assert.equal(workspaceView.workspace.id, workspaceResult.workspace.id);
    const projectHome = await (await fetch(`${baseUrl}/api/project-home?concept=authentication`)).json();
    assert.equal(projectHome.schemaVersion, "flopeek-project-home/v1");
    assert.equal(projectHome.purpose.status, "available");
    assert.equal(projectHome.conceptIndex.schemaVersion, "flopeek-concept-index/v1");
    const trustAnalytics = await (await fetch(`${baseUrl}/api/trust-analytics`)).json();
    assert.equal(trustAnalytics.schemaVersion, "flopeek-trust-analytics/v1");
    assert.equal(trustAnalytics.project.projectId, graph.project.projectId);
    assert.equal(trustAnalytics.overallScore, null);
    assert.equal(trustAnalytics.claimBoundary.runtimeCorrectness, false);
    assert.equal(trustAnalytics.qualityEvidence.liveRepositoryAccuracy.status, "unavailable");
    const productProof = await (await fetch(`${baseUrl}/api/product-proof`)).json();
    assert.equal(productProof.schemaVersion, "flopeek-product-proof/v1");
    assert.equal(productProof.currentRepository.projectId, graph.project.projectId);
    assert.equal(productProof.headlineMetrics.auditedRelationships, 92);
    assert.equal(productProof.localBenchmark.status, "not-run");
    assert.equal(productProof.claimBoundary.globalAccuracy, false);
    const noteResponse = await fetch(`${baseUrl}/api/handoff-notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "server-note-v1", subjectKind: "project", body: "Receiving team should inspect the endpoint first.", author: "Server test" }),
    });
    assert.equal(noteResponse.status, 201);
    const portableHandoff = await (await fetch(`${baseUrl}/api/handoff-export?format=json`)).json();
    assert.equal(portableHandoff.schemaVersion, "flopeek-handoff-export/v1");
    assert.equal(portableHandoff.notes.length, 1);
    const markdownHandoff = await (await fetch(`${baseUrl}/api/handoff-export?format=markdown`)).json();
    assert.match(markdownHandoff.markdown, /flopeek-handoff-json-base64:/);
    const importResponse = await fetch(`${baseUrl}/api/handoff-imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packet: portableHandoff }),
    });
    assert.equal(importResponse.status, 201);
    const importedHandoffs = await (await fetch(`${baseUrl}/api/handoff-imports`)).json();
    assert.equal(importedHandoffs.records[0].access, "read-only");
    assert.equal(importedHandoffs.records[0].trust, "foreign-unverified");
    const enrichedHandoffContext = await (await fetch(`${baseUrl}/api/handoff-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIntent: "understand the local handoff", tokenBudget: 1600, desiredEvidenceDepth: "summary" }),
    })).json();
    assert.equal(enrichedHandoffContext.included.handoffWorkspace.id, workspaceResult.workspace.id);
    await fetch(`${baseUrl}/api/handoff-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIntent: "understand the local handoff", tokenBudget: 1600, desiredEvidenceDepth: "summary" }),
    });
    const artifactCache = await (await fetch(`${baseUrl}/api/cache-artifacts`)).json();
    assert.equal(artifactCache.status, "available");
    assert.ok(artifactCache.counts.hits >= 1);
    assert.ok(artifactCache.counts.misses >= 1);
    assert.equal(artifactCache.policy.staleReuse, "never-silent");
    const briefMarkdown = await (await fetch(`${baseUrl}/api/brief?kind=node&id=${encodeURIComponent(endpoint.id)}&format=markdown`)).json();
    assert.match(briefMarkdown.markdown, /## Parser facts/);
    const materializedBriefResponse = await fetch(`${baseUrl}/api/briefs/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "node", id: endpoint.id }),
    });
    assert.equal(materializedBriefResponse.status, 201);
    const materializedBrief = await materializedBriefResponse.json();
    const briefManifests = await (await fetch(`${baseUrl}/api/brief-manifests?kind=node&contextId=${encodeURIComponent(endpoint.id)}`)).json();
    assert.equal(briefManifests.total, 1);
    assert.equal(briefManifests.records[0].artifactStatus, "retained");
    const briefResolution = await (await fetch(`${baseUrl}/api/context/resolve?ref=${encodeURIComponent(materializedBrief.brief.briefRef)}`)).json();
    assert.equal(briefResolution.status, "current");
    assert.equal(briefResolution.brief.contextId, endpoint.id);
    const contextPacket = await (await fetch(`${baseUrl}/api/context-card?id=${encodeURIComponent(endpoint.id)}`)).json();
    assert.equal(contextPacket.card.kind, "node");
    assert.equal(contextPacket.card.project.graphVersion, graph.state.graphVersion);
    const contextResolution = await (await fetch(`${baseUrl}/api/context/resolve?ref=${encodeURIComponent(contextPacket.card.contextRef)}`)).json();
    assert.equal(contextResolution.status, "current");
    const markdownPacket = await (await fetch(`${baseUrl}/api/context-card?id=${encodeURIComponent(endpoint.id)}&format=markdown`)).json();
    assert.equal(markdownPacket.format, "markdown");
    assert.match(markdownPacket.markdown, /GET \/ping/);
    const lens = await (await fetch(`${baseUrl}/api/flow-lens?flow=${encodeURIComponent(`flow:${endpoint.id}`)}`)).json();
    const expandedLensResponse = await fetch(`${baseUrl}/api/flow-lens?flow=${encodeURIComponent(`flow:${endpoint.id}`)}&maxSteps=24`);
    assert.equal(expandedLensResponse.status, 200);
    const expandedLens = await expandedLensResponse.json();
    assert.equal(lens.truncation.requestedMaxSteps, 12);
    assert.equal(expandedLens.truncation.requestedMaxSteps, 24);
    const expandedFlowPacketResponse = await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(`flow:${endpoint.id}`)}&maxSteps=24`);
    assert.equal(expandedFlowPacketResponse.status, 200);
    const expandedFlowPacket = await expandedFlowPacketResponse.json();
    assert.deepEqual(expandedFlowPacket.card.projection.steps, expandedLens.steps);
    assert.deepEqual(expandedFlowPacket.card.projection.truncation, expandedLens.truncation);
    const expandedMarkdownResponse = await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(`flow:${endpoint.id}`)}&format=markdown&maxSteps=24`);
    assert.equal(expandedMarkdownResponse.status, 200);
    assert.match((await expandedMarkdownResponse.json()).markdown, /Requested maximum steps: 24/);
    for (const maxSteps of ["0", "25", "1.5", "12.0", "invalid", ""]) {
      for (const endpointPath of ["flow-lens", "flow-context-card"]) {
        const invalidResponse = await fetch(`${baseUrl}/api/${endpointPath}?flow=${encodeURIComponent(`flow:${endpoint.id}`)}&maxSteps=${encodeURIComponent(maxSteps)}`);
        assert.equal(invalidResponse.status, 400);
        assert.match((await invalidResponse.json()).error, /integer from 1 through 24/);
      }
    }
    assert.equal(lens.schemaVersion, "flopeek-flow-lens/v1");
    assert.equal(lens.flow.entryId, endpoint.id);
    assert.match(lens.flow.contextRef, /^fp:\/\/local\/.+\/flow\//);
    assert.equal(lens.steps[0].transition, null);
    assert.equal(lens.steps[1].transition.type, "handles");
    assert.equal(lens.verification.status, "unverified");
    assert.equal(lens.semanticSuggestion.schemaVersion, "flopeek-semantic-flow-suggestion/v1");
    assert.equal(lens.semanticSuggestion.status, "suggested");
    assert.equal(lens.semanticSuggestion.candidate.title, "Check Ping");
    assert.equal(lens.semanticSuggestion.knowledgeClass, "derived-suggestion");
    const reviewQueue = await (await fetch(`${baseUrl}/api/semantic-review-queue?status=suggested`)).json();
    assert.equal(reviewQueue.schemaVersion, "flopeek-semantic-review-queue/v1");
    assert.equal(reviewQueue.endpointCount, 1);
    assert.equal(reviewQueue.flowCatalog.total, 1);
    assert.equal(reviewQueue.flowCatalog.truncated, false);
    assert.equal(reviewQueue.items[0].sourceEvidence.endpoint.id, endpoint.id);
    assert.equal(reviewQueue.items[0].sourceEvidence.handler, null);
    assert.equal(reviewQueue.items[0].sourceEvidence.handlerBinding, "non-exact-handler");
    const batchFeedbackResponse = await fetch(`${baseUrl}/api/semantic-suggestion-feedbacks/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ flowId: lens.flow.id, scope: "application", operationId: "test-batch-semantic-feedback", decision: "accepted", reviewedBy: "Test reviewer" }] }),
    });
    assert.equal(batchFeedbackResponse.status, 201);
    const batchFeedback = await batchFeedbackResponse.json();
    assert.equal(batchFeedback.results.length, 1);
    assert.equal((await (await fetch(`${baseUrl}/api/semantic-review-queue?status=suggested`)).json()).items.length, 0);
    const allReviewQueue = await (await fetch(`${baseUrl}/api/semantic-review-queue?status=all`)).json();
    assert.equal(allReviewQueue.items[0].queueStatus, "accepted");
    const suggestion = await (await fetch(`${baseUrl}/api/flow-suggestion?flow=${encodeURIComponent(lens.flow.id)}`)).json();
    assert.deepEqual(suggestion, lens.semanticSuggestion);
    const verificationResponse = await fetch(`${baseUrl}/api/flow-verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: lens.flow.id,
        expectedGraphVersion: lens.project.graphVersion,
        expectedFlowContextRef: lens.flow.contextRef,
        title: "Ping health check",
        description: "Confirms the service can respond to a health-check request.",
        owner: "Platform",
        risk: "low",
        questions: ["Should this endpoint require authentication?"],
        verifiedBy: "Test owner",
      }),
    });
    assert.equal(verificationResponse.status, 201);
    const verification = await verificationResponse.json();
    assert.equal(verification.status, "current");
    assert.equal(verification.record.title, "Ping health check");
    const verificationGet = await (await fetch(`${baseUrl}/api/flow-verification?flow=${encodeURIComponent(lens.flow.id)}`)).json();
    assert.equal(verificationGet.status, "current");
    const verificationHistory = await (await fetch(`${baseUrl}/api/flow-verification-history?flow=${encodeURIComponent(lens.flow.id)}`)).json();
    assert.equal(verificationHistory.records.length, 1);
    const flowPacket = await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(lens.flow.id)}`)).json();
    assert.equal(flowPacket.card.kind, "flow");
    assert.equal(flowPacket.card.contextRef, lens.flow.contextRef);
    assert.equal(flowPacket.card.projection.id, lens.id);
    assert.equal(flowPacket.card.humanVerification.title, "Ping health check");
    assert.equal(flowPacket.card.semanticSuggestion.candidate.title, "Check Ping");
    const nodeTraceResponse = await fetch(`${baseUrl}/api/agent-evidence-traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "viewer-test-ping-node-001",
        contextRef: contextPacket.card.contextRef,
        actionType: "inspect",
        actionSummary: "Inspected the ping endpoint Context Card.",
        changedPaths: [],
        verificationStatus: "not-run",
        verificationSummary: "No command was needed.",
        actor: "flopeek-test",
      }),
    });
    assert.equal(nodeTraceResponse.status, 201);
    const endpointDetail = await (await fetch(`${baseUrl}/api/node?id=${encodeURIComponent(endpoint.id)}`)).json();
    assert.equal(endpointDetail.agentEvidenceTraces.totalMatched, 1);
    assert.equal(endpointDetail.agentEvidenceTraces.records[0].operationId, "viewer-test-ping-node-001");
    const traceResponse = await fetch(`${baseUrl}/api/agent-evidence-traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "viewer-test-ping-001",
        contextRef: lens.flow.contextRef,
        actionType: "verify",
        actionSummary: "Reviewed the detected ping flow.",
        changedPaths: [],
        verificationStatus: "passed",
        verificationSummary: "The local viewer contract assertions passed.",
        actor: "flopeek-test",
      }),
    });
    assert.equal(traceResponse.status, 201);
    const trace = await traceResponse.json();
    assert.equal(trace.created, true);
    assert.equal(trace.record.context.ref, lens.flow.contextRef);
    const traceRetryResponse = await fetch(`${baseUrl}/api/agent-evidence-traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "viewer-test-ping-001",
        contextRef: lens.flow.contextRef,
        actionType: "verify",
        actionSummary: "Reviewed the detected ping flow.",
        changedPaths: [],
        verificationStatus: "passed",
        verificationSummary: "The local viewer contract assertions passed.",
        actor: "flopeek-test",
      }),
    });
    assert.equal(traceRetryResponse.status, 200);
    assert.equal((await traceRetryResponse.json()).created, false);
    const traceList = await (await fetch(`${baseUrl}/api/agent-evidence-traces?contextRef=${encodeURIComponent(lens.flow.contextRef)}`)).json();
    assert.equal(traceList.totalMatched, 1);
    assert.equal(traceList.records[0].verification.status, "passed");
    const feedbackResponse = await fetch(`${baseUrl}/api/semantic-suggestion-feedbacks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: lens.flow.id,
        operationId: "viewer-test-ping-feedback-001",
        decision: "accepted",
        reviewedBy: "Test owner",
        traceOperationId: "viewer-test-ping-001",
      }),
    });
    assert.equal(feedbackResponse.status, 201);
    const feedbackResult = await feedbackResponse.json();
    assert.equal(feedbackResult.record.decision, "accepted");
    assert.equal(feedbackResult.record.traceLink.operationId, "viewer-test-ping-001");
    const feedbackResolution = await (await fetch(`${baseUrl}/api/semantic-suggestion-feedback?flow=${encodeURIComponent(lens.flow.id)}`)).json();
    assert.equal(feedbackResolution.status, "current");
    assert.equal(feedbackResolution.record.decision, "accepted");
    const feedbackList = await (await fetch(`${baseUrl}/api/semantic-suggestion-feedbacks?flowId=${encodeURIComponent(lens.flow.id)}`)).json();
    assert.equal(feedbackList.totalMatched, 2);
    const feedbackRetry = await fetch(`${baseUrl}/api/semantic-suggestion-feedbacks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: lens.flow.id,
        operationId: "viewer-test-ping-feedback-001",
        decision: "accepted",
        reviewedBy: "Test owner",
        traceOperationId: "viewer-test-ping-001",
      }),
    });
    assert.equal(feedbackRetry.status, 200);
    assert.equal((await feedbackRetry.json()).created, false);
    const feedbackPacket = await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(lens.flow.id)}`)).json();
    assert.equal(feedbackPacket.card.semanticFeedback.record.decision, "accepted");
    const flowMarkdown = await (await fetch(`${baseUrl}/api/flow-context-card?flow=${encodeURIComponent(lens.flow.id)}&format=markdown`)).json();
    assert.match(flowMarkdown.markdown, /Displayed static steps/);
    assert.match(flowMarkdown.markdown, /Deterministic semantic suggestion/);
    const flowResolution = await (await fetch(`${baseUrl}/api/context/resolve?ref=${encodeURIComponent(lens.flow.contextRef)}`)).json();
    assert.equal(flowResolution.status, "current");
    assert.equal(flowResolution.card.kind, "flow");
    const compactView = await (await fetch(`${baseUrl}/api/view?mode=overview`)).json();
    assert.equal(compactView.view.mode, "overview");
    assert.ok(compactView.nodes.every((node) => node.kind === "summary"));
    assert.equal(compactView.aiContext.schemaVersion, "flopeek-agent-context/v1");
    assert.equal(compactView.aiContext.repositoryScope.source, "defaults");
    assert.equal(compactView.aiContext.repositoryScope.counts.application, 1);
    assert.ok(compactView.aiContext.resolution.internal.includes("relative imports"));
    assert.ok(compactView.aiContext.resolution.internal.includes("literal aliases from exported Vite/Webpack configs"));
    assert.equal(compactView.aiContext.coverage.summary.parsedFiles, 1);
    assert.ok(compactView.aiContext.calls.supported.includes("direct identifier calls to top-level local functions"));
    assert.ok(compactView.aiContext.interpretationRules.some((rule) => rule.includes("get_flow_projection")));
    assert.equal(compactView.aiContext.semanticSuggestions.schemaVersion, "flopeek-semantic-flow-suggestions/v1");
    assert.equal(compactView.aiContext.semanticSuggestions.suggested, 1);
    assert.equal(compactView.aiContext.semanticSuggestions.items[0].candidate.title, "Check Ping");
    assert.equal(compactView.aiContext.agentEvidenceTrace.totalRecords, 2);
    assert.equal(compactView.aiContext.semanticSuggestionFeedback.totalRecords, 2);
    assert.equal(compactView.aiContext.semanticSuggestionFeedback.recentRecords[0].decision, "accepted");
    const capabilities = await (await fetch(`${baseUrl}/api/capabilities`)).json();
    assert.equal(capabilities.mode, "deterministic");
    assert.equal(capabilities.repositoryScope.flowEntries.tests, false);
    assert.ok(capabilities.capabilities.some((capability) => capability.parser === "typescript-ast"));
    const impact = await (await fetch(`${baseUrl}/api/impact?path=src/ping.routes.ts`)).json();
    assert.equal(impact.changedNodes.some((node) => node.path === "src/ping.routes.ts"), true);
    const rejectedOrigin = await fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({}),
    });
    assert.equal(rejectedOrigin.status, 403);
    const oversized = await fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "x".repeat(1_000_001) }),
    });
    assert.equal(oversized.status, 413);
    const malformed = await fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(malformed.status, 400);
    const descriptionResponse = await fetch(`${baseUrl}/api/descriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: endpoint.id, description: "Health-check endpoint." }),
    });
    assert.equal(descriptionResponse.status, 200);
    assert.equal(safelyRead(path.join(root, ".flopeek", "descriptions.json"))[endpoint.id], "Health-check endpoint.");
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serve watches a new source file and publishes a graph update without manual scan", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-live-watch-"));
  let app;
  let reader;
  try {
    write(root, "package.json", JSON.stringify({ name: "live-watch-example" }));
    write(root, "src/initial.ts", "export const initial = true;");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const eventResponse = await fetch(`${baseUrl}/api/events`);
    assert.equal(eventResponse.status, 200);
    reader = eventResponse.body.getReader();
    const events = createSseEventReader(reader);
    await events.next((event) => event.event === "ready");
    write(root, "src/new.service.ts", "export class NewService { static ready() { return true; } }");

    const event = await events.next((candidate) => candidate.event === "graph");
    const update = JSON.parse(event.data);
    assert.equal(update.reason, "filesystem");
    assert.deepEqual(update.addedFileIds, ["file:src/new.service.ts"]);
    assert.deepEqual(update.addedFiles, [{ id: "file:src/new.service.ts", label: "New Service", path: "src/new.service.ts", type: "service" }]);
    assert.equal(update.addedFileCount, 1);
    assert.equal(update.addedFilesTruncated, false);
    assert.equal(update.graphState.graphVersion, 2);
    assert.equal(update.deltaIdentity.fromGraphVersion, 1);
    assert.equal(update.deltaIdentity.toGraphVersion, 2);
    assert.equal(update.deltaIdentity.sourceChanged, true);
    assert.equal(update.deltaIdentity.topologyChanged, true);
    assert.ok(update.timing.refreshToAffectedContextMs >= update.timing.changedContextProjectionMs);
    assert.ok(update.timing.changedContextProjectionMs >= 0);
    const persistedDelta = await (await fetch(`${baseUrl}/api/delta?fromVersion=${update.deltaIdentity.fromGraphVersion}&toVersion=${update.deltaIdentity.toGraphVersion}`)).json();
    assert.deepEqual(persistedDelta.changedPaths, ["src/new.service.ts"]);
    assert.equal(persistedDelta.refresh.mode, "incremental");
    assert.equal(persistedDelta.refresh.analyzedFiles, 1);
    assert.ok(persistedDelta.refresh.reusedFiles >= 1);
    assert.equal(persistedDelta.refresh.removedFiles, 0);
    const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.ok(graph.nodes.some((node) => node.kind === "file" && node.path === "src/new.service.ts"));
    assert.ok(graph.state.graphVersion >= update.graphState.graphVersion);
    const dependencyView = await (await fetch(`${baseUrl}/api/view?mode=dependencies&scope=all&focus=file%3Asrc%2Fnew.service.ts`)).json();
    assert.ok(dependencyView.nodes.some((node) => node.id === "file:src/new.service.ts"));
  } finally {
    if (reader) await reader.cancel();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serve exposes the same affected Flow Lens context through SSE and HTTP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-live-context-"));
  let app;
  let reader;
  try {
    write(root, "package.json", JSON.stringify({ name: "live-context-example" }));
    write(root, "src/orders.service.ts", "export function submitOrder() { return true; }");
    write(root, "src/orders.routes.ts", "import { submitOrder } from './orders.service';\nrouter.post('/orders', () => submitOrder());");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const before = await (await fetch(`${baseUrl}/api/graph`)).json();
    const flow = before.flows.find((candidate) => candidate.title === "POST /orders");
    assert.ok(flow);
    const initialLens = await (await fetch(`${baseUrl}/api/flow-lens?flow=${encodeURIComponent(flow.id)}`)).json();
    const initialRef = initialLens.flow.entryContextRef;
    const eventResponse = await fetch(`${baseUrl}/api/events`);
    reader = eventResponse.body.getReader();
    const events = createSseEventReader(reader);
    await events.next((event) => event.event === "ready");

    write(root, "src/orders.service.ts", "export function submitOrder() { return false; }");
    const event = await events.next((candidate) => candidate.event === "graph");
    const update = JSON.parse(event.data);
    assert.equal(update.graphState.graphVersion, 2);
    assert.equal(update.changedContexts.available, true);
    assert.ok(update.timing.refreshToAffectedContextMs >= update.timing.changedContextProjectionMs);
    const changedFlow = update.changedContexts.flows.find((candidate) => candidate.id === flow.id);
    assert.equal(changedFlow.status, "affected");
    assert.ok(changedFlow.changedStepIds.some((id) => id.includes("orders.service.ts")));
    assert.equal(changedFlow.flowProjectionId, `lens:${flow.id}@2`);
    assert.equal(changedFlow.flowComparisonAvailable, true);

    const changedContexts = await (await fetch(`${baseUrl}/api/changed-contexts?fromVersion=1&toVersion=2`)).json();
    assert.equal(changedContexts.available, true);
    assert.deepEqual(changedContexts.flows.find((candidate) => candidate.id === flow.id), changedFlow);
    const currentLens = await (await fetch(`${baseUrl}/api/flow-lens?flow=${encodeURIComponent(flow.id)}`)).json();
    assert.equal(currentLens.project.graphVersion, 2);
    assert.ok(currentLens.steps.some((step) => changedFlow.changedStepIds.includes(step.id)));
    const comparison = await (await fetch(`${baseUrl}/api/flow-comparison?flow=${encodeURIComponent(flow.id)}&fromVersion=1&toVersion=2`)).json();
    assert.equal(comparison.available, true);
    assert.equal(comparison.comparison.changes.sourceChangedOnly, true);
    assert.ok(comparison.comparison.changes.sourceChangedStepIds.some((id) => id.includes("orders.service.ts")));
    const resolved = await (await fetch(`${baseUrl}/api/context/resolve?ref=${encodeURIComponent(initialRef)}`)).json();
    assert.equal(resolved.status, "stale");
  } finally {
    if (reader) await reader.cancel();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serve reports a labeled batch of new source nodes for the live viewer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-live-batch-"));
  let app;
  let reader;
  try {
    write(root, "package.json", JSON.stringify({ name: "live-batch-example" }));
    write(root, "src/initial.ts", "export const initial = true;");
    app = await startServer({ root, port: 0 });
    const eventResponse = await fetch(`http://127.0.0.1:${app.port}/api/events`);
    reader = eventResponse.body.getReader();
    const events = createSseEventReader(reader);
    await events.next((event) => event.event === "ready");
    write(root, "src/invoices.service.ts", "export class InvoicesService {}");
    write(root, "src/payments.service.ts", "export class PaymentsService {}");

    const event = await events.next((candidate) => candidate.event === "graph");
    const update = JSON.parse(event.data);
    assert.equal(update.reason, "filesystem");
    assert.equal(update.addedFileCount, 2);
    assert.equal(update.addedFilesTruncated, false);
    assert.deepEqual(update.addedFiles, [
      { id: "file:src/invoices.service.ts", label: "Invoices Service", path: "src/invoices.service.ts", type: "service" },
      { id: "file:src/payments.service.ts", label: "Payments Service", path: "src/payments.service.ts", type: "service" },
    ]);
  } finally {
    if (reader) await reader.cancel();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AST analysis keeps SvelteKit aliases internal and layers dependencies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-svelte-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({
      name: "svelte-example",
      devDependencies: { "@sveltejs/kit": "1.0.0", vite: "1.0.0", tailwindcss: "1.0.0" },
    }));
    write(root, "src/routes/+page.server.ts", "import type { RequestHandler } from '@sveltejs/kit';\nimport { getUser } from '$lib/server/auth';\nimport { db } from 'drizzle-orm';\nexport const GET: RequestHandler = async () => new Response(getUser(db));");
    write(root, "src/lib/server/auth.ts", "export function getUser(db: unknown) { return db ? 'ok' : 'missing'; }");
    write(root, "vite.config.ts", "import { defineConfig } from 'vite';\nexport default defineConfig({});");
    write(root, "src/routes/+page.svelte", "<script lang=\"ts\">export let data: { name: string };</script><h1>{data.name}</h1>");

    const graph = scanRepository(root);
    const route = graph.nodes.find((node) => node.kind === "file" && node.path === "src/routes/+page.server.ts");
    const auth = graph.nodes.find((node) => node.path === "src/lib/server/auth.ts");
    const drizzle = graph.nodes.find((node) => node.id === "external:drizzle-orm");
    const vite = graph.nodes.find((node) => node.id === "external:vite");
    assert.equal(route.label, "Route /");
    assert.equal(route.analysis.parser, "typescript-ast");
    assert.equal(route.layer, "application");
    assert.ok(graph.edges.some((edge) => edge.source === route.id && edge.target === auth.id && edge.confidence === "exact"));
    assert.equal(drizzle.layer, "runtime");
    assert.equal(vite.layer, "devtool");
    assert.equal(graph.nodes.some((node) => node.id.includes("$lib")), false);
    assert.equal(graph.stats.inventoryOnlyFiles, 0);

    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const applicationView = await (await fetch(`${baseUrl}/api/view`)).json();
    const runtimeView = await (await fetch(`${baseUrl}/api/view?scope=runtime`)).json();
    const devtoolView = await (await fetch(`${baseUrl}/api/view?scope=devtool`)).json();
    assert.ok(applicationView.nodes.every((node) => node.kind === "summary"));
    assert.ok(runtimeView.nodes.some((node) => node.memberIds.includes("external:drizzle-orm")));
    assert.ok(devtoolView.nodes.some((node) => node.memberIds.includes("external:vite")));
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript paths and baseUrl aliases resolve to internal files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-tsconfig-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "tsconfig-example" }));
    write(root, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        baseUrl: "./src",
        paths: { "@features/*": ["features/*"], "@settings": ["config/settings"] },
      },
    }));
    write(root, "src/api/orders.ts", "import { placeOrder } from '@features/orders/service';\nimport { settings } from '@settings';\nimport { logger } from 'shared/logger';\nexport const order = () => placeOrder(settings, logger);");
    write(root, "src/features/orders/service.ts", "export const placeOrder = () => 'ok';");
    write(root, "src/config/settings.ts", "export const settings = {}; ");
    write(root, "src/shared/logger.ts", "export const logger = console;");

    const graph = scanRepository(root);
    const orders = graph.nodes.find((node) => node.kind === "file" && node.path === "src/api/orders.ts");
    const importedPaths = graph.edges
      .filter((edge) => edge.source === orders.id && edge.type === "imports")
      .map((edge) => graph.nodes.find((node) => node.id === edge.target).path)
      .sort();
    assert.deepEqual(importedPaths, ["src/config/settings.ts", "src/features/orders/service.ts", "src/shared/logger.ts"]);
    assert.equal(graph.nodes.some((node) => node.id === "external:@features/orders" || node.id === "external:shared"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("TypeScript paths inherited through tsconfig extends resolve to internal files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-tsconfig-extends-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "tsconfig-extends-example" }));
    write(root, "tsconfig.base.json", JSON.stringify({ compilerOptions: { baseUrl: "./src", paths: { "@shared/*": ["shared/*"] } } }));
    write(root, "tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json" }));
    write(root, "src/api/orders.ts", "import { logger } from '@shared/logger';\nexport const order = () => logger;");
    write(root, "src/shared/logger.ts", "export const logger = console;");

    const graph = scanRepository(root);
    const orders = graph.nodes.find((node) => node.kind === "file" && node.path === "src/api/orders.ts");
    const logger = graph.nodes.find((node) => node.kind === "file" && node.path === "src/shared/logger.ts");
    assert.ok(graph.edges.some((edge) => edge.source === orders.id && edge.target === logger.id && edge.type === "imports"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("static Vite and Webpack aliases resolve to internal files without executing config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-bundler-alias-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "bundler-alias-example" }));
    write(root, "vite.config.ts", "throw new Error('config must not execute');\nimport path from 'node:path';\nconst ui = path.resolve(__dirname, 'src/ui');\nconst shared = fileURLToPath(new URL('./shared', import.meta.url));\nconst esmDir = path.dirname(fileURLToPath(import.meta.url));\nconst esm = path.resolve(esmDir, 'src/esm');\nconst cwd = path.resolve(process.cwd(), 'src/cwd');\nexport default { resolve: { alias: { '@ui': ui, '@shared': shared, '@esm': esm, '@cwd': cwd } } };");
    write(root, "webpack.config.cjs", "const path = require('node:path');\nconst api = path.join(__dirname, 'api');\nmodule.exports = { resolve: { alias: { '#api': api } } };");
    write(root, "src/main.ts", "import { Button } from '@ui/Button';\nimport { logger } from '@shared/logger';\nimport { client } from '#api/client';\nimport { esm } from '@esm/config';\nimport { cwd } from '@cwd/config';\nexport const startup = () => [Button, logger, client, esm, cwd];");
    write(root, "src/ui/Button.ts", "export const Button = 'button';");
    write(root, "shared/logger.ts", "export const logger = console;");
    write(root, "api/client.ts", "export const client = {}; ");
    write(root, "src/esm/config.ts", "export const esm = true;");
    write(root, "src/cwd/config.ts", "export const cwd = true;");

    const graph = scanRepository(root);
    const main = graph.nodes.find((node) => node.kind === "file" && node.path === "src/main.ts");
    const importedPaths = graph.edges
      .filter((edge) => edge.source === main.id && edge.type === "imports")
      .map((edge) => graph.nodes.find((node) => node.id === edge.target).path)
      .sort();
    assert.deepEqual(importedPaths, ["api/client.ts", "shared/logger.ts", "src/cwd/config.ts", "src/esm/config.ts", "src/ui/Button.ts"]);
    assert.equal(graph.nodes.some((node) => node.id === "external:@ui/Button" || node.id === "external:#api/client" || node.id === "external:@esm/config" || node.id === "external:@cwd/config"), false);
    assert.ok(graph.analysis.resolution.internal.includes("literal aliases from exported Vite/Webpack configs"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("static bundler aliases use only exported configuration objects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-exported-bundler-alias-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "exported-bundler-alias-example" }));
    write(root, "vite.config.ts", "import path from 'node:path';\nconst testFixture = { resolve: { alias: { '@fixture': path.resolve(__dirname, 'fixtures') } } };\nconst config = { resolve: { alias: [{ find: '@app', replacement: path.resolve(__dirname, 'src/app') }] } };\nexport default defineConfig(config);");
    write(root, "src/main.ts", "import { app } from '@app/entry';\nimport { fixture } from '@fixture/private';\nexport const startup = () => [app, fixture];");
    write(root, "src/app/entry.ts", "export const app = true;");
    write(root, "fixtures/private.ts", "export const fixture = true;");

    const graph = scanRepository(root);
    const main = graph.nodes.find((node) => node.id === "file:src/main.ts");
    assert.ok(graph.edges.some((edge) => edge.source === main.id && edge.type === "imports" && edge.target === "file:src/app/entry.ts"));
    assert.ok(graph.nodes.some((node) => node.id === "external:@fixture/private"));
    assert.equal(graph.edges.some((edge) => edge.source === main.id && edge.type === "imports" && edge.target === "file:fixtures/private.ts"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("nearest package.json imports aliases resolve literal and wildcard targets internally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-package-imports-"));
  try {
    write(root, "package.json", JSON.stringify({
      name: "package-imports-example",
      imports: { "#config": "./src/config/runtime.ts", "#features/*": "./src/features/*.ts" },
    }));
    write(root, "src/main.ts", "import { config } from '#config';\nimport { payment } from '#features/payment';\nexport const startup = () => [config, payment];");
    write(root, "src/config/runtime.ts", "export const config = {}; ");
    write(root, "src/features/payment.ts", "export const payment = {}; ");

    const graph = scanRepository(root);
    const main = graph.nodes.find((node) => node.kind === "file" && node.path === "src/main.ts");
    const importedPaths = graph.edges
      .filter((edge) => edge.source === main.id && edge.type === "imports")
      .map((edge) => graph.nodes.find((node) => node.id === edge.target).path)
      .sort();
    assert.deepEqual(importedPaths, ["src/config/runtime.ts", "src/features/payment.ts"]);
    assert.equal(graph.nodes.some((node) => node.id === "external:#config" || node.id === "external:#features/payment"), false);
    assert.ok(graph.analysis.resolution.internal.includes("package.json imports aliases"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("declared npm workspaces resolve package entries and literal exports internally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-workspace-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "workspace-example", workspaces: ["packages/*"] }));
    write(root, "packages/core/package.json", JSON.stringify({ name: "@example/core", exports: { ".": "./src/index.ts", "./billing": "./src/billing.ts", "./features/*": "./src/features/*.ts" } }));
    write(root, "packages/core/src/index.ts", "export const core = 'core';");
    write(root, "packages/core/src/billing.ts", "export const billing = 'billing';");
    write(root, "packages/core/src/features/receipts.ts", "export const receipts = 'receipts';");
    write(root, "apps/web/src/main.ts", "import { core } from '@example/core';\nimport { billing } from '@example/core/billing';\nimport { receipts } from '@example/core/features/receipts';\nexport const startup = () => `${core}:${billing}:${receipts}`;");

    const graph = scanRepository(root);
    const app = graph.nodes.find((node) => node.path === "apps/web/src/main.ts");
    const importedPaths = graph.edges
      .filter((edge) => edge.source === app.id && edge.type === "imports")
      .map((edge) => graph.nodes.find((node) => node.id === edge.target).path)
      .sort();
    assert.deepEqual(importedPaths, ["packages/core/src/billing.ts", "packages/core/src/features/receipts.ts", "packages/core/src/index.ts"]);
    assert.equal(graph.nodes.some((node) => node.id === "external:@example/core"), false);
    assert.ok(graph.analysis.resolution.internal.includes("declared npm and pnpm workspace package entries"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace package export condition trees resolve static root and nested targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-export-conditions-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "export-condition-example", workspaces: ["packages/*"] }));
    write(root, "packages/root/package.json", JSON.stringify({
      name: "@example/root",
      exports: {
        import: "./src/root.ts",
        require: "./src/legacy.ts",
        default: "./src/fallback.ts",
      },
    }));
    write(root, "packages/root/src/root.ts", "export const root = true;");
    write(root, "packages/root/src/legacy.ts", "export const legacy = true;");
    write(root, "packages/root/src/fallback.ts", "export const fallback = true;");
    write(root, "packages/server/package.json", JSON.stringify({
      name: "@example/server",
      exports: { "./server": { node: { import: "./src/server.ts", default: "./src/server-fallback.ts" }, default: "./src/browser.ts" } },
    }));
    write(root, "packages/server/src/server.ts", "export const server = true;");
    write(root, "packages/server/src/server-fallback.ts", "export const serverFallback = true;");
    write(root, "packages/server/src/browser.ts", "export const browser = true;");
    write(root, "apps/web/src/main.ts", "import { root } from '@example/root';\nimport { server } from '@example/server/server';\nexport const startup = () => `${root}:${server}`;");

    const graph = scanRepository(root);
    const app = graph.nodes.find((node) => node.kind === "file" && node.path === "apps/web/src/main.ts");
    const importedPaths = graph.edges
      .filter((edge) => edge.source === app.id && edge.type === "imports")
      .map((edge) => graph.nodes.find((node) => node.id === edge.target).path)
      .sort();
    assert.deepEqual(importedPaths, ["packages/root/src/root.ts", "packages/server/src/server.ts"]);
    assert.ok(graph.analysis.resolution.internal.includes("static import/node/default/require/types package condition trees"));
    assert.ok(graph.analysis.resolution.limitations.some((value) => value.includes("custom package conditions")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("literal pnpm workspace package entries resolve internal package imports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-pnpm-workspace-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "pnpm-workspace-example" }));
    write(root, "pnpm-workspace.yaml", "# Keep workspace declarations static.\npackages:\n  - 'packages/*'\n  - \"apps/*\"\ncatalog:\n  typescript: 5.0.0\n");
    write(root, "packages/core/package.json", JSON.stringify({ name: "@example/core", exports: { "./billing": "./src/billing.ts" } }));
    write(root, "packages/core/src/billing.ts", "export const billing = 'billing';");
    write(root, "apps/web/src/main.ts", "import { billing } from '@example/core/billing';\nexport const startup = () => billing;");

    const graph = scanRepository(root);
    const app = graph.nodes.find((node) => node.kind === "file" && node.path === "apps/web/src/main.ts");
    const billing = graph.nodes.find((node) => node.kind === "file" && node.path === "packages/core/src/billing.ts");
    assert.ok(graph.edges.some((edge) => edge.source === app.id && edge.target === billing.id && edge.type === "imports"));
    assert.equal(graph.nodes.some((node) => node.id === "external:@example/core"), false);
    assert.ok(graph.analysis.resolution.internal.includes("declared npm and pnpm workspace package entries"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("inline pnpm workspace patterns honor static exclusions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-pnpm-inline-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "pnpm-inline-example" }));
    write(root, "pnpm-workspace.yaml", "packages: [ 'packages/*', '!packages/ignored' ] # static paths only\n");
    write(root, "packages/core/package.json", JSON.stringify({ name: "@example/core", main: "./src/index.ts" }));
    write(root, "packages/core/src/index.ts", "export const core = 'core';");
    write(root, "packages/ignored/package.json", JSON.stringify({ name: "@example/ignored", main: "./src/index.ts" }));
    write(root, "packages/ignored/src/index.ts", "export const ignored = 'ignored';");
    write(root, "apps/web/src/main.ts", "import { core } from '@example/core';\nimport { ignored } from '@example/ignored';\nexport const startup = () => core + ignored;");

    const graph = scanRepository(root);
    const app = graph.nodes.find((node) => node.id === "file:apps/web/src/main.ts");
    const core = graph.nodes.find((node) => node.id === "file:packages/core/src/index.ts");
    assert.ok(graph.edges.some((edge) => edge.source === app.id && edge.target === core.id && edge.type === "imports"));
    assert.ok(graph.nodes.some((node) => node.id === "external:@example/ignored"));
    assert.equal(graph.nodes.some((node) => node.id === "external:@example/core"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Yarn PnP data resolves an in-repository package without executing .pnp.cjs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-yarn-pnp-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "pnp-example" }));
    write(root, ".pnp.cjs", "throw new Error('must not execute');");
    write(root, ".pnp.data.json", JSON.stringify({ packageRegistryData: [["@example/core", [["workspace:packages/core", { packageLocation: "./packages/core/" }]]]] }));
    write(root, "packages/core/package.json", JSON.stringify({ name: "@example/core", main: "./src/index.ts" }));
    write(root, "packages/core/src/index.ts", "export const core = 'ok';");
    write(root, "apps/web/src/main.ts", "import { core } from '@example/core';\nexport const startup = () => core;");
    const graph = scanRepository(root);
    const app = graph.nodes.find((node) => node.id === "file:apps/web/src/main.ts");
    const core = graph.nodes.find((node) => node.id === "file:packages/core/src/index.ts");
    assert.ok(graph.edges.some((edge) => edge.source === app.id && edge.target === core.id && edge.type === "imports"));
    assert.equal(graph.nodes.some((node) => node.id === "external:@example/core"), false);
    assert.ok(graph.analysis.resolution.internal.includes("static Yarn PnP JSON workspace package entries"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("NestJS literal decorators and Fastify factory routes produce exact endpoint facts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-frameworks-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "framework-example" }));
    write(root, "src/orders/orders.controller.ts", "import { Controller as NestController, Get, Post } from '@nestjs/common';\n@NestController('orders')\nexport class OrdersController {\n  @Get(':id')\n  findOne() {}\n  @Post()\n  create() {}\n}");
    write(root, "src/server.ts", "import Fastify from 'fastify';\nconst api = Fastify();\napi.get('/health', async () => ({ ok: true }));");

    const graph = scanRepository(root);
    const endpoints = graph.nodes.filter((node) => node.kind === "endpoint").map((node) => node.label).sort();
    assert.deepEqual(endpoints, ["GET /health", "GET /orders/:id", "POST /orders"]);
    assert.ok(graph.nodes.filter((node) => node.kind === "endpoint").every((node) => node.analysis.confidence === "exact" && node.evidence.range.start.line > 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Python syntax analysis resolves package imports and marks decorator endpoints as likely", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-python-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "python-example" }));
    write(root, "src/payments/routes.py", "from .service import PaymentService\nfrom fastapi import APIRouter\nrouter = APIRouter()\n@router.get('/payments/{payment_id}')\ndef get_payment():\n    return PaymentService.find()\n");
    write(root, "src/payments/service.py", "from .repository import PaymentRepository\nclass PaymentService:\n    def find():\n        return PaymentRepository.get()\n");
    write(root, "src/payments/repository.py", "class PaymentRepository:\n    def get():\n        return {}\n");
    write(root, "src/payments/service_test.py", "from payments.service import PaymentService\ndef service_test():\n    assert PaymentService.find() is not None\n");

    const graph = scanRepository(root);
    const routes = graph.nodes.find((node) => node.kind === "file" && node.path === "src/payments/routes.py");
    const service = graph.nodes.find((node) => node.kind === "file" && node.path === "src/payments/service.py");
    const repository = graph.nodes.find((node) => node.kind === "file" && node.path === "src/payments/repository.py");
    const endpoint = graph.nodes.find((node) => node.kind === "endpoint" && node.label === "GET /payments/{payment_id}");
    const testNode = graph.nodes.find((node) => node.kind === "file" && node.path === "src/payments/service_test.py");
    assert.equal(routes.analysis.parser, "python-lezer");
    assert.ok(graph.edges.some((edge) => edge.source === routes.id && edge.target === service.id && edge.type === "imports"));
    assert.ok(graph.edges.some((edge) => edge.source === service.id && edge.target === repository.id && edge.type === "imports"));
    assert.ok(graph.edges.some((edge) => edge.source === testNode.id && edge.target === service.id && edge.type === "imports"));
    assert.equal(endpoint.analysis.confidence, "likely");
    assert.equal(graph.nodes.find((node) => node.id === "external:fastapi").layer, "framework");
    assert.ok(graph.nodes.some((node) => node.kind === "symbol" && node.type === "class" && node.label === "PaymentService"));
    assert.ok(graph.nodes.some((node) => node.kind === "symbol" && node.type === "function" && node.label === "get_payment"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Python Flask and Blueprint route decorators use only literal HTTP method lists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-python-flask-routes-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "python-flask-route-example" }));
    write(root, "src/routes.py", "from flask import Flask, Blueprint as Group\napp = Flask(__name__)\norders = Group('orders', __name__)\n\n@app.route('/health')\ndef health():\n    return {}\n\n@orders.route('/orders', methods=['POST', 'PUT'])\ndef update_orders():\n    return {}\n\n@app.route('/dynamic', methods=METHODS)\ndef dynamic():\n    return {}\n");

    const graph = scanRepository(root);
    const endpoints = graph.nodes.filter((node) => node.kind === "endpoint").map((node) => node.label).sort();
    assert.deepEqual(endpoints, ["GET /health", "POST /orders", "PUT /orders"]);
    assert.ok(graph.nodes.filter((node) => node.kind === "endpoint").every((node) => node.analysis.confidence === "likely"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Python direct local and named-import function calls create exact symbol edges", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-python-calls-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "python-call-example" }));
    write(root, "src/payments/helpers.py", "def normalize(amount):\n    return amount\n\ndef validate(amount):\n    return normalize(amount)\n");
    write(root, "src/payments/service.py", "from .helpers import validate as check\n\ndef submit(amount):\n    return check(amount)\n");
    write(root, "src/payments/shadow.py", "from .helpers import validate\n\ndef submit(validate):\n    return validate()\n");

    const graph = scanRepository(root);
    const validate = graph.nodes.find((node) => node.id === "symbol:src/payments/helpers.py:function:validate");
    const normalize = graph.nodes.find((node) => node.id === "symbol:src/payments/helpers.py:function:normalize");
    const submit = graph.nodes.find((node) => node.id === "symbol:src/payments/service.py:function:submit");
    const shadowedSubmit = graph.nodes.find((node) => node.id === "symbol:src/payments/shadow.py:function:submit");
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === validate.id && edge.target === normalize.id && edge.confidence === "exact"));
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === submit.id && edge.target === validate.id && edge.confidence === "exact"));
    assert.equal(graph.edges.some((edge) => edge.type === "calls" && edge.source === shadowedSubmit.id && edge.target === validate.id), false);
    assert.equal(graph.stats.calls, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Next.js route handlers use their file-system routes and static fetch calls become request facts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-next-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "next-example" }));
    write(root, "src/app/api/me/route.ts", "export const GET = async () => Response.json({ ok: true });");
    write(root, "src/components/ProfileButton.tsx", "export function ProfileButton() { return fetch('/api/me'); }");

    const graph = scanRepository(root);
    const endpoint = graph.nodes.find((node) => node.kind === "endpoint" && node.label === "GET /api/me");
    const component = graph.nodes.find((node) => node.path === "src/components/ProfileButton.tsx");
    assert.ok(endpoint);
    assert.ok(component);
    assert.ok(graph.edges.some((edge) => edge.source === component.id && edge.target === endpoint.id && edge.type === "requests"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Next.js Flow Lenses bind each HTTP endpoint to its exact handler symbol", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-next-handlers-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "next-handler-binding" }));
    write(root, "src/app/api/payments/[paymentId]/route.ts", [
      "export async function GET() { return Response.json({ method: 'GET' }); }",
      "export async function POST() { return Response.json({ method: 'POST' }); }",
      "export async function PATCH() { return Response.json({ method: 'PATCH' }); }",
      "export async function DELETE() { return Response.json({ method: 'DELETE' }); }",
    ].join("\n"));
    const graph = scanRepository(root);
    const endpoint = graph.nodes.find((node) => node.kind === "endpoint" && node.label === "GET /api/payments/:paymentId");
    assert.ok(endpoint);
    assert.equal(endpoint.handlerBinding, "exact-symbol");
    assert.equal(endpoint.handlerId, "symbol:src/app/api/payments/[paymentId]/route.ts:function:GET");
    assert.ok(graph.edges.some((edge) => edge.source === endpoint.id && edge.target === endpoint.handlerId && edge.type === "handles"));
    const lens = getFlowProjection(graph, `flow:${endpoint.id}`);
    assert.equal(lens.handlerEvidence.binding, "exact-handler");
    assert.equal(lens.handlerEvidence.siblingHandlerContamination, false);
    assert.ok(lens.steps.some((step) => step.id === endpoint.handlerId));
    assert.equal(lens.steps.some((step) => /:(POST|PATCH|DELETE)$/.test(step.id)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Next.js Flow Lens exposes only handler-specific literal request and response contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-next-contract-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "next-contract-example" }));
    write(root, "src/app/api/payments/route.ts", [
      "export async function GET() { return Response.json({ sibling: true }, { status: 200 }); }",
      "export async function POST(request: Request) {",
      "  const payload: { amount: number; memo?: string } = await request.json();",
      "  if (payload.amount <= 0) return Response.json({ error: 'invalid_amount' }, { status: 400 });",
      "  return Response.json({ id: 'payment_1', accepted: true }, { status: 201 });",
      "}",
      "export async function PATCH(request: Request) { const payload = await request.json(); return Response.json(payload, { status: 200 }); }",
    ].join("\n"));

    const graph = scanRepository(root);
    const post = graph.nodes.find((node) => node.kind === "endpoint" && node.label === "POST /api/payments");
    const patch = graph.nodes.find((node) => node.kind === "endpoint" && node.label === "PATCH /api/payments");
    assert.equal(post.contract.schemaVersion, "flopeek-next-route-contract/v1");
    assert.equal(post.contract.request.status, "available");
    assert.deepEqual(post.contract.request.fields.map((field) => ({ name: field.name, type: field.type, required: field.required })), [
      { name: "amount", type: "number", required: true },
      { name: "memo", type: "string", required: false },
    ]);
    assert.equal(post.contract.responses.status, "available");
    assert.deepEqual(post.contract.responses.variants.map((variant) => variant.status), [201, 400]);
    assert.equal(post.contract.responses.variants.some((variant) => variant.fields.some((field) => field.name === "sibling")), false);
    assert.equal(patch.contract.request.status, "unavailable");
    assert.equal(patch.contract.responses.status, "unavailable");

    const lens = getFlowProjection(graph, `flow:${post.id}`);
    assert.equal(lens.flowInterface.request.status, "available");
    assert.equal(lens.flowInterface.request.evidenceClass, "parser-fact");
    assert.deepEqual(lens.flowInterface.responses.variants.map((variant) => variant.status), [201, 400]);
    assert.equal(lens.flowInterface.responses.variants.some((variant) => variant.fields.some((field) => field.name === "sibling")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Flow discovery is never silently capped at fifty endpoints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-many-endpoints-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "many-endpoints" }));
    for (let index = 1; index <= 52; index += 1) write(root, `src/app/api/items/${index}/route.ts`, "export const GET = async () => Response.json({ ok: true });");
    const graph = scanRepository(root);
    assert.equal(graph.nodes.filter((node) => node.kind === "endpoint").length, 52);
    assert.equal(graph.flows.length, 52);
    const view = projectView(graph);
    assert.equal(view.flows.length, 52);
    assert.deepEqual(view.flowCatalog, { total: 52, returned: 52, omittedFlowIds: [], truncated: false, warning: null });
    assert.equal(view.aiContext.semanticSuggestions.truncated, true);
    assert.equal(view.aiContext.semanticSuggestions.omittedFlowIds.length, 40);
    assert.match(view.aiContext.semanticSuggestions.warning, /40 detected flow suggestion/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Next.js action routes receive deterministic action-specific semantic titles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-action-semantics-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "action-semantics" }));
    const cases = [
      ["POST", "login", "Sign In"], ["POST", "logout", "Sign Out"], ["POST", "accept-invite", "Accept Invite"],
      ["GET", "invite-lookup", "Look Up Invite"], ["POST", "join-codes/redeem", "Redeem Join Code"],
      ["POST", "payments/[paymentId]/approve", "Approve Payment"], ["POST", "payments/[paymentId]/reject", "Reject Payment"],
      ["POST", "payments/[paymentId]/undo", "Undo Payment"], ["POST", "reminders/[reminderId]/remind", "Send Reminder"],
      ["POST", "settlements/[settlementId]/settle", "Settle Settlement"], ["POST", "groups/[groupId]/exit", "Exit Group"],
      ["POST", "users/[userId]/verify", "Verify User"], ["POST", "pusher/auth", "Authenticate Pusher"],
      ["POST", "uploads/cloudinary", "Upload To Cloudinary"], ["GET", "reminders", "List Reminders"], ["GET", "me", "Get Current User"],
    ];
    for (const [method, route] of cases) write(root, `src/app/api/${route}/route.ts`, `export const ${method} = async () => Response.json({ ok: true });`);
    const graph = scanRepository(root);
    for (const [method, route, expectedTitle] of cases) {
      const routePath = `/api/${route.replaceAll("[paymentId]", ":paymentId").replaceAll("[reminderId]", ":reminderId").replaceAll("[settlementId]", ":settlementId").replaceAll("[groupId]", ":groupId").replaceAll("[userId]", ":userId")}`;
      const endpoint = graph.nodes.find((node) => node.label === `${method} ${routePath}`);
      assert.ok(endpoint, `${method} ${routePath}`);
      const suggestion = createSemanticFlowSuggestion(graph, getFlowProjection(graph, `flow:${endpoint.id}`));
      assert.equal(suggestion.candidate.title, expectedTitle, `${method} ${routePath}`);
      if (method === "POST" && /(?:login|logout|accept-invite|redeem|approve|reject|undo|remind|settle|exit|verify|auth|cloudinary)$/.test(route)) assert.equal(suggestion.candidate.title.startsWith("Create "), false, `${method} ${routePath} must not default to Create`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy descriptions migrate into the .flopeek cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-cache-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "cache-example" }));
    write(root, "src/legacy.service.ts", "export class LegacyService {}");
    write(root, ".project-flow/descriptions.json", JSON.stringify({ "file:src/legacy.service.ts": "Preserve this verified description." }));
    const graph = scanRepository(root);
    assert.equal(graph.nodes.find((node) => node.id === "file:src/legacy.service.ts").manualDescription, "Preserve this verified description.");
    saveDescription(root, "file:src/legacy.service.ts", "Updated verified description.");
    assert.equal(safelyRead(path.join(root, ".flopeek", "descriptions.json"))["file:src/legacy.service.ts"], "Updated verified description.");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MCP server exposes deterministic graph tools over stdio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-mcp-"));
  let client;
  let transport;
  try {
    write(root, "package.json", JSON.stringify({ name: "mcp-example", scripts: { serve: "node src/payment/payment.routes.ts" } }));
    write(root, "src/payment/payment.routes.ts", "import { PaymentService } from './payment.service';\nrouter.post('/payments', () => PaymentService.authorize());");
    write(root, "src/payment/payment.service.ts", "export class PaymentService { static authorize() {} }");
    write(root, "src/payment/payment.service.spec.ts", "import { PaymentService } from './payment.service';\ntest('authorizes', () => PaymentService.authorize());");
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "src", "cli.js"), "mcp", root],
      cwd: path.join(__dirname, ".."),
      stderr: "pipe",
    });
    client = new Client({ name: "flopeek-test-client", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "assign_workflow",
      "cancel_scan",
      "compare_git_snapshots",
      "create_continuation_checkpoint",
      "create_git_snapshot",
      "create_planned_overlay",
      "create_work_record",
      "find_nodes",
      "get_active_branch_git_evidence",
      "get_agent_bootstrap",
      "get_agent_context",
      "get_agent_evidence_traces",
      "get_agent_semantic_proposal",
      "get_cache_hygiene",
      "get_change_impact",
      "get_changed_contexts",
      "get_checkpoint_divergence",
      "get_context_card",
      "get_continuation_checkpoint",
      "get_continuation_comparison",
      "get_continuation_context",
      "get_direct_dependencies",
      "get_entry_flows",
      "get_flow_comparison",
      "get_flow_context_card",
      "get_flow_projection",
      "get_flow_verification",
      "get_git_context_continuity",
      "get_graph_delta",
      "get_handoff_context",
      "get_node",
      "get_plan_reconciliation",
      "get_planned_overlay",
      "get_product_proof",
      "get_project_overview",
      "get_related_implementations",
      "get_related_tests",
      "get_request_flows",
      "get_scan_status",
      "get_semantic_suggestion_feedback",
      "get_test_runs",
      "get_trust_analytics",
      "get_verified_semantic_memory",
      "get_view_projection",
      "get_work_dependency_status",
      "get_work_record_workflow",
      "get_work_timeline",
      "list_continuation_checkpoints",
      "list_plan_reconciliations",
      "list_planned_overlays",
      "list_work_records",
      "list_workflows",
      "record_agent_evidence_trace",
      "record_agent_semantic_proposal",
      "record_plan_reconciliation",
      "record_semantic_suggestion_feedback",
      "record_test_run_event",
      "record_work_event",
      "refresh_graph",
      "resolve_context_ref",
      "resolve_plan_ref",
      "transition_work_record",
    ]);
    const recordTraceTool = tools.tools.find((tool) => tool.name === "record_agent_evidence_trace");
    assert.equal(recordTraceTool.annotations.readOnlyHint, false);
    assert.equal(recordTraceTool.annotations.destructiveHint, false);
    assert.equal(recordTraceTool.annotations.idempotentHint, true);
    const recordFeedbackTool = tools.tools.find((tool) => tool.name === "record_semantic_suggestion_feedback");
    assert.equal(recordFeedbackTool.annotations.readOnlyHint, false);
    assert.equal(recordFeedbackTool.annotations.destructiveHint, false);
    assert.equal(recordFeedbackTool.annotations.idempotentHint, true);
    for (const name of ["record_agent_semantic_proposal", "record_plan_reconciliation", "record_test_run_event", "assign_workflow", "create_continuation_checkpoint", "create_planned_overlay", "create_work_record", "record_work_event", "transition_work_record"]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.idempotentHint, true);
    }
    for (const name of ["get_flow_projection", "get_flow_context_card"]) {
      const maxStepsSchema = tools.tools.find((tool) => tool.name === name).inputSchema.properties.maxSteps;
      assert.equal(maxStepsSchema.minimum, 1);
      assert.equal(maxStepsSchema.maximum, 24);
      assert.equal(maxStepsSchema.type, "integer");
    }
    const initialScan = await waitFor(async () => {
      const result = await client.callTool({ name: "get_scan_status", arguments: {} });
      if (result.isError) return null;
      const status = JSON.parse(result.content.find((item) => item.type === "text").text);
      return status.status === "complete" ? status : null;
    });
    assert.equal(initialScan.activeGraph.freshness, "current");
    const result = await client.callTool({ name: "find_nodes", arguments: { query: "Payment" } });
    assert.equal(result.isError, undefined);
    const text = result.content.find((item) => item.type === "text").text;
    const payload = JSON.parse(text);
    assert.ok(payload.results.some((node) => node.label === "Payment Service"));
    const entryFlowResult = await client.callTool({ name: "get_entry_flows", arguments: { query: "serve" } });
    assert.equal(entryFlowResult.isError, undefined);
    const entryFlows = JSON.parse(entryFlowResult.content.find((item) => item.type === "text").text);
    assert.equal(entryFlows.entryFamilies.command, 1);
    assert.equal(entryFlows.flows[0].entry.kind, "package-script");
    const scanStatusResult = await client.callTool({ name: "get_scan_status", arguments: {} });
    assert.equal(scanStatusResult.isError, undefined);
    const scanStatus = JSON.parse(scanStatusResult.content.find((item) => item.type === "text").text);
    assert.equal(scanStatus.schemaVersion, "flopeek-scan-outcome/v1");
    assert.equal(scanStatus.status, "complete");
    assert.equal(scanStatus.activeGraph.freshness, "current");
    assert.match(scanStatus.activeGraph.projectId, /^project:/);
    const cancelResult = await client.callTool({ name: "cancel_scan", arguments: {} });
    assert.equal(cancelResult.isError, undefined);
    const cancellation = JSON.parse(cancelResult.content.find((item) => item.type === "text").text);
    assert.equal(cancellation.accepted, false);
    assert.equal(cancellation.reason, "no-scan-running");
    const impactResult = await client.callTool({ name: "get_change_impact", arguments: { paths: ["src/payment/payment.service.ts"] } });
    assert.equal(impactResult.isError, undefined);
    const impact = JSON.parse(impactResult.content.find((item) => item.type === "text").text);
    assert.ok(impact.recommendedTests.some((node) => node.path === "src/payment/payment.service.spec.ts"));
    const contextResult = await client.callTool({ name: "get_agent_context", arguments: { scope: "all" } });
    assert.equal(contextResult.isError, undefined);
    const context = JSON.parse(contextResult.content.find((item) => item.type === "text").text);
    assert.equal(context.repositoryScope.source, "defaults");
    assert.equal(context.repositoryScope.flowEntries.fixtures, false);
    assert.ok(context.repositoryScope.limitations.some((limitation) => limitation.includes("path-based")));
    assert.match(context.project.projectId, /^project:/);
    assert.equal(context.cache.graphSchemaVersion, 5);
    assert.equal(context.cacheState.status, "written");
    assert.equal(context.graphState.graphVersion, 1);
    assert.equal(context.handoffWorkspace.foreignImport.access, "read-only");
    assert.equal(context.handoffWorkspace.foreignImport.automaticAdoption, false);
    assert.equal(context.derivedCache.status, "available");
    assert.equal(context.derivedCache.policy.staleReuse, "never-silent");
    assert.equal(context.trustAnalytics.mcpTool, "get_trust_analytics");
    assert.equal(context.trustAnalytics.compositeScore, false);
    assert.equal(context.productProof.mcpTool, "get_product_proof");
    const bootstrapResult = await client.callTool({ name: "get_agent_bootstrap", arguments: {} });
    assert.equal(bootstrapResult.isError, undefined);
    const bootstrap = JSON.parse(bootstrapResult.content.find((item) => item.type === "text").text);
    assert.equal(bootstrap.schemaVersion, "flopeek-agent-bootstrap/v1");
    assert.equal(bootstrap.project.projectId, context.project.projectId);
    assert.equal(bootstrap.graph.graphVersion, context.graphState.graphVersion);
    assert.equal(bootstrap.policy.strategy, "graph-first-with-source-fallback");
    assert.equal(bootstrap.scan.status, "complete");
    assert.equal(bootstrap.readiness.currentSourceVerified, true);
    assert.equal(bootstrap.readiness.attachedHeadVerified, false);
    assert.equal(scanStatus.activeGraph.scopedSourceFreshness.status, "current");
    assert.equal(scanStatus.activeGraph.attachedHeadFreshness.status, "unavailable");
    const trustResult = await client.callTool({ name: "get_trust_analytics", arguments: {} });
    assert.equal(trustResult.isError, undefined);
    const trust = JSON.parse(trustResult.content.find((item) => item.type === "text").text);
    assert.equal(trust.schemaVersion, "flopeek-trust-analytics/v1");
    assert.equal(trust.project.projectId, context.project.projectId);
    assert.equal(trust.overallScore, null);
    const proofResult = await client.callTool({ name: "get_product_proof", arguments: {} });
    assert.equal(proofResult.isError, undefined);
    const proof = JSON.parse(proofResult.content.find((item) => item.type === "text").text);
    assert.equal(proof.schemaVersion, "flopeek-product-proof/v1");
    assert.equal(proof.currentRepository.projectId, context.project.projectId);
    assert.equal(proof.headlineMetrics.auditedRelationships, 92);
    assert.equal(proof.localBenchmark.status, "not-run");
    const handoffResult = await client.callTool({ name: "get_handoff_context", arguments: {
      taskIntent: "change payment authorization and inspect related tests",
      changedPaths: ["src/payment/payment.service.ts"],
      targetFeature: "payment",
      tokenBudget: 1600,
      desiredEvidenceDepth: "evidence",
    } });
    assert.equal(handoffResult.isError, undefined);
    const handoff = JSON.parse(handoffResult.content.find((item) => item.type === "text").text);
    assert.equal(handoff.schemaVersion, "flopeek-handoff-context/v1");
    assert.equal(handoff.budget.status, "within-budget");
    assert.deepEqual(handoff.pathResolution.matched.items, ["src/payment/payment.service.ts"]);
    assert.ok(handoff.included.features.some((item) => item.id === "feature:payment"));
    const cardResult = await client.callTool({ name: "get_context_card", arguments: { id: "file:src/payment/payment.service.ts" } });
    assert.equal(cardResult.isError, undefined);
    const packet = JSON.parse(cardResult.content.find((item) => item.type === "text").text);
    assert.equal(packet.card.kind, "node");
    const resolvedResult = await client.callTool({ name: "resolve_context_ref", arguments: { contextRef: packet.card.contextRef } });
    const resolved = JSON.parse(resolvedResult.content.find((item) => item.type === "text").text);
    assert.equal(resolved.status, "current");
    const traceResult = await client.callTool({ name: "record_agent_evidence_trace", arguments: {
      operationId: "mcp-test-payment-001",
      contextRef: packet.card.contextRef,
      actionType: "inspect",
      actionSummary: "Inspected the payment service Context Card.",
      changedPaths: [],
      verificationStatus: "not-run",
      verificationSummary: "No code change or verification command was required.",
      actor: "flopeek-test-client",
    } });
    assert.equal(traceResult.isError, undefined);
    const trace = JSON.parse(traceResult.content.find((item) => item.type === "text").text);
    assert.equal(trace.created, true);
    assert.equal(trace.record.context.ref, packet.card.contextRef);
    const traceListResult = await client.callTool({ name: "get_agent_evidence_traces", arguments: { operationId: "mcp-test-payment-001" } });
    const traceList = JSON.parse(traceListResult.content.find((item) => item.type === "text").text);
    assert.equal(traceList.totalMatched, 1);
    assert.equal(traceList.records[0].action.type, "inspect");
    const lensResult = await client.callTool({ name: "get_flow_projection", arguments: { flowId: "flow:endpoint:src/payment/payment.routes.ts:POST:/payments" } });
    assert.equal(lensResult.isError, undefined);
    const lens = JSON.parse(lensResult.content.find((item) => item.type === "text").text);
    assert.equal(lens.flow.title, "POST /payments");
    assert.equal(lens.steps[0].role, "entry");
    assert.equal(lens.semanticSuggestion.candidate.title, "Create Payment");
    assert.equal(lens.semanticSuggestion.knowledgeClass, "derived-suggestion");
    assert.equal(lens.flowInterface.request.status, "unavailable");
    assert.equal(lens.truncation.requestedMaxSteps, 12);
    const expandedLensResult = await client.callTool({ name: "get_flow_projection", arguments: { flowId: lens.flow.id, maxSteps: 24 } });
    assert.equal(expandedLensResult.isError, undefined);
    const expandedLens = JSON.parse(expandedLensResult.content.find((item) => item.type === "text").text);
    assert.equal(expandedLens.truncation.requestedMaxSteps, 24);
    for (const maxSteps of [0, 25, 1.5, "12"]) {
      for (const name of ["get_flow_projection", "get_flow_context_card"]) {
        const invalid = await client.callTool({ name, arguments: { flowId: lens.flow.id, maxSteps } });
        assert.equal(invalid.isError, true);
      }
    }
    const expandedFlowCardResult = await client.callTool({ name: "get_flow_context_card", arguments: { flowId: lens.flow.id, maxSteps: 24 } });
    assert.equal(expandedFlowCardResult.isError, undefined);
    const expandedFlowCard = JSON.parse(expandedFlowCardResult.content.find((item) => item.type === "text").text);
    assert.deepEqual(expandedFlowCard.card.projection.steps, expandedLens.steps);
    assert.deepEqual(expandedFlowCard.card.projection.truncation, expandedLens.truncation);
    const expandedMarkdownResult = await client.callTool({ name: "get_flow_context_card", arguments: { flowId: lens.flow.id, maxSteps: 24, format: "markdown" } });
    assert.equal(expandedMarkdownResult.isError, undefined);
    assert.match(JSON.parse(expandedMarkdownResult.content.find((item) => item.type === "text").text).markdown, /Requested maximum steps: 24/);
    const emptyProposalResult = await client.callTool({ name: "get_agent_semantic_proposal", arguments: { flowId: lens.flow.id } });
    const emptyProposal = JSON.parse(emptyProposalResult.content.find((item) => item.type === "text").text);
    assert.equal(emptyProposal.status, "missing");
    const proposalResult = await client.callTool({ name: "record_agent_semantic_proposal", arguments: {
      flowId: lens.flow.id,
      operationId: "mcp-test-payment-proposal-001",
      expectedFlowContextRef: lens.flow.contextRef,
      candidate: {
        title: "Authorize Payment",
        technicalPurpose: "Authorize a submitted payment through the detected payment service.",
        role: "command-action",
        grouping: { key: "payments", label: "Payments" },
        owner: "Payments",
        risk: "high",
        questions: ["Which decline codes are expected?"],
      },
      proposedBy: "flopeek-test-client",
      provider: "fixture-provider",
      rationale: "The current endpoint and service evidence support a bounded review draft.",
    } });
    assert.equal(proposalResult.isError, undefined);
    const proposal = JSON.parse(proposalResult.content.find((item) => item.type === "text").text);
    assert.equal(proposal.record.knowledgeClass, "agent-proposed");
    const currentProposalResult = await client.callTool({ name: "get_agent_semantic_proposal", arguments: { flowId: lens.flow.id } });
    const currentProposal = JSON.parse(currentProposalResult.content.find((item) => item.type === "text").text);
    assert.equal(currentProposal.status, "current");
    const stepId = lens.steps[0].id;
    for (const [sequence, eventType, extra] of [[0, "run-started", {}], [1, "step-started", { stepId }], [2, "step-failed", { stepId }]]) {
      const runEventResult = await client.callTool({ name: "record_test_run_event", arguments: {
        flowId: lens.flow.id,
        operationId: `mcp-test-run-001:${sequence}`,
        expectedFlowContextRef: lens.flow.contextRef,
        runId: "mcp-test-run-001",
        sequence,
        eventType,
        summary: `${eventType} fixture observation`,
        runner: "fixture-adapter",
        actor: "flopeek-test-client",
        observedAt: new Date(Date.UTC(2026, 6, 15, 8, 0, sequence)).toISOString(),
        ...extra,
      } });
      assert.equal(runEventResult.isError, undefined);
    }
    const runsResult = await client.callTool({ name: "get_test_runs", arguments: { flowId: lens.flow.id } });
    const runs = JSON.parse(runsResult.content.find((item) => item.type === "text").text);
    assert.equal(runs.runs[0].status, "failed");
    assert.equal(runs.runs[0].stoppedAtStepId, stepId);
    const emptyMemoryResult = await client.callTool({ name: "get_verified_semantic_memory", arguments: {} });
    const emptyMemory = JSON.parse(emptyMemoryResult.content.find((item) => item.type === "text").text);
    assert.equal(emptyMemory.records.length, 0);
    const semanticFeedbackResult = await client.callTool({ name: "get_semantic_suggestion_feedback", arguments: { flowId: lens.flow.id } });
    const semanticFeedback = JSON.parse(semanticFeedbackResult.content.find((item) => item.type === "text").text);
    assert.equal(semanticFeedback.status, "unreviewed");
    const flowTraceResult = await client.callTool({ name: "record_agent_evidence_trace", arguments: {
      operationId: "mcp-test-payment-flow-001",
      contextRef: lens.flow.contextRef,
      actionType: "test",
      actionSummary: "Ran the static payment flow contract.",
      changedPaths: [],
      verificationStatus: "passed",
      verificationSummary: "The MCP payment-flow contract passed.",
      actor: "flopeek-test-client",
    } });
    assert.equal(flowTraceResult.isError, undefined);
    const feedbackRecordResult = await client.callTool({ name: "record_semantic_suggestion_feedback", arguments: {
      flowId: lens.flow.id,
      operationId: "mcp-test-payment-feedback-001",
      decision: "accepted",
      reviewedBy: "Test reviewer",
      traceOperationId: "mcp-test-payment-flow-001",
    } });
    assert.equal(feedbackRecordResult.isError, undefined);
    const feedbackRecord = JSON.parse(feedbackRecordResult.content.find((item) => item.type === "text").text);
    assert.equal(feedbackRecord.created, true);
    assert.equal(feedbackRecord.record.decision, "accepted");
    const currentFeedbackResult = await client.callTool({ name: "get_semantic_suggestion_feedback", arguments: { flowId: lens.flow.id } });
    const currentFeedback = JSON.parse(currentFeedbackResult.content.find((item) => item.type === "text").text);
    assert.equal(currentFeedback.status, "current");
    const verificationResult = await client.callTool({ name: "get_flow_verification", arguments: { flowId: lens.flow.id } });
    assert.equal(verificationResult.isError, undefined);
    const verification = JSON.parse(verificationResult.content.find((item) => item.type === "text").text);
    assert.equal(verification.status, "unverified");
    assert.equal(verification.record, null);
    const flowCardResult = await client.callTool({ name: "get_flow_context_card", arguments: { flowId: lens.flow.id } });
    assert.equal(flowCardResult.isError, undefined);
    const flowPacket = JSON.parse(flowCardResult.content.find((item) => item.type === "text").text);
    assert.equal(flowPacket.card.kind, "flow");
    assert.equal(flowPacket.card.contextRef, lens.flow.contextRef);
    const flowRefResult = await client.callTool({ name: "resolve_context_ref", arguments: { contextRef: flowPacket.card.contextRef } });
    const flowResolution = JSON.parse(flowRefResult.content.find((item) => item.type === "text").text);
    assert.equal(flowResolution.status, "current");
    assert.equal(flowResolution.card.flow.id, lens.flow.id);
    write(root, "src/payment/tax.ts", "export function calculateTax() { return 0; }");
    const refreshed = await client.callTool({ name: "refresh_graph", arguments: { paths: ["src/payment/tax.ts"] } });
    assert.equal(refreshed.isError, undefined);
    const refreshPayload = JSON.parse(refreshed.content.find((item) => item.type === "text").text);
    assert.equal(refreshPayload.delta.available, true);
    assert.equal(refreshPayload.refresh.mode, "incremental");
    assert.equal(refreshPayload.refresh.analyzedFiles, 1);
    assert.equal(refreshPayload.refresh.reusedFiles, 3);
    assert.equal(refreshPayload.cacheState.status, "written");
    assert.equal(refreshPayload.derivedCacheInvalidation.status, "available");
    assert.ok(refreshPayload.derivedCacheInvalidation.events.some((event) => event.status === "invalidated"));
    assert.equal(refreshPayload.project.projectId, context.project.projectId);
    assert.equal(refreshPayload.graphState.graphVersion, 2);
    assert.equal(refreshPayload.persistedDelta.fromGraphVersion, 1);
    assert.equal(refreshPayload.persistedDelta.toGraphVersion, 2);
    assert.equal(refreshPayload.changedContexts.available, true);
    assert.ok(refreshPayload.changedContexts.nodes.some((node) => node.path === "src/payment/tax.ts"));
    const changedContextsResult = await client.callTool({ name: "get_changed_contexts", arguments: { fromVersion: 1, toVersion: 2 } });
    assert.equal(changedContextsResult.isError, undefined);
    const changedContexts = JSON.parse(changedContextsResult.content.find((item) => item.type === "text").text);
    assert.equal(changedContexts.available, true);
    assert.ok(changedContexts.nodes.some((node) => node.path === "src/payment/tax.ts" && node.status === "added"));
    write(root, "src/payment/payment.service.ts", "export class PaymentService { static authorize() { return false; } }");
    const sourceRefresh = await client.callTool({ name: "refresh_graph", arguments: { paths: ["src/payment/payment.service.ts"] } });
    assert.equal(sourceRefresh.isError, undefined);
    const sourceRefreshPayload = JSON.parse(sourceRefresh.content.find((item) => item.type === "text").text);
    assert.equal(sourceRefreshPayload.graphState.graphVersion, 3);
    const sourceFlow = sourceRefreshPayload.changedContexts.flows.find((flow) => flow.id === "flow:endpoint:src/payment/payment.routes.ts:POST:/payments");
    assert.equal(sourceFlow.flowComparisonAvailable, true);
    const comparisonResult = await client.callTool({ name: "get_flow_comparison", arguments: { flowId: sourceFlow.id, fromVersion: 2, toVersion: 3 } });
    assert.equal(comparisonResult.isError, undefined);
    const comparison = JSON.parse(comparisonResult.content.find((item) => item.type === "text").text);
    assert.equal(comparison.available, true);
    assert.equal(comparison.comparison.changes.sourceChangedOnly, true);
    const deltaResult = await client.callTool({ name: "get_graph_delta", arguments: {} });
    const persistedDelta = JSON.parse(deltaResult.content.find((item) => item.type === "text").text);
    assert.deepEqual(persistedDelta.changedPaths, ["src/payment/payment.service.ts"]);
    assert.ok(refreshPayload.delta.addedNodes.some((node) => node.path === "src/payment/tax.ts" && node.kind === "file"));
    assert.match(refreshPayload.delta.limitation, /not a source diff/);
    assert.ok(fs.existsSync(path.join(root, ".flopeek", "graph.json")));
  } finally {
    if (client) await client.close();
    else if (transport) await transport.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package-scoped MCP exposes an explicit static subtree boundary without a repository-wide cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-package-mcp-"));
  let client;
  let instance;
  try {
    write(root, "package.json", JSON.stringify({ name: "package-mcp-example" }));
    write(root, "apps/api/package.json", JSON.stringify({ name: "@mcp/api" }));
    write(root, "packages/core/package.json", JSON.stringify({ name: "@mcp/core" }));
    write(root, "apps/api/src/route.ts", "export function apiRoute() { return true; }\n");
    write(root, "packages/core/src/core.ts", "export function coreRoute() { return true; }\n");
    const durableFirst = scanRepository(root);
    writeGraphCache(root, durableFirst, { reason: "package-mcp-durable-first" });
    write(root, "src/durable.ts", "export function durable() { return 1; }\n");
    const durableSecond = scanRepository(root);
    writeGraphCache(root, durableSecond, { reason: "package-mcp-durable-second" });
    const durableDelta = readGraphDelta(root, durableFirst.state.graphVersion, durableSecond.state.graphVersion);
    const cachePath = path.join(root, ".flopeek", "graph.json");
    const cacheBefore = fs.readFileSync(cachePath);
    assert.ok(durableDelta);
    instance = await createMcpServer({ root, cache: true, packagePath: "apps/api" });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "flopeek-package-mcp-client", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);

    const statusResult = await client.callTool({ name: "get_scan_status", arguments: {} });
    const status = JSON.parse(statusResult.content.find((item) => item.type === "text").text);
    assert.equal(status.status, "complete");
    assert.equal(status.bounds.packagePath, "apps/api");
    assert.equal(status.discovery.selection.path, "apps/api");
    assert.equal(status.cachePromotion.allowed, false);
    assert.match(status.activeGraph.projectId, /^session:/);
    assert.notEqual(status.activeGraph.projectId, durableSecond.project.projectId);

    const bootstrapResult = await client.callTool({ name: "get_agent_bootstrap", arguments: {} });
    const bootstrap = JSON.parse(bootstrapResult.content.find((item) => item.type === "text").text);
    assert.equal(bootstrap.graph.packageSelection.path, "apps/api");
    assert.match(bootstrap.limitations.join(" "), /selected static package subtree/);

    const searchResult = await client.callTool({ name: "find_nodes", arguments: { query: "coreRoute" } });
    const search = JSON.parse(searchResult.content.find((item) => item.type === "text").text);
    assert.deepEqual(search.results, []);
    const durableRequest = await client.callTool({
      name: "get_graph_delta",
      arguments: { fromVersion: durableFirst.state.graphVersion, toVersion: durableSecond.state.graphVersion },
    });
    assert.equal(durableRequest.isError, true);
    assert.ok(durableRequest.content[0].text.includes("No matching graph delta was found."));
    assert.deepEqual(fs.readFileSync(cachePath), cacheBefore);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package-scoped Viewer HTTP data labels the selected subtree and excludes sibling package source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-package-viewer-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "package-viewer-example" }));
    write(root, "apps/api/package.json", JSON.stringify({ name: "@viewer/api" }));
    write(root, "packages/core/package.json", JSON.stringify({ name: "@viewer/core" }));
    write(root, "apps/api/src/route.ts", "export function apiRoute() { return true; }\n");
    write(root, "packages/core/src/core.ts", "export function coreRoute() { return true; }\n");
    app = await startServer({ root, port: 0, cache: true, packagePath: "apps/api", registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const status = await (await fetch(`${baseUrl}/api/scan-status`)).json();
    const view = await (await fetch(`${baseUrl}/api/view?mode=overview&scope=application`)).json();
    const rawGraph = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.equal(status.status, "complete");
    assert.equal(status.discovery.selection.path, "apps/api");
    assert.equal(status.cachePromotion.allowed, false);
    assert.equal(view.aiContext.packageSelection.path, "apps/api");
    assert.equal(rawGraph.analysis.packageSelection.path, "apps/api");
    assert.equal(rawGraph.nodes.some((node) => node.path === "packages/core/src/core.ts"), false);
    assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid package scope is rejected by Viewer and MCP startup without Flopeek metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-invalid-package-surface-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "invalid-package-surface" }));
    await assert.rejects(
      () => startServer({ root, port: 0, cache: true, packagePath: "../outside", registerServeWorkspace: false }),
      /packagePath must not contain parent-directory traversal/,
    );
    await assert.rejects(
      () => createMcpServer({ root, cache: true, packagePath: "../outside" }),
      /packagePath must not contain parent-directory traversal/,
    );
    assert.equal(fs.existsSync(path.join(root, ".flopeek")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded MCP cancellation preserves the current graph and exposes stale-unverified readiness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-mcp-cancel-"));
  let client;
  let instance;
  try {
    writeBoundedActiveFixture(root);
    instance = await createMcpServer({ root, cache: false, maxFiles: 64, timeBudgetMs: 30_000 });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "flopeek-mcp-cancellation-client", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = JSON.parse((await client.callTool({ name: "get_agent_bootstrap", arguments: {} })).content.find((item) => item.type === "text").text);

    const refresh = client.callTool({ name: "refresh_graph", arguments: {} });
    const running = await waitFor(async () => {
      const result = await client.callTool({ name: "get_scan_status", arguments: {} });
      const status = JSON.parse(result.content.find((item) => item.type === "text").text);
      return status.status === "running" && status.progress?.phase === "analysis-started" ? status : null;
    }, 20_000);
    assert.equal(running.activeGraph.freshness, "current");
    const cancellation = await client.callTool({ name: "cancel_scan", arguments: {} });
    const cancellationPayload = JSON.parse(cancellation.content.find((item) => item.type === "text").text);
    assert.equal(cancellationPayload.accepted, true);

    const refreshed = await refresh;
    assert.equal(refreshed.isError, undefined);
    const refreshPayload = JSON.parse(refreshed.content.find((item) => item.type === "text").text);
    assert.equal(refreshPayload.scanOutcome.status, "cancelled");
    assert.equal(refreshPayload.scanOutcome.activeGraph.freshness, "stale-unverified");
    assert.equal(refreshPayload.project.projectId, before.project.projectId);
    assert.equal(refreshPayload.graphState.graphVersion, before.graph.graphVersion);
    assert.equal(refreshPayload.persistedDelta, null);
    const bootstrap = JSON.parse((await client.callTool({ name: "get_agent_bootstrap", arguments: {} })).content.find((item) => item.type === "text").text);
    assert.equal(bootstrap.scan.status, "cancelled");
    assert.equal(bootstrap.readiness.currentSourceVerified, false);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cache-disabled HTTP and MCP sessions never read a persisted project delta", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-session-delta-isolation-"));
  let app;
  let client;
  let instance;
  try {
    write(root, "package.json", JSON.stringify({ name: "session-delta-isolation" }));
    write(root, "src/orders.ts", "export function listOrders() { return []; }");
    const durableFirst = scanRepository(root);
    writeGraphCache(root, durableFirst, { reason: "durable-first" });
    write(root, "src/orders.ts", "export function listOrders() { return [{ id: 'durable' }]; }");
    const durableSecond = scanRepository(root);
    writeGraphCache(root, durableSecond, { reason: "durable-second" });
    const durableDelta = readGraphDelta(root, durableFirst.state.graphVersion, durableSecond.state.graphVersion);
    assert.ok(durableDelta);

    app = await startServer({ root, port: 0, cache: false, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const httpDelta = await fetch(`${baseUrl}/api/delta?fromVersion=${durableFirst.state.graphVersion}&toVersion=${durableSecond.state.graphVersion}`);
    assert.equal(httpDelta.status, 404);
    assert.equal((await httpDelta.json()).error, "No matching graph delta was found.");

    instance = await createMcpServer({ root, cache: false });
    const [{ Client }, { InMemoryTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "flopeek-session-delta-client", version: "1.0.0" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);

    const persistedRequest = await client.callTool({
      name: "get_graph_delta",
      arguments: { fromVersion: durableFirst.state.graphVersion, toVersion: durableSecond.state.graphVersion },
    });
    assert.equal(persistedRequest.isError, true);
    assert.ok(persistedRequest.content[0].text.includes("No matching graph delta was found."));

    write(root, "src/orders.ts", "export function listOrders() { return [{ id: 'session' }]; }");
    const refreshed = await client.callTool({ name: "refresh_graph", arguments: { paths: ["src/orders.ts"] } });
    assert.equal(refreshed.isError, undefined);
    const refreshPayload = JSON.parse(refreshed.content.find((item) => item.type === "text").text);
    const currentDelta = await client.callTool({
      name: "get_graph_delta",
      arguments: {
        fromVersion: refreshPayload.graphState.graphVersion - 1,
        toVersion: refreshPayload.graphState.graphVersion,
      },
    });
    assert.equal(currentDelta.isError, undefined);
    const currentPayload = JSON.parse(currentDelta.content.find((item) => item.type === "text").text);
    assert.equal(currentPayload.projectId, refreshPayload.project.projectId);
    assert.notEqual(currentPayload.projectId, durableDelta.projectId);
  } finally {
    if (client) await client.close();
    if (instance) await instance.server.close();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repository scope defaults keep test and fixture endpoints out of application flows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scope-defaults-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "scope-defaults" }));
    write(root, "src/orders.routes.ts", "router.get('/orders', () => ({ ok: true }));");
    write(root, "test/orders.routes.spec.ts", "router.put('/test-orders', () => ({ ok: true }));");
    write(root, "test/fixtures/orders.routes.ts", "router.post('/fixture-orders', () => ({ ok: true }));");
    write(root, ".flowpeek/legacy.routes.ts", "router.delete('/legacy-cache', () => ({ ok: true }));");
    const graph = scanRepository(root);
    assert.deepEqual(graph.flows.map((flow) => flow.title), ["GET /orders"]);
    assert.deepEqual(graph.diagnosticFlows.map((flow) => flow.title).sort(), ["GET /orders", "POST /fixture-orders", "PUT /test-orders"]);
    const diagnosticView = projectView(graph, { mode: "requests", scope: "all" });
    assert.deepEqual(diagnosticView.flows.map((flow) => flow.title).sort(), ["GET /orders", "POST /fixture-orders", "PUT /test-orders"]);
    assert.equal(graph.nodes.find((node) => node.path === "src/orders.routes.ts" && node.kind === "file").sourceScope, "application");
    assert.equal(graph.nodes.find((node) => node.path === "test/orders.routes.spec.ts" && node.kind === "file").sourceScope, "test");
    assert.equal(graph.nodes.find((node) => node.path === "test/fixtures/orders.routes.ts" && node.kind === "file").sourceScope, "fixture");
    assert.deepEqual(graph.analysis.repositoryScope.counts, { application: 1, test: 1, fixture: 1, generated: 0, excluded: 0 });
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-no-cache-cli-"));
    write(cliRoot, "package.json", JSON.stringify({ name: "no-cache-cli" }));
    write(cliRoot, "src/orders.routes.ts", "router.get('/orders', () => ({ ok: true }));");
    const cliGraph = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "..", "src", "cli.js"), "scan", cliRoot, "--json", "--no-cache"], { encoding: "utf8" }));
    assert.equal(cliGraph.analysis.repositoryScope.source, "defaults");
    assert.equal(cliGraph.analysis.repositoryScope.flowEntries.tests, false);
    assert.match(cliGraph.project.projectId, /^session:/);
    assert.match(cliGraph.project.identity.canonicalProjectId, /^project:/);
    assert.equal(cliGraph.analysis.cacheState.status, "disabled");
    assert.equal(fs.existsSync(path.join(cliRoot, ".flopeek")), false, "--no-cache must not create Flopeek cache or identity metadata");
    fs.rmSync(cliRoot, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("route-like nodes without a supported static entry fact do not create Flow Lenses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-non-http-entry-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "non-http-entry" }));
    write(root, "src/orders.controller.ts", "export class OrdersController { list() { return []; } }");
    const graph = scanRepository(root, { persistIdentity: false });
    assert.equal(graph.nodes.some((node) => node.type === "controller"), true);
    assert.deepEqual(graph.flows, []);
    assert.deepEqual(graph.diagnosticFlows, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repository scope config applies roots, exclusions, generated diagnostics, and entry policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scope-config-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "scope-config" }));
    write(root, ".flopeek/config.json", JSON.stringify({
      schemaVersion: 1,
      sourceRoots: ["app"],
      testRoots: ["verification"],
      fixtureRoots: ["samples"],
      exclude: ["legacy/**"],
      flowEntries: { tests: true, fixtures: true },
    }));
    write(root, "app/live.routes.ts", "router.get('/live', () => ({ ok: true }));");
    write(root, "verification/check.routes.ts", "router.post('/check', () => ({ ok: true }));");
    write(root, "samples/example.routes.ts", "router.put('/sample', () => ({ ok: true }));");
    write(root, "app/generated/api.generated.ts", "router.delete('/generated', () => ({ ok: true }));");
    write(root, "legacy/old.routes.ts", "router.get('/legacy', () => ({ ok: true }));");
    write(root, "outside/routes.ts", "router.get('/outside', () => ({ ok: true }));");
    const graph = scanRepository(root);
    assert.deepEqual(graph.flows.map((flow) => flow.title).sort(), ["GET /live", "POST /check", "PUT /sample"]);
    assert.equal(graph.nodes.find((node) => node.path === "app/generated/api.generated.ts" && node.kind === "file").sourceScope, "generated");
    assert.equal(graph.nodes.some((node) => node.path === "legacy/old.routes.ts"), false);
    assert.equal(graph.nodes.some((node) => node.path === "outside/routes.ts"), false);
    assert.deepEqual(graph.analysis.repositoryScope.counts, { application: 1, test: 1, fixture: 1, generated: 1, excluded: 2 });
    assert.equal(graph.analysis.repositoryScope.source, "config");
    assert.equal(graph.analysis.repositoryScope.configPath, ".flopeek/config.json");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repository scope rejects invalid schema and field types before cache writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scope-invalid-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "scope-invalid" }));
    write(root, "src/live.routes.ts", "router.get('/live', () => ({ ok: true }));");
    const valid = scanRepository(root);
    writeGraphCache(root, valid);
    const cached = fs.readFileSync(path.join(root, ".flopeek", "graph.json"), "utf8");
    write(root, ".flopeek/config.json", JSON.stringify({ schemaVersion: 2 }));
    assert.throws(() => scanRepository(root), /schemaVersion must be 1/);
    assert.equal(fs.readFileSync(path.join(root, ".flopeek", "graph.json"), "utf8"), cached);
    write(root, ".flopeek/config.json", JSON.stringify({ schemaVersion: 1, sourceRoots: "src" }));
    assert.throws(() => scanRepository(root), /sourceRoots must be an array/);
    assert.equal(readGraphCache(root)?.project.name, "scope-invalid");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incremental repository scope refresh reclassifies retained source facts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scope-incremental-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "scope-incremental" }));
    write(root, "src/live.routes.ts", "router.get('/live', () => ({ ok: true }));");
    write(root, "test/fixtures/example.routes.ts", "router.post('/fixture', () => ({ ok: true }));");
    const scanner = createRepositoryScanner(root);
    const initial = scanner.scan();
    assert.deepEqual(initial.flows.map((flow) => flow.title), ["GET /live"]);
    write(root, ".flopeek/config.json", JSON.stringify({ schemaVersion: 1, flowEntries: { fixtures: true } }));
    const refreshed = scanner.scan([".flopeek/config.json"]);
    assert.equal(refreshed.analysis.refresh.mode, "reconciled");
    assert.equal(refreshed.analysis.refresh.scopeChanged, true);
    assert.deepEqual(refreshed.flows.map((flow) => flow.title).sort(), ["GET /live", "POST /fixture"]);
    assert.equal(refreshed.nodes.find((node) => node.path === "test/fixtures/example.routes.ts" && node.kind === "file").sourceScope, "fixture");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local API exposes scope metadata and diagnostic fixture flows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scope-api-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "scope-api" }));
    write(root, "src/live.routes.ts", "router.get('/live', () => ({ ok: true }));");
    write(root, "test/fixtures/example.routes.ts", "router.post('/fixture', () => ({ ok: true }));");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const application = await (await fetch(`${baseUrl}/api/view?mode=requests&scope=application`)).json();
    const diagnostic = await (await fetch(`${baseUrl}/api/view?mode=requests&scope=all`)).json();
    const capabilities = await (await fetch(`${baseUrl}/api/capabilities`)).json();
    assert.deepEqual(application.flows.map((flow) => flow.title), ["GET /live"]);
    assert.deepEqual(diagnostic.flows.map((flow) => flow.title).sort(), ["GET /live", "POST /fixture"]);
    assert.equal(diagnostic.aiContext.repositoryScope.counts.fixture, 1);
    assert.equal(capabilities.repositoryScope.precedence.join(","), "excluded,fixture,test,generated,application");
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repository config watcher remains active when recursive directory watching is unavailable", () => {
  let configListener = null;
  let unwatched = null;
  const fileSystem = {
    watch() {
      throw new Error("recursive watching unavailable");
    },
    watchFile(filename, options, listener) {
      assert.equal(filename, path.join("/repository", ".flopeek", "config.json"));
      assert.deepEqual(options, { interval: 200, persistent: false });
      configListener = listener;
    },
    unwatchFile(filename, listener) {
      unwatched = { filename, listener };
    },
  };
  const changes = [];
  const close = watchRepository("/repository", (changedPath) => changes.push(changedPath), fileSystem);
  assert.equal(typeof configListener, "function");
  configListener({ nlink: 0 }, { nlink: 0 });
  assert.deepEqual(changes, []);
  configListener({ nlink: 1 }, { nlink: 0 });
  assert.deepEqual(changes, [".flopeek/config.json"]);
  close();
  assert.deepEqual(unwatched, {
    filename: path.join("/repository", ".flopeek", "config.json"),
    listener: configListener,
  });
});

test("serve watches repository scope configuration changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-scope-watch-"));
  let app;
  let reader;
  try {
    write(root, "package.json", JSON.stringify({ name: "scope-watch" }));
    write(root, "src/live.routes.ts", "router.get('/live', () => ({ ok: true }));");
    write(root, "test/fixtures/example.routes.ts", "router.post('/fixture', () => ({ ok: true }));");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const eventResponse = await fetch(`${baseUrl}/api/events`);
    reader = eventResponse.body.getReader();
    const events = createSseEventReader(reader);
    await events.next((event) => event.event === "ready");
    write(root, ".flopeek/config.json", JSON.stringify({ schemaVersion: 1, flowEntries: { fixtures: true } }));
    const event = await events.next((candidate) => candidate.event === "graph");
    const update = JSON.parse(event.data);
    assert.equal(update.reason, "filesystem");
    const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.equal(graph.analysis.refresh.scopeChanged, true);
    assert.deepEqual(graph.flows.map((flow) => flow.title).sort(), ["GET /live", "POST /fixture"]);
  } finally {
    if (reader) await reader.cancel();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("graph schema validates the v5 contract fixture and migrates v4 graph evidence", () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "graph-schema", "v5-valid.json"), "utf8");
  const parsed = parseGraphCache(fixture);
  assert.equal(parsed.migrated, false);
  assert.equal(parsed.graph.schemaVersion, 5);
  assert.equal(parsed.graph.nodes[0].id, "file:src/example.ts");
  assert.equal(parsed.graph.nodes[0].manualDescription, "Verified example responsibility.");
  assert.equal(parsed.graph.nodes[0].evidence.parser, "typescript-ast");
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "graph-schema", "v4-valid.json"), "utf8"));
  delete legacy.diagnosticFlows;
  legacy.nodes[0].manualDescription = "Keep this verified description.";
  const migrated = parseGraphCache(JSON.stringify(legacy));
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.graph.schemaVersion, 5);
  assert.equal(migrated.graph.state.graphVersion, 0);
  assert.deepEqual(migrated.graph.diagnosticFlows, []);
  assert.equal(migrated.graph.nodes[0].manualDescription, "Keep this verified description.");
  assert.equal(migrated.graph.nodes[0].evidence.parser, "typescript-ast");
  assert.throws(() => parseGraphCache(JSON.stringify({ schemaVersion: 99 })), GraphSchemaError);
});

test("graph cache reports malformed, unsupported, and wrong-project payloads without serving them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-cache-validation-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "cache-validation" }));
    write(root, "src/example.ts", "export const example = true;");
    const graph = scanRepository(root);
    writeGraphCache(root, graph);
    assert.equal(readGraphCacheResult(root).status, "valid");
    write(root, ".flopeek/graph.json", "{");
    const malformed = readGraphCacheResult(root);
    assert.equal(malformed.status, "invalid");
    assert.equal(malformed.diagnostics[0].code, "invalid-json");
    const unsupported = { ...graph, schemaVersion: 99 };
    write(root, ".flopeek/graph.json", JSON.stringify(unsupported));
    assert.equal(readGraphCacheResult(root).diagnostics[0].code, "unsupported-schema-version");
    const wrongProject = { ...graph, project: { ...graph.project, root: "C:/another-project" } };
    write(root, ".flopeek/graph.json", JSON.stringify(wrongProject));
    assert.equal(readGraphCacheResult(root).diagnostics[0].code, "wrong-project-root");
    const wrongIdentity = { ...graph, project: { ...graph.project, projectId: "project:another" } };
    write(root, ".flopeek/graph.json", JSON.stringify(wrongIdentity));
    assert.equal(readGraphCacheResult(root, { expectedProjectId: graph.project.projectId }).diagnostics[0].code, "wrong-project-id");
    assert.equal(readGraphCache(root, { expectedProjectId: graph.project.projectId }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("atomic graph cache writes retry transient locks and preserve prior data on failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-cache-atomic-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "cache-atomic" }));
    write(root, "src/example.ts", "export const example = true;");
    const previous = scanRepository(root);
    writeGraphCache(root, previous);
    const before = fs.readFileSync(path.join(root, ".flopeek", "graph.json"), "utf8");
    const next = { ...scanRepository(root), generatedAt: "2026-07-14T12:00:00.000Z" };
    let renameAttempts = 0;
    const written = writeGraphCache(root, next, {
      attempts: 3,
      retryDelayMs: 0,
      wait: () => {},
      rename: (temporary, target) => {
        renameAttempts += 1;
        if (renameAttempts === 1) {
          const error = new Error("file is temporarily locked");
          error.code = "EPERM";
          throw error;
        }
        fs.renameSync(temporary, target);
      },
    });
    assert.equal(written.status, "written");
    assert.equal(written.attempts, 2);
    assert.equal(readGraphCache(root).generatedAt, next.generatedAt);
    const preserved = fs.readFileSync(path.join(root, ".flopeek", "graph.json"), "utf8");
    assert.notEqual(preserved, before);
    assert.throws(() => writeGraphCache(root, { ...next, nodes: null }), GraphCacheError);
    assert.equal(fs.readFileSync(path.join(root, ".flopeek", "graph.json"), "utf8"), preserved);
    assert.throws(() => writeGraphCache(root, { ...next, generatedAt: "2026-07-14T12:01:00.000Z" }, {
      attempts: 2,
      retryDelayMs: 0,
      wait: () => {},
      rename: () => {
        const error = new Error("file remains locked");
        error.code = "EACCES";
        throw error;
      },
    }), /previous cache was preserved/);
    assert.equal(fs.readFileSync(path.join(root, ".flopeek", "graph.json"), "utf8"), preserved);
    assert.equal(fs.readdirSync(path.join(root, ".flopeek")).some((name) => name.endsWith(".tmp")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("atomic graph cache writes use bounded backoff for transient Windows locks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-cache-backoff-"));
  try {
    const target = path.join(root, "records.json");
    const waits = [];
    let renameAttempts = 0;
    const result = atomicWriteJson(target, { status: "current" }, {
      attempts: 4,
      retryDelayMs: 25,
      wait: (milliseconds) => waits.push(milliseconds),
      rename: (temporary, destination) => {
        renameAttempts += 1;
        if (renameAttempts < 4) {
          const error = new Error("file is temporarily locked");
          error.code = "EPERM";
          throw error;
        }
        fs.renameSync(temporary, destination);
      },
    });
    assert.equal(result.attempts, 4);
    assert.deepEqual(waits, [25, 50, 75]);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { status: "current" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("project identity persists across moves and supports an explicit configured ID", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-project-identity-"));
  const moved = `${root}-moved`;
  try {
    write(root, "package.json", JSON.stringify({ name: "identity-example" }));
    write(root, "src/example.ts", "export const example = true;");
    const first = scanRepository(root);
    assert.match(first.project.projectId, /^project:/);
    assert.equal(first.project.identity.source, "generated");
    assert.ok(fs.existsSync(path.join(root, ".flopeek", "project.json")));
    fs.renameSync(root, moved);
    const movedGraph = scanRepository(moved);
    assert.equal(movedGraph.project.projectId, first.project.projectId);
    write(moved, ".flopeek/config.json", JSON.stringify({ schemaVersion: 1, projectId: "project:customer-billing" }));
    const configured = scanRepository(moved);
    assert.equal(configured.project.projectId, "project:customer-billing");
    assert.equal(configured.project.identity.source, "configured");
  } finally { fs.rmSync(fs.existsSync(moved) ? moved : root, { recursive: true, force: true }); }
});

test("graph versions persist across restart and record topology-neutral source edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-versioned-state-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "versioned-state" }));
    write(root, "src/payment.ts", "export function pay() { return true; }\n");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    const firstWrite = writeGraphCache(root, first, { reason: "initial" });
    assert.equal(first.state.graphVersion, 1);
    assert.equal(firstWrite.delta, null);
    const restarted = createRepositoryScanner(root).scan();
    writeGraphCache(root, restarted, { reason: "restart" });
    assert.equal(restarted.state.graphVersion, 1);
    assert.equal(restarted.state.status, "current");
    write(root, "src/payment.ts", "export function pay() { return false; }\n");
    const changed = scanner.scan(["src/payment.ts"]);
    const changedWrite = writeGraphCache(root, changed, { reason: "filesystem", changedPaths: ["src/payment.ts"] });
    assert.equal(changed.state.graphVersion, 2);
    assert.equal(changedWrite.delta.fromGraphVersion, 1);
    assert.equal(changedWrite.delta.toGraphVersion, 2);
    assert.equal(changedWrite.delta.sourceChanged, true);
    assert.equal(changedWrite.delta.topologyChanged, false);
    assert.deepEqual(changedWrite.delta.changedPaths, ["src/payment.ts"]);
    assert.equal(changedWrite.delta.summary.addedNodes, 0);
    assert.equal(changedWrite.delta.summary.removedEdges, 0);
    const persisted = readGraphDelta(root, 1, 2);
    assert.equal(persisted.topologyChanged, false);
    assert.equal(persisted.affectedNodes.some((node) => node.path === "src/payment.ts"), true);
    assert.ok(persisted.affectedContexts.nodes.some((item) => item.node.path === "src/payment.ts" && item.status === "source-changed"));
    const changedContexts = getChangedContexts(changed, { fromVersion: 1, toVersion: 2 });
    assert.equal(changedContexts.available, true);
    assert.ok(changedContexts.nodes.some((node) => node.path === "src/payment.ts" && node.availability === "current"));
    assert.match(changedContexts.nodes[0].contextRef, /^fp:\/\/local\//);
    const state = readGraphStateResult(root, changed.project.projectId);
    assert.equal(state.status, "valid");
    assert.equal(state.state.graphVersion, 2);
    const noChange = scanner.scan(["src/payment.ts"]);
    const noChangeWrite = writeGraphCache(root, noChange, { reason: "filesystem", changedPaths: ["src/payment.ts"] });
    assert.equal(noChange.state.graphVersion, 2);
    assert.equal(noChangeWrite.delta.toGraphVersion, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("changed contexts retain a content-only PHP view as a file-level context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-php-view-context-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "php-view-context" }));
    write(root, "application/views/contacts/form.php", "<input class=\"ha-end-date\" onchange=\"setHaEndDate(this)\">\n<script>function setHaEndDate(value) { return value; }</script>\n");
    write(root, "application/views/contacts/education.php", "<input class=\"ha-end-date\" onchange=\"setHaEndDate(this)\">\n<script>function setHaEndDate(value) { return value; }</script>\n");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    write(root, "application/views/contacts/form.php", "<input class=\"ha-end-date\" onchange=\"setHaEndDate(this)\" data-state=\"current\">\n<script>function setHaEndDate(value) { return value; }</script>\n");
    const second = scanner.scan(["application/views/contacts/form.php"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["application/views/contacts/form.php"] });
    const changed = getChangedContexts(second, { fromVersion: 1, toVersion: 2 });
    const view = changed.nodes.find((node) => node.path === "application/views/contacts/form.php");
    assert.equal(changed.available, true);
    assert.equal(view.status, "source-changed");
    assert.equal(view.kind, "file");
    assert.equal(view.changeScope, "file-content-only");
    assert.equal(changed.flows.length, 0);
    const related = getRelatedImplementations(second, view.contextRef);
    assert.equal(related.status, "available");
    assert.equal(related.candidates[0].path, "application/views/contacts/education.php");
    assert.match(related.limitation, /does not prove UI behavior/);
    app = await startServer({ root, port: 0 });
    const response = await fetch(`http://127.0.0.1:${app.port}/api/related-implementations?contextRef=${encodeURIComponent(view.contextRef)}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).candidates[0].path, "application/views/contacts/education.php");
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persistent full refresh derives adjacent delta paths from the prior Git revision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-delta-provenance-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "delta-provenance" }));
    write(root, "src/payment.ts", "export function pay() { return true; }\n");
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "flopeek@example.test"]);
    git(root, ["config", "user.name", "Flopeek Test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "baseline"]);
    const first = scanRepository(root);
    writeGraphCache(root, first, { reason: "initial" });
    write(root, "src/payment.ts", "export function pay() { return false; }\n");
    const second = scanRepository(root);
    const secondWrite = writeGraphCache(root, second, { reason: "cli-scan" });
    assert.deepEqual(secondWrite.delta.changedPaths, ["src/payment.ts"]);
    assert.deepEqual(secondWrite.delta.changedPathProvenance, { status: "available", source: "git-revision-diff", reason: null });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("changed contexts connect a source edit to the current HTTP Flow Lens", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-changed-contexts-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "changed-contexts" }));
    write(root, "src/orders.routes.ts", "import { submit } from './orders.service';\nrouter.post('/orders', () => submit());");
    write(root, "src/orders.service.ts", "export function submit() { return true; }");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    write(root, "src/orders.service.ts", "export function submit() { return false; }");
    const second = scanner.scan(["src/orders.service.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/orders.service.ts"] });
    const changed = getChangedContexts(second, { fromVersion: 1, toVersion: 2 });
    const flow = changed.flows.find((item) => item.id === "flow:endpoint:src/orders.routes.ts:POST:/orders");
    assert.equal(changed.available, true);
    assert.equal(flow.status, "affected");
    assert.ok(flow.changedStepIds.includes("file:src/orders.service.ts"));
    assert.equal(flow.availability, "current");
    assert.match(flow.entryContextRef, /^fp:\/\/local\//);
    assert.equal(flow.flowProjectionId, "lens:flow:endpoint:src/orders.routes.ts:POST:/orders@2");
    assert.match(flow.flowContextRef, /^fp:\/\/local\/.+\/flow\//);
    assert.ok(flow.flowComparisonAvailable);
    const comparison = getFlowComparison(second, flow.id, { fromVersion: 1, toVersion: 2 });
    assert.equal(comparison.schemaVersion, "flopeek-flow-comparison/v1");
    assert.equal(comparison.available, true);
    assert.equal(comparison.comparison.status, "affected");
    assert.equal(comparison.comparison.before.project.graphVersion, 1);
    assert.equal(comparison.comparison.current.project.graphVersion, 2);
    assert.ok(comparison.comparison.changes.sourceChangedStepIds.includes("file:src/orders.service.ts"));
    assert.equal(comparison.comparison.changes.sourceChangedOnly, true);
    assert.equal(JSON.stringify(comparison).includes("return false"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Flow Lens comparison retains an added static step without reconstructing old code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-flow-comparison-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "flow-comparison" }));
    write(root, "src/orders.routes.ts", "import { submit } from './orders.service';\nrouter.post('/orders', () => submit());");
    write(root, "src/orders.service.ts", "export function submit() { return true; }");
    write(root, "src/fraud.service.ts", "export function screen() { return true; }");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    write(root, "src/orders.service.ts", "import { screen } from './fraud.service';\nexport function submit() { return screen(); }");
    const second = scanner.scan(["src/orders.service.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/orders.service.ts"] });
    const flowId = "flow:endpoint:src/orders.routes.ts:POST:/orders";
    const comparison = getFlowComparison(second, flowId, { fromVersion: 1, toVersion: 2 });
    assert.equal(comparison.available, true);
    assert.equal(comparison.comparison.before.steps.some((step) => step.id === "file:src/fraud.service.ts"), false);
    assert.equal(comparison.comparison.current.steps.some((step) => step.id === "file:src/fraud.service.ts"), true);
    assert.ok(comparison.comparison.changes.addedStepIds.includes("file:src/fraud.service.ts"));
    assert.equal(comparison.comparison.changes.staticStructureChanged, true);
    assert.equal(comparison.comparison.changes.sourceChangedOnly, false);
    assert.equal(JSON.stringify(comparison).includes("return screen"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Flow Context Cards resolve current, stale, historical, and unresolved refs without source contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-flow-context-card-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "flow-context-card" }));
    write(root, "src/orders.routes.ts", "import { submit } from './orders.service';\nrouter.post('/orders', () => submit());");
    write(root, "src/orders.service.ts", "export function submit() { return true; }");
    write(root, "src/orders.service.spec.ts", "import { submit } from './orders.service';\ntest('submit', () => submit());");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    const flowId = "flow:endpoint:src/orders.routes.ts:POST:/orders";
    const packet = getFlowContextCard(first, flowId);
    assert.equal(packet.schemaVersion, "flopeek-context-packet/v1");
    assert.equal(packet.card.schemaVersion, "flopeek-context/v1");
    assert.equal(packet.card.kind, "flow");
    assert.equal(packet.card.project.graphVersion, 1);
    assert.match(packet.card.contextRef, /^fp:\/\/local\/.+\/flow\//);
    assert.ok(packet.card.projection.steps.some((step) => step.id === "file:src/orders.service.ts"));
    assert.ok(packet.card.relatedTests.some((item) => item.test.path === "src/orders.service.spec.ts"));
    assert.equal(JSON.stringify(packet).includes("return true"), false);
    assert.equal(resolveContextRef(first, packet.card.contextRef).status, "current");
    const markdown = getFlowContextCard(first, flowId, "markdown");
    assert.match(markdown.markdown, /Technical summary/);
    assert.match(markdown.markdown, /Related tests/);

    write(root, "src/orders.service.ts", "export function submit() { return false; }");
    const second = scanner.scan(["src/orders.service.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/orders.service.ts"] });
    const stale = resolveContextRef(second, packet.card.contextRef);
    assert.equal(stale.status, "stale");
    assert.equal(stale.card.kind, "flow");
    assert.equal(stale.card.project.graphVersion, 2);
    assert.equal(stale.delta.fromGraphVersion, 1);
    const currentPacket = getFlowContextCard(second, flowId);

    fs.rmSync(path.join(root, "src", "orders.routes.ts"));
    const third = scanner.scan(["src/orders.routes.ts"]);
    writeGraphCache(root, third, { reason: "filesystem", changedPaths: ["src/orders.routes.ts"] });
    const historical = resolveContextRef(third, currentPacket.card.contextRef);
    assert.equal(historical.status, "historical");
    assert.equal(historical.historicalFlow.id, flowId);
    assert.equal(historical.historicalFlowLensSnapshot.flow.id, flowId);
    assert.equal(historical.card, null);
    const missing = resolveContextRef(third, createContextRef(third.project.projectId, "flow", "flow:missing", 3));
    assert.equal(missing.status, "unresolved");
    assert.equal(missing.code, "flow-not-found");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Context Cards resolve current, stale, historical, and successor-candidate node references without source contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-context-card-"));
  try {
    write(root, "package.json", JSON.stringify({ name: "context-card-example" }));
    write(root, "src/payment.ts", "export function authorize() { return true; }\n");
    const scanner = createRepositoryScanner(root);
    const first = scanner.scan();
    writeGraphCache(root, first, { reason: "initial" });
    const fileId = "file:src/payment.ts";
    const oldSymbolId = "symbol:src/payment.ts:function:authorize";
    const filePacket = getContextCard(first, fileId);
    const oldSymbolPacket = getContextCard(first, oldSymbolId);
    assert.equal(filePacket.schemaVersion, "flopeek-context-packet/v1");
    assert.equal(filePacket.card.schemaVersion, "flopeek-context/v1");
    assert.equal(filePacket.card.project.graphVersion, 1);
    assert.match(filePacket.card.contextRef, /^fp:\/\/local\//);
    assert.equal(JSON.stringify(filePacket).includes("return true"), false);
    assert.equal(resolveContextRef(first, filePacket.card.contextRef).status, "current");
    const markdown = getContextCard(first, fileId, "markdown");
    assert.equal(markdown.format, "markdown");
    assert.match(markdown.markdown, /Context Ref/);

    write(root, "src/payment.ts", "export function capture() { return true; }\n");
    const second = scanner.scan(["src/payment.ts"]);
    writeGraphCache(root, second, { reason: "filesystem", changedPaths: ["src/payment.ts"] });
    const stale = resolveContextRef(second, filePacket.card.contextRef);
    assert.equal(stale.status, "stale");
    assert.equal(stale.card.project.graphVersion, 2);
    assert.equal(stale.delta.fromGraphVersion, 1);
    assert.equal(stale.delta.toGraphVersion, 2);
    const successor = resolveContextRef(second, oldSymbolPacket.card.contextRef);
    assert.equal(successor.status, "successor-candidate");
    assert.equal(successor.successorCandidates.length, 1);
    assert.equal(successor.successorCandidates[0].node.id, "symbol:src/payment.ts:function:capture");

    const newSymbolPacket = getContextCard(second, "symbol:src/payment.ts:function:capture");
    fs.rmSync(path.join(root, "src", "payment.ts"));
    const third = scanner.scan(["src/payment.ts"]);
    writeGraphCache(root, third, { reason: "filesystem", changedPaths: ["src/payment.ts"] });
    const historical = resolveContextRef(third, newSymbolPacket.card.contextRef);
    assert.equal(historical.status, "historical");
    assert.equal(historical.historicalNode.id, "symbol:src/payment.ts:function:capture");
    const invalid = resolveContextRef(third, "not-a-context-ref");
    assert.equal(invalid.status, "unresolved");
    const wrongProject = resolveContextRef(third, createContextRef("project:another", "node", fileId, 1));
    assert.equal(wrongProject.status, "unresolved");
    assert.equal(wrongProject.code, "wrong-project-id");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local API reports invalid cache diagnostics while serving the current validated graph", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-cache-api-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "cache-api" }));
    write(root, "src/live.routes.ts", "router.get('/live', () => ({ ok: true }));");
    app = await startServer({ root, port: 0 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    write(root, ".flopeek/graph.json", "{");
    const cache = await (await fetch(`${baseUrl}/api/cache`)).json();
    assert.equal(cache.status, "invalid");
    assert.equal(cache.diagnostics[0].code, "invalid-json");
    const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.equal(graph.project.name, "cache-api");
    const context = await (await fetch(`${baseUrl}/api/agent-context`)).json();
    assert.equal(context.project.projectId, graph.project.projectId);
    assert.equal(context.cache.graphSchemaVersion, 5);
    assert.equal(context.graphState.graphVersion, 1);
    const bootstrap = await (await fetch(`${baseUrl}/api/agent-bootstrap`)).json();
    assert.equal(bootstrap.schemaVersion, "flopeek-agent-bootstrap/v1");
    assert.equal(bootstrap.project.projectId, graph.project.projectId);
    assert.equal(bootstrap.graph.graphVersion, context.graphState.graphVersion);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded local server reports stale-unverified fallback instead of serving a partial graph", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-bounded-server-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "bounded-server" }));
    write(root, "src/orders.routes.ts", "router.get('/orders', () => ({ ok: true }));");
    write(root, "src/orders.service.ts", "export function listOrders() { return []; }");
    const baseline = scanRepository(root);
    writeGraphCache(root, baseline, { reason: "bounded-server-baseline" });
    const cacheBefore = fs.readFileSync(path.join(root, ".flopeek", "graph.json"));

    app = await startServer({ root, port: 0, maxFiles: 1 });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const scanStatus = await (await fetch(`${baseUrl}/api/scan-status`)).json();
    assert.equal(scanStatus.schemaVersion, "flopeek-scan-outcome/v1");
    assert.equal(scanStatus.status, "partial-by-budget");
    assert.equal(scanStatus.activeGraph.source, "last-complete-cache");
    assert.equal(scanStatus.activeGraph.freshness, "stale-unverified");
    assert.equal(scanStatus.cachePromotion.performed, false);
    const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.equal(graph.project.projectId, baseline.project.projectId);
    assert.equal(graph.state.graphVersion, baseline.state.graphVersion);
    const cancellationResponse = await fetch(`${baseUrl}/api/scan/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(cancellationResponse.status, 409);
    assert.equal((await cancellationResponse.json()).reason, "no-scan-running");
    assert.deepEqual(fs.readFileSync(path.join(root, ".flopeek", "graph.json")), cacheBefore);
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded HTTP cancellation emits one authoritative SSE terminal outcome and retains the complete graph", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-http-cancel-"));
  let app;
  let reader;
  try {
    writeBoundedActiveFixture(root);
    app = await startServer({ root, port: 0, cache: false, maxFiles: 64, timeBudgetMs: 30_000, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const before = await (await fetch(`${baseUrl}/api/graph`)).json();
    const eventResponse = await fetch(`${baseUrl}/api/events`);
    reader = eventResponse.body.getReader();
    const events = createSseEventReader(reader);
    await events.next((event) => event.event === "ready");

    const refresh = fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const running = JSON.parse((await events.next((event) => event.event === "scan-status" && JSON.parse(event.data).phase === "analysis-started", 20_000)).data);
    assert.equal(running.status, "running");
    const cancellationResponse = await fetch(`${baseUrl}/api/scan/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(cancellationResponse.status, 202);
    assert.equal((await cancellationResponse.json()).accepted, true);

    const refreshResponse = await refresh;
    assert.equal(refreshResponse.status, 409);
    const refreshPayload = await refreshResponse.json();
    assert.equal(refreshPayload.scanOutcome.status, "cancelled");
    assert.equal(refreshPayload.activeGraph.freshness, "stale-unverified");
    const terminal = JSON.parse((await events.next((event) => event.event === "scan-status" && JSON.parse(event.data).phase === "terminal", 20_000)).data);
    assert.equal(terminal.status, "cancelled");
    assert.equal(terminal.operationId, running.operationId);
    assert.equal(terminal.activeGraph.freshness, "stale-unverified");
    await assertNoSseEvent(events, (event) => event.event === "scan-status"
      && JSON.parse(event.data).phase === "terminal"
      && JSON.parse(event.data).operationId === running.operationId);
    const after = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.equal(after.project.projectId, before.project.projectId);
    assert.equal(after.state.graphVersion, before.state.graphVersion);
  } finally {
    if (reader) await reader.cancel();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SSE stays available while the initial bounded scan is still building its first graph", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-startup-sse-"));
  const port = await reserveLoopbackPort();
  let app;
  let reader;
  let starting;
  try {
    writeBoundedActiveFixture(root, 2, 2);
    starting = startServer({ root, port, cache: false, maxFiles: 64, timeBudgetMs: 30_000, analysisDelayMs: 1_000, registerServeWorkspace: false });
    const eventResponse = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/events`);
        return response.ok ? response : null;
      } catch {
        return null;
      }
    }, 3_000);
    reader = eventResponse.body.getReader();
    const ready = JSON.parse((await readSseEvent(reader, (event) => event.event === "ready")).data);
    assert.equal(ready.project, null);
    assert.equal(ready.graphState, null);
    assert.equal(ready.scanOutcome.status, "running");
    app = await starting;
    assert.equal((await (await fetch(`http://127.0.0.1:${app.port}/api/scan-status`)).json()).status, "complete");
  } finally {
    if (reader) await reader.cancel();
    if (!app && starting) {
      try {
        app = await starting;
      } catch {
        // The server failed before it could be returned; no close handle is available.
      }
    }
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a filesystem change during a bounded manual scan is reconciled after the active operation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-manual-watch-race-"));
  let app;
  let reader;
  try {
    writeBoundedActiveFixture(root);
    app = await startServer({ root, port: 0, cache: false, maxFiles: 64, timeBudgetMs: 30_000, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const before = await (await fetch(`${baseUrl}/api/graph`)).json();
    const eventResponse = await fetch(`${baseUrl}/api/events`);
    reader = eventResponse.body.getReader();
    const events = createSseEventReader(reader);
    await events.next((event) => event.event === "ready");

    const refresh = fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await events.next((event) => event.event === "scan-status" && JSON.parse(event.data).phase === "analysis-started", 20_000);
    write(root, "src/created-during-manual-scan.ts", "export function createdDuringManualScan() { return true; }");

    const refreshResponse = await refresh;
    assert.equal(refreshResponse.status, 409);
    const failed = await refreshResponse.json();
    assert.equal(failed.scanOutcome.status, "failed");
    assert.equal(failed.scanOutcome.failure.code, "repository-changed-during-analysis");
    assert.equal(failed.activeGraph.freshness, "stale-unverified");
    assert.equal(failed.activeGraph.projectId, before.project.projectId);
    assert.equal(failed.activeGraph.graphVersion, before.state.graphVersion);
    const reconciled = await waitFor(async () => {
      const graph = await (await fetch(`${baseUrl}/api/graph`)).json();
      return graph.nodes.some((node) => node.path === "src/created-during-manual-scan.ts") ? graph : null;
    }, 30_000);
    assert.ok(reconciled.nodes.some((node) => node.path === "src/created-during-manual-scan.ts"));
    const status = await waitFor(async () => {
      const candidate = await (await fetch(`${baseUrl}/api/scan-status`)).json();
      return candidate.status === "complete" ? candidate : null;
    }, 30_000);
    assert.equal(status.status, "complete");
    assert.equal(status.activeGraph.freshness, "current");
  } finally {
    if (reader) await reader.cancel();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded local server preserves its active graph when a repository switch cannot produce evidence", async () => {
  const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-active-server-"));
  const candidateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-candidate-server-"));
  let app;
  let reader;
  try {
    write(activeRoot, "package.json", JSON.stringify({ name: "active-server" }));
    write(activeRoot, "src/active.ts", "export function active() { return true; }");
    write(candidateRoot, "package.json", JSON.stringify({ name: "candidate-server" }));
    write(candidateRoot, "src/first.ts", "export function first() { return true; }");
    write(candidateRoot, "src/second.ts", "export function second() { return true; }");

    app = await startServer({ root: activeRoot, port: 0, maxFiles: 1, cache: false, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const before = await (await fetch(`${baseUrl}/api/graph`)).json();
    const eventResponse = await fetch(`${baseUrl}/api/events`);
    reader = eventResponse.body.getReader();
    const events = createSseEventReader(reader);
    await events.next((event) => event.event === "ready");
    const switchResponse = await fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: candidateRoot }),
    });
    assert.equal(switchResponse.status, 409);
    assert.match((await switchResponse.json()).error, /Repository switch was not applied/);

    const after = await (await fetch(`${baseUrl}/api/graph`)).json();
    assert.equal(after.project.projectId, before.project.projectId);
    assert.equal(after.state.graphVersion, before.state.graphVersion);
    const scanStatus = await (await fetch(`${baseUrl}/api/scan-status`)).json();
    assert.equal(scanStatus.status, "complete");
    assert.equal(scanStatus.activeGraph.projectId, before.project.projectId);
    assert.equal(scanStatus.activeGraph.freshness, "current");
    await assertNoSseEvent(events, (event) => event.event === "scan-status");
  } finally {
    if (reader) await reader.cancel();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(activeRoot, { recursive: true, force: true });
    fs.rmSync(candidateRoot, { recursive: true, force: true });
  }
});

test("submitting the active repository reuses the current no-cache scan session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-same-root-server-"));
  let app;
  try {
    write(root, "package.json", JSON.stringify({ name: "same-root-server" }));
    write(root, "src/active.ts", "export function active() { return true; }");
    app = await startServer({ root, port: 0, maxFiles: 2, cache: false, registerServeWorkspace: false });
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const before = await (await fetch(`${baseUrl}/api/graph`)).json();
    write(root, "src/active.ts", "export function active() { return false; }");

    const refreshResponse = await fetch(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
    assert.equal(refreshResponse.status, 200);
    const after = await refreshResponse.json();
    assert.equal(after.project.projectId, before.project.projectId);
    assert.equal(after.state.graphVersion, before.state.graphVersion + 1);
    const scanStatus = await (await fetch(`${baseUrl}/api/scan-status`)).json();
    assert.equal(scanStatus.activeGraph.projectId, before.project.projectId);
    assert.equal(scanStatus.activeGraph.graphVersion, after.state.graphVersion);
    assert.equal(scanStatus.activeGraph.freshness, "current");
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function safelyRead(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
