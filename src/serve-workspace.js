"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");

const SERVE_WORKSPACE_MEMBER_SCHEMA = "flowpeek-serve-workspace-member/v1";
const SERVE_WORKSPACE_SCHEMA = "flowpeek-serve-workspace/v1";
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;

class ServeWorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServeWorkspaceError";
    this.code = code;
  }
}

function hash(value, length = 20) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function workspaceIdForProject(projectId) {
  if (typeof projectId !== "string" || !projectId) throw new ServeWorkspaceError("missing-project-id", "A serve workspace requires a project ID.");
  return `workspace:${hash(projectId)}`;
}

function normalizeWorkspaceId(value, projectId) {
  const workspaceId = value === undefined || value === null || value === "" ? workspaceIdForProject(projectId) : String(value).trim();
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new ServeWorkspaceError("invalid-workspace-id", "workspaceId must be 1-120 characters using letters, numbers, dot, underscore, colon, or hyphen.");
  return workspaceId;
}

function registryRoot(options = {}) {
  return path.resolve(options.registryRoot || process.env.FLOWPEEK_SERVE_REGISTRY || path.join(os.homedir(), ".flowpeek", "serve-workspaces"));
}

function memberPath(root, instanceId) {
  return path.join(root, `${hash(instanceId, 40)}.member.json`);
}

function isMember(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === SERVE_WORKSPACE_MEMBER_SCHEMA
    && typeof value.instanceId === "string" && value.instanceId
    && typeof value.workspaceId === "string" && WORKSPACE_ID_PATTERN.test(value.workspaceId)
    && typeof value.project?.projectId === "string" && value.project.projectId
    && typeof value.project?.name === "string" && value.project.name
    && typeof value.service?.root === "string" && path.isAbsolute(value.service.root)
    && typeof value.service?.label === "string" && value.service.label
    && value.endpoint?.host === "127.0.0.1"
    && Number.isInteger(value.endpoint?.port) && value.endpoint.port > 0 && value.endpoint.port <= 65535
    && typeof value.endpoint?.url === "string" && value.endpoint.url === `http://127.0.0.1:${value.endpoint.port}`
    && Number.isInteger(value.process?.pid) && value.process.pid > 0
    && typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt));
}

function processStatus(pid) {
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    return error?.code === "EPERM" ? "active" : "stale";
  }
}

function readMembers(options = {}) {
  const root = registryRoot(options);
  if (!fs.existsSync(root)) return { root, records: [], diagnostics: [] };
  const records = [];
  const diagnostics = [];
  for (const name of fs.readdirSync(root).filter((item) => item.endsWith(".member.json")).sort()) {
    const target = path.join(root, name);
    try {
      const record = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!isMember(record)) {
        diagnostics.push({ code: "invalid-serve-workspace-member", file: name, message: "Registry member does not match flowpeek-serve-workspace-member/v1." });
        continue;
      }
      records.push({ ...record, status: processStatus(record.process.pid) });
    } catch (error) {
      diagnostics.push({ code: "invalid-serve-workspace-json", file: name, message: `Registry member is not valid JSON (${error.message}).` });
    }
  }
  return { root, records, diagnostics };
}

function listServeWorkspace(workspaceId, options = {}) {
  const read = readMembers(options);
  const records = read.records
    .filter((record) => record.workspaceId === workspaceId)
    .sort((left, right) => left.project.name.localeCompare(right.project.name) || left.instanceId.localeCompare(right.instanceId));
  const active = records.filter((record) => record.status === "active");
  return {
    schemaVersion: SERVE_WORKSPACE_SCHEMA,
    workspaceId,
    scope: "machine-local-serve-registry",
    status: read.diagnostics.length ? "degraded" : "available",
    memberCount: records.length,
    activeMemberCount: active.length,
    staleMemberCount: records.length - active.length,
    projectIds: [...new Set(active.map((record) => record.project.projectId))].sort(),
    members: records,
    diagnostics: read.diagnostics,
    limitations: [
      "Each member retains its own graph, cache, graph version, and project identity; this registry does not merge evidence graphs.",
      "Cross-service relationships require explicit portable Context Refs or later contract evidence; matching names alone never creates a graph edge.",
      "The registry contains machine-local roots and loopback endpoints and is never included in portable handoff exports.",
    ],
  };
}

function registerServeWorkspace(graph, options = {}) {
  if (!graph?.project?.projectId) throw new ServeWorkspaceError("missing-project-id", "A scanned graph is required before registering a serve workspace.");
  const root = registryRoot(options);
  const workspaceId = normalizeWorkspaceId(options.workspaceId, graph.project.projectId);
  const instanceId = options.instanceId || `serve:${crypto.randomUUID()}`;
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServeWorkspaceError("invalid-port", "A registered serve workspace member requires a bound TCP port.");
  const record = {
    schemaVersion: SERVE_WORKSPACE_MEMBER_SCHEMA,
    instanceId,
    workspaceId,
    project: { projectId: graph.project.projectId, name: graph.project.name },
    service: { label: options.serviceLabel || graph.project.name, root: graph.project.root },
    endpoint: { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` },
    process: { pid: process.pid },
    startedAt: options.startedAt || new Date().toISOString(),
  };
  if (!isMember(record)) throw new ServeWorkspaceError("invalid-member", "The serve workspace member could not be normalized.");
  fs.mkdirSync(root, { recursive: true });
  const target = memberPath(root, instanceId);
  atomicWriteJson(target, record);
  return { record, path: target, workspace: listServeWorkspace(workspaceId, { registryRoot: root }) };
}

function unregisterServeWorkspace(instanceId, options = {}) {
  const target = memberPath(registryRoot(options), instanceId);
  if (!fs.existsSync(target)) return false;
  try {
    const record = JSON.parse(fs.readFileSync(target, "utf8"));
    if (record.instanceId !== instanceId || record.process?.pid !== process.pid) return false;
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SERVE_WORKSPACE_MEMBER_SCHEMA,
  SERVE_WORKSPACE_SCHEMA,
  ServeWorkspaceError,
  listServeWorkspace,
  normalizeWorkspaceId,
  readMembers,
  registerServeWorkspace,
  registryRoot,
  unregisterServeWorkspace,
  workspaceIdForProject,
};
