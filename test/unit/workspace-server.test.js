"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { activateOnWorkspaceHub, startWorkspaceServer } = require("../../src/workspace-server");

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function repository(parent, name, route) {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }), "utf8");
  fs.writeFileSync(path.join(root, "src", "route.ts"), `router.get('${route}', () => ({ service: '${name}' }));`, "utf8");
  return root;
}

test("global workspace hub keeps one web port while activating isolated project graphs", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-workspace-hub-"));
  const registryRoot = path.join(temporary, "registry");
  const ordersRoot = repository(temporary, "orders-service", "/orders");
  fs.writeFileSync(path.join(ordersRoot, "src", "orders-status.ts"), "router.get('/orders/status', () => ({ service: 'orders' }));", "utf8");
  fs.writeFileSync(path.join(ordersRoot, "src", "orders-health.ts"), "router.get('/orders/health', () => ({ service: 'orders' }));", "utf8");
  const paymentsRoot = repository(temporary, "payments-service", "/payments");
  let hub;
  try {
    hub = await startWorkspaceServer({ port: 0, workspaceId: "commerce", registryRoot, projects: [{ root: ordersRoot, serviceLabel: "orders" }] });
    const hubPort = hub.port;
    const activated = await activateOnWorkspaceHub({ port: hubPort, workspaceId: "commerce", root: paymentsRoot, serviceLabel: "payments" });
    assert.equal(activated.created, true);
    assert.equal(activated.workspace.projectCount, 2);
    assert.equal(hub.port, hubPort);

    const health = await (await fetch(`http://127.0.0.1:${hubPort}/api/health`)).json();
    assert.equal(health.mode, "workspace-hub");
    assert.equal(health.projectCount, 2);
    assert.equal(health.activeProjectId, activated.project.projectId);

    const activeProject = await (await fetch(`http://127.0.0.1:${hubPort}/api/project`)).json();
    assert.equal(activeProject.projectId, activated.project.projectId);
    const activeFlows = await (await fetch(`http://127.0.0.1:${hubPort}/api/flows`)).json();
    assert.ok(activeFlows.some((flow) => flow.title.includes("/payments")));
    assert.ok(!activeFlows.some((flow) => flow.title.includes("/orders")));

    const workspaceBeforeContract = await (await fetch(`http://127.0.0.1:${hubPort}/api/workspace`)).json();
    const ordersProjectForContract = workspaceBeforeContract.projects.find((project) => project.serviceLabel === "orders");
    const ordersCatalog = await (await fetch(`http://127.0.0.1:${hubPort}/api/workspace/contracts/catalog?projectId=${encodeURIComponent(ordersProjectForContract.projectId)}`)).json();
    const paymentsCatalog = await (await fetch(`http://127.0.0.1:${hubPort}/api/workspace/contracts/catalog?projectId=${encodeURIComponent(activated.project.projectId)}`)).json();
    const ordersCatalogPage = await (await fetch(`http://127.0.0.1:${hubPort}/api/workspace/contracts/catalog?projectId=${encodeURIComponent(ordersProjectForContract.projectId)}&limit=1&offset=1`)).json();
    assert.equal(ordersCatalog.total, 3);
    assert.equal(ordersCatalogPage.total, 3);
    assert.equal(ordersCatalogPage.offset, 1);
    assert.equal(ordersCatalogPage.returned, 1);
    assert.equal(ordersCatalogPage.previousOffset, 0);
    assert.equal(ordersCatalogPage.nextOffset, 2);
    assert.equal(ordersCatalogPage.omittedFlowIds.length, 2);
    assert.match(ordersCatalogPage.warning, /another page/);
    const invalidCatalogOffset = await fetch(`http://127.0.0.1:${hubPort}/api/workspace/contracts/catalog?projectId=${encodeURIComponent(ordersProjectForContract.projectId)}&offset=99`);
    assert.equal(invalidCatalogOffset.status, 400);
    const createdContract = await fetch(`http://127.0.0.1:${hubPort}/api/workspace/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${hubPort}` },
      body: JSON.stringify({
        operationId: "orders-to-payments-v1",
        source: { projectId: ordersCatalog.projectId, flowId: ordersCatalog.flows[0].id, expectedGraphVersion: ordersCatalog.graphVersion, expectedFlowContextRef: ordersCatalog.flows[0].contextRef },
        target: { projectId: paymentsCatalog.projectId, flowId: paymentsCatalog.flows[0].id, expectedGraphVersion: paymentsCatalog.graphVersion, expectedFlowContextRef: paymentsCatalog.flows[0].contextRef },
        summary: "Orders service calls the payment boundary after an order is submitted.",
        declaredBy: "Workspace test",
      }),
    });
    assert.equal(createdContract.status, 201);
    const createdContractPayload = await createdContract.json();
    assert.equal(createdContractPayload.record.kind, "http-contract");
    assert.equal(createdContractPayload.workspace.contractReferences.records[0].status, "current");
    assert.equal(createdContractPayload.workspace.contractReferences.records[0].source.projectId, ordersCatalog.projectId);
    assert.equal(createdContractPayload.workspace.contractReferences.records[0].target.projectId, paymentsCatalog.projectId);

    const rejectedUnknownContractField = await fetch(`http://127.0.0.1:${hubPort}/api/workspace/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${hubPort}` },
      body: JSON.stringify({ unexpected: true }),
    });
    assert.equal(rejectedUnknownContractField.status, 400);

    const rejectedRootOverride = await fetch(`http://127.0.0.1:${hubPort}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${hubPort}` },
      body: JSON.stringify({ root: ordersRoot }),
    });
    assert.equal(rejectedRootOverride.status, 400);
    assert.match((await rejectedRootOverride.json()).error, /only refreshes the active project's configured root/);
    const projectAfterRejectedOverride = await (await fetch(`http://127.0.0.1:${hubPort}/api/project`)).json();
    assert.equal(projectAfterRejectedOverride.projectId, activated.project.projectId);

    const refreshedActiveProject = await fetch(`http://127.0.0.1:${hubPort}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${hubPort}` },
      body: JSON.stringify({}),
    });
    assert.equal(refreshedActiveProject.status, 200);
    const paymentLens = await (await fetch(`http://127.0.0.1:${hubPort}/api/flow-lens?flow=${encodeURIComponent(activeFlows[0].id)}`)).json();
    const verifiedThroughHub = await fetch(`http://127.0.0.1:${hubPort}/api/flow-verifications`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${hubPort}` },
      body: JSON.stringify({
        flowId: paymentLens.flow.id,
        expectedGraphVersion: paymentLens.project.graphVersion,
        expectedFlowContextRef: paymentLens.flow.contextRef,
        title: "List payments",
        description: "Verified test description.",
        risk: "low",
        questions: [],
        verifiedBy: "Workspace test",
      }),
    });
    assert.equal(verifiedThroughHub.status, 201);

    const workspace = await (await fetch(`http://127.0.0.1:${hubPort}/api/workspace`)).json();
    const orders = workspace.projects.find((project) => project.serviceLabel === "orders");
    const selected = await fetch(`http://127.0.0.1:${hubPort}/api/workspace/active`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${hubPort}` },
      body: JSON.stringify({ projectId: orders.projectId }),
    });
    assert.equal(selected.status, 200);
    const ordersProject = await (await fetch(`http://127.0.0.1:${hubPort}/api/project`)).json();
    assert.equal(ordersProject.projectId, orders.projectId);
    fs.writeFileSync(path.join(ordersRoot, "src", "route.ts"), "router.get('/orders', () => ({ service: 'orders', version: 2 }));", "utf8");
    const refreshedOrders = await fetch(`http://127.0.0.1:${hubPort}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${hubPort}` },
      body: JSON.stringify({}),
    });
    assert.equal(refreshedOrders.status, 200);
    const staleContracts = await (await fetch(`http://127.0.0.1:${hubPort}/api/workspace/contracts`)).json();
    assert.equal(staleContracts.records[0].status, "stale");
    assert.equal(staleContracts.records[0].targetResolution.status, "current");
  } finally {
    await hub?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workspace definition restores previously activated projects without merging graph identity", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-workspace-restore-"));
  const registryRoot = path.join(temporary, "registry");
  const firstRoot = repository(temporary, "catalog-service", "/catalog");
  const secondRoot = repository(temporary, "inventory-service", "/inventory");
  let firstHub;
  let restoredHub;
  try {
    firstHub = await startWorkspaceServer({ port: 0, workspaceId: "retail", registryRoot, projects: [firstRoot, secondRoot] });
    const firstWorkspace = firstHub.workspace();
    assert.equal(firstWorkspace.projectCount, 2);
    assert.equal(new Set(firstWorkspace.projects.map((project) => project.projectId)).size, 2);
    await firstHub.close();
    firstHub = null;

    restoredHub = await startWorkspaceServer({ port: 0, workspaceId: "retail", registryRoot, projects: [] });
    const restored = restoredHub.workspace();
    assert.equal(restored.projectCount, 2);
    assert.equal(new Set(restored.projects.map((project) => project.projectId)).size, 2);
    assert.match(restored.boundaries.graphIsolation, /independent graph/);
    assert.match(restored.boundaries.crossProjectEdges, /No cross-project edge/);
  } finally {
    await firstHub?.close();
    await restoredHub?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workspace registry rejoins the same hub after deterministic port fallback", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-workspace-fallback-"));
  const registryRoot = path.join(temporary, "registry");
  const firstRoot = repository(temporary, "billing-service", "/billing");
  const secondRoot = repository(temporary, "ledger-service", "/ledger");
  const occupied = http.createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not a Flowpeek hub");
  });
  let hub;
  try {
    await listen(occupied);
    const requestedPort = occupied.address().port;
    hub = await startWorkspaceServer({ port: requestedPort, workspaceId: "finance", registryRoot, projects: [firstRoot] });
    assert.notEqual(hub.port, requestedPort);
    assert.equal(hub.portBinding.fallback, true);

    const activated = await activateOnWorkspaceHub({ port: requestedPort, workspaceId: "finance", registryRoot, root: secondRoot });
    assert.equal(activated.created, true);
    assert.equal(activated.hubPort, hub.port);
    assert.equal(activated.discoveredFromRegistry, true);
    assert.equal(activated.workspace.projectCount, 2);
    assert.equal(occupied.listening, true);
  } finally {
    await hub?.close();
    if (occupied.listening) await close(occupied);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
