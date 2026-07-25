"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { contractStorePath, readWorkspaceContractReferences, saveWorkspaceContractReference } = require("../../src/workspace-contract-reference");

function snapshot(projectId, flowId, version) {
  return {
    projectId,
    flowId,
    graphVersion: version,
    contextRef: `fp://local/${projectId}/flow/${encodeURIComponent(flowId)}@${version}`,
    title: `${projectId} ${flowId}`,
    method: "POST",
    route: `/${projectId}`,
  };
}

test("workspace contract references are idempotent and reject injected store fields", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-workspace-contract-store-"));
  const workspaceId = "commerce";
  try {
    const input = {
      operationId: "orders-to-payments-v1",
      source: snapshot("orders", "flow:orders", 3),
      target: snapshot("payments", "flow:payments", 4),
      summary: "Orders calls the explicit payment boundary.",
      declaredBy: "Workspace test",
    };
    const created = saveWorkspaceContractReference(workspaceId, input, { registryRoot: temporary });
    assert.equal(created.created, true);
    assert.equal(created.record.kind, "http-contract");
    const retried = saveWorkspaceContractReference(workspaceId, input, { registryRoot: temporary });
    assert.equal(retried.created, false);
    assert.equal(readWorkspaceContractReferences(workspaceId, { registryRoot: temporary }).records.length, 1);

    const target = contractStorePath(workspaceId, { registryRoot: temporary });
    const injected = JSON.parse(fs.readFileSync(target, "utf8"));
    injected.records[0].target.hiddenPayload = "must-not-be-reused";
    fs.writeFileSync(target, JSON.stringify(injected), "utf8");
    const unavailable = readWorkspaceContractReferences(workspaceId, { registryRoot: temporary });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(fs.readFileSync(target, "utf8").includes("must-not-be-reused"), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("workspace contract references reject source-like, credential-like, and machine-local human text before normalization", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-workspace-contract-text-"));
  const workspaceId = "commerce";
  const base = {
    operationId: "orders-to-payments-v1",
    source: snapshot("orders", "flow:orders", 3),
    target: snapshot("payments", "flow:payments", 4),
    summary: "Orders calls the explicit payment boundary.",
    declaredBy: "Workspace test",
  };
  try {
    for (const [field, value] of [
      ["summary", "Explanation follows:\nconst leaked = 'not metadata';"],
      ["summary", "Bearer abcdefghijklmno"],
      ["summary", "access_token=not-for-handoff"],
      ["summary", "See C:\\Users\\someone\\secret.txt"],
      ["declaredBy", "export function syntheticAuthor() {}"],
    ]) {
      assert.throws(
        () => saveWorkspaceContractReference(workspaceId, { ...base, operationId: `${base.operationId}-${field}-${value.length}`, [field]: value }, { registryRoot: temporary }),
        (error) => error.code === "unsafe-text" || error.code === "invalid-text",
      );
    }
    const read = readWorkspaceContractReferences(workspaceId, { registryRoot: temporary });
    assert.equal(read.records.length, 0);
    assert.equal(fs.existsSync(contractStorePath(workspaceId, { registryRoot: temporary })), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
