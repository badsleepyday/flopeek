"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { listenOnAvailablePort, startServer } = require("../../src/server");
const { normalizeWorkspaceId, workspaceIdForProject } = require("../../src/serve-workspace");

function repository(parent, name) {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }), "utf8");
  fs.writeFileSync(path.join(root, "src", "route.ts"), `router.get('/${name}', () => ({ ok: true }));`, "utf8");
  return root;
}

async function close(app) {
  if (app?.server?.listening) await new Promise((resolve) => app.server.close(resolve));
}

test("serve workspace IDs are deterministic per project and validate explicit group IDs", () => {
  assert.equal(workspaceIdForProject("project:orders"), workspaceIdForProject("project:orders"));
  assert.notEqual(workspaceIdForProject("project:orders"), workspaceIdForProject("project:payments"));
  assert.equal(normalizeWorkspaceId("commerce-platform", "project:orders"), "commerce-platform");
  assert.throws(() => normalizeWorkspaceId("bad workspace", "project:orders"), /workspaceId/);
});

test("port fallback skips occupied and OS-reserved loopback ports", async () => {
  class FakeServer extends EventEmitter {
    listen(port) {
      queueMicrotask(() => {
        if (port === 43100) return this.emit("error", Object.assign(new Error("occupied"), { code: "EADDRINUSE" }));
        if (port === 43101) return this.emit("error", Object.assign(new Error("reserved"), { code: "EACCES" }));
        this.boundPort = port;
        this.emit("listening");
      });
    }

    address() { return { port: this.boundPort }; }
  }

  const result = await listenOnAvailablePort(new FakeServer(), 43100, { portSearchLimit: 5 });
  assert.deepEqual(result, { requestedPort: 43100, port: 43102, fallback: true, attempts: 3 });
  await assert.rejects(() => listenOnAvailablePort(new FakeServer(), 43101, { portFallback: false }), (error) => error.code === "EACCES");
});

test("serve keeps an occupied instance alive and registers multiple project services in one workspace", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-serve-workspace-"));
  const registryRoot = path.join(temporary, "registry");
  const firstRoot = repository(temporary, "orders-service");
  const secondRoot = repository(temporary, "payments-service");
  let first;
  let second;
  try {
    first = await startServer({ root: firstRoot, port: 0, workspaceId: "commerce-platform", serviceLabel: "orders", registryRoot });
    second = await startServer({ root: secondRoot, port: first.port, workspaceId: "commerce-platform", serviceLabel: "payments", registryRoot });

    assert.notEqual(second.port, first.port);
    assert.equal(second.portBinding.requestedPort, first.port);
    assert.equal(second.portBinding.fallback, true);

    const firstHealth = await (await fetch(`http://127.0.0.1:${first.port}/api/health`)).json();
    assert.equal(firstHealth.ok, true);
    assert.equal(firstHealth.workspaceId, "commerce-platform");

    const workspace = await (await fetch(`http://127.0.0.1:${second.port}/api/serve-workspace`)).json();
    assert.equal(workspace.schemaVersion, "flowpeek-serve-workspace/v1");
    assert.equal(workspace.activeMemberCount, 2);
    assert.equal(workspace.projectIds.length, 2);
    assert.deepEqual(workspace.members.map((member) => member.service.label), ["orders", "payments"]);
    assert.ok(workspace.limitations.some((item) => item.includes("does not merge evidence graphs")));

    await close(second);
    second = null;
    const afterClose = await (await fetch(`http://127.0.0.1:${first.port}/api/serve-workspace`)).json();
    assert.equal(afterClose.activeMemberCount, 1);
    assert.equal(afterClose.members[0].service.label, "orders");
  } finally {
    await close(second);
    await close(first);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("strict port mode reports collision and never stops the existing server", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-strict-port-"));
  const registryRoot = path.join(temporary, "registry");
  const firstRoot = repository(temporary, "first-service");
  const secondRoot = repository(temporary, "second-service");
  let first;
  try {
    first = await startServer({ root: firstRoot, port: 0, registryRoot });
    await assert.rejects(() => startServer({ root: secondRoot, port: first.port, portFallback: false, registryRoot }), (error) => error.code === "EADDRINUSE");
    const health = await (await fetch(`http://127.0.0.1:${first.port}/api/health`)).json();
    assert.equal(health.ok, true);
  } finally {
    await close(first);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
