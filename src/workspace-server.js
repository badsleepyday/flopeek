"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { atomicWriteJson } = require("./graph-cache");
const { getFlowProjection } = require("./flow-lens");
const { listenOnAvailablePort, startServer } = require("./server");
const { normalizeWorkspaceId, registryRoot, workspaceIdForProject } = require("./serve-workspace");
const { readWorkspaceContractReferences, resolveWorkspaceContractReferences, saveWorkspaceContractReference } = require("./workspace-contract-reference");

const WORKSPACE_DEFINITION_SCHEMA = "flowpeek-serve-workspace-definition/v1";
const WORKSPACE_HUB_SCHEMA = "flowpeek-workspace-hub/v1";
const WORKSPACE_HUB_REGISTRATION_SCHEMA = "flowpeek-workspace-hub-registration/v1";
const MAX_REQUEST_BODY_BYTES = 100_000;

function definitionPath(workspaceId, options = {}) {
  const safe = Buffer.from(workspaceId, "utf8").toString("base64url");
  return path.join(registryRoot(options), `${safe}.workspace.json`);
}

function hubRegistrationPath(workspaceId, options = {}) {
  const safe = Buffer.from(workspaceId, "utf8").toString("base64url");
  return path.join(registryRoot(options), `${safe}.hub.json`);
}

function processStatus(pid) {
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    return error?.code === "EPERM" ? "active" : "stale";
  }
}

function isHubRegistration(value, workspaceId) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["schemaVersion", "instanceId", "workspaceId", "endpoint", "process", "startedAt"].includes(key))
    && value.schemaVersion === WORKSPACE_HUB_REGISTRATION_SCHEMA
    && typeof value.instanceId === "string" && value.instanceId
    && value.workspaceId === workspaceId
    && value.endpoint?.host === "127.0.0.1"
    && Number.isInteger(value.endpoint?.port) && value.endpoint.port > 0 && value.endpoint.port <= 65535
    && value.endpoint?.url === `http://127.0.0.1:${value.endpoint.port}`
    && Number.isInteger(value.process?.pid) && value.process.pid > 0
    && typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt));
}

function readHubRegistration(workspaceId, options = {}) {
  if (!workspaceId) return null;
  const target = hubRegistrationPath(workspaceId, options);
  if (!fs.existsSync(target)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!isHubRegistration(value, workspaceId)) return null;
    return { ...value, status: processStatus(value.process.pid) };
  } catch {
    return null;
  }
}

function writeHubRegistration(workspaceId, port, options = {}) {
  const record = {
    schemaVersion: WORKSPACE_HUB_REGISTRATION_SCHEMA,
    instanceId: `workspace-hub:${crypto.randomUUID()}`,
    workspaceId,
    endpoint: { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` },
    process: { pid: process.pid },
    startedAt: new Date().toISOString(),
  };
  if (!isHubRegistration(record, workspaceId)) throw new Error("Workspace hub registration could not be normalized.");
  const target = hubRegistrationPath(workspaceId, options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteJson(target, record);
  return record;
}

function removeHubRegistration(record, options = {}) {
  if (!record) return false;
  const target = hubRegistrationPath(record.workspaceId, options);
  if (!fs.existsSync(target)) return false;
  try {
    const current = JSON.parse(fs.readFileSync(target, "utf8"));
    if (current.instanceId !== record.instanceId || current.process?.pid !== process.pid) return false;
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readDefinition(workspaceId, options = {}) {
  const target = definitionPath(workspaceId, options);
  if (!fs.existsSync(target)) return { schemaVersion: WORKSPACE_DEFINITION_SCHEMA, workspaceId, projects: [] };
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (value?.schemaVersion !== WORKSPACE_DEFINITION_SCHEMA || value.workspaceId !== workspaceId || !Array.isArray(value.projects)) return { schemaVersion: WORKSPACE_DEFINITION_SCHEMA, workspaceId, projects: [] };
    const projects = value.projects.filter((item) => typeof item?.root === "string" && path.isAbsolute(item.root) && typeof item?.serviceLabel === "string");
    return { schemaVersion: WORKSPACE_DEFINITION_SCHEMA, workspaceId, projects };
  } catch {
    return { schemaVersion: WORKSPACE_DEFINITION_SCHEMA, workspaceId, projects: [] };
  }
}

function writeDefinition(workspaceId, projects, options = {}) {
  const target = definitionPath(workspaceId, options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteJson(target, {
    schemaVersion: WORKSPACE_DEFINITION_SCHEMA,
    workspaceId,
    scope: "machine-local",
    projects: projects
      .map((item) => ({ projectId: item.projectId, root: item.root, serviceLabel: item.serviceLabel }))
      .sort((left, right) => left.serviceLabel.localeCompare(right.serviceLabel) || left.projectId.localeCompare(right.projectId)),
    limitations: ["This file contains machine-local project roots and is not a portable handoff artifact."],
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length <= MAX_REQUEST_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      if (length > MAX_REQUEST_BODY_BYTES) return reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(Object.assign(new Error("Request body must be JSON."), { statusCode: 400 })); }
    });
    request.on("error", reject);
  });
}

function trustedLocalMutation(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) && Number(parsed.port) === request.socket.localPort;
  } catch {
    return false;
  }
}

function send(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function proxy(request, response, targetPort) {
  const headers = { ...request.headers, host: `127.0.0.1:${targetPort}` };
  if (request.headers.origin) {
    try {
      const origin = new URL(request.headers.origin);
      if (["127.0.0.1", "localhost", "::1"].includes(origin.hostname) && Number(origin.port) === request.socket.localPort) headers.origin = `http://127.0.0.1:${targetPort}`;
    } catch {}
  }
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: targetPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) send(response, 502, { error: `Active project backend is unavailable (${error.message}).` });
    else response.destroy(error);
  });
  request.pipe(upstream);
}

async function forwardJsonMutation(response, targetPort, pathname, body = {}) {
  const upstream = await fetch(`http://127.0.0.1:${targetPort}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${targetPort}`,
    },
    body: JSON.stringify(body),
  });
  let payload;
  try { payload = await upstream.json(); }
  catch { return send(response, 502, { error: "Active project backend returned an invalid JSON response." }); }
  return send(response, upstream.status, payload);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function startWorkspaceServer(options = {}) {
  const projects = new Map();
  const diagnostics = [];
  let workspaceId = options.workspaceId ? normalizeWorkspaceId(options.workspaceId, "workspace:bootstrap") : null;
  let activeProjectId = null;

  const projectList = () => [...projects.values()]
    .map((item) => ({
      projectId: item.app.project.projectId,
      name: item.app.project.name,
      serviceLabel: item.serviceLabel,
      root: item.app.root,
      active: item.app.project.projectId === activeProjectId,
      status: item.app.server.listening ? "active" : "unavailable",
    }))
    .sort((left, right) => left.serviceLabel.localeCompare(right.serviceLabel) || left.projectId.localeCompare(right.projectId));

  const persist = () => {
    if (workspaceId) writeDefinition(workspaceId, projectList(), { registryRoot: options.registryRoot });
  };

  const addProject = async (input = {}) => {
    const requestedRoot = path.resolve(input.root || "");
    if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) throw Object.assign(new Error("Project root must be an existing directory."), { statusCode: 400 });
    const app = await startServer({
      root: requestedRoot,
      port: 0,
      open: false,
      registerServeWorkspace: false,
      registryRoot: options.registryRoot,
    });
    const projectId = app.project.projectId;
    const existing = projects.get(projectId);
    if (existing) {
      await closeServer(app.server);
      activeProjectId = projectId;
      return { created: false, project: projectList().find((item) => item.projectId === projectId) };
    }
    if (!workspaceId) workspaceId = workspaceIdForProject(projectId);
    const serviceLabel = String(input.serviceLabel || app.project.name).trim().slice(0, 120) || app.project.name;
    projects.set(projectId, { app, serviceLabel });
    if (!activeProjectId) activeProjectId = projectId;
    persist();
    return { created: true, project: projectList().find((item) => item.projectId === projectId) };
  };

  if (workspaceId && options.restore !== false) {
    for (const item of readDefinition(workspaceId, { registryRoot: options.registryRoot }).projects) {
      if (!fs.existsSync(item.root)) {
        diagnostics.push({ code: "workspace-project-root-missing", projectId: item.projectId, message: `Stored project root is unavailable: ${item.root}` });
        continue;
      }
      try { await addProject(item); }
      catch (error) { diagnostics.push({ code: "workspace-project-restore-failed", projectId: item.projectId, message: error.message }); }
    }
  }
  for (const item of options.projects || []) {
    const result = await addProject(typeof item === "string" ? { root: item } : item);
    activeProjectId = result.project.projectId;
  }
  if (!projects.size) throw new Error("A workspace hub requires at least one active project.");

  const flowSnapshot = (input, label) => {
    const allowed = ["projectId", "flowId", "expectedGraphVersion", "expectedFlowContextRef"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) throw Object.assign(new Error(`${label} requires projectId, flowId, expectedGraphVersion, and expectedFlowContextRef.`), { statusCode: 400 });
    if (typeof input.projectId !== "string" || typeof input.flowId !== "string" || !Number.isSafeInteger(input.expectedGraphVersion) || typeof input.expectedFlowContextRef !== "string") throw Object.assign(new Error(`${label} is incomplete.`), { statusCode: 400 });
    const project = projects.get(input.projectId);
    if (!project) throw Object.assign(new Error(`${label} project is not active in this workspace.`), { statusCode: 404 });
    const graph = project.app.getGraph();
    const lens = getFlowProjection(graph, input.flowId);
    if (!lens) throw Object.assign(new Error(`${label} flow is not present in the current project graph.`), { statusCode: 404 });
    if (graph.state.graphVersion !== input.expectedGraphVersion || lens.flow.contextRef !== input.expectedFlowContextRef) throw Object.assign(new Error(`${label} targets a stale graph or Flow Context Ref. Refresh both Flow Lenses before declaring a contract.`), { statusCode: 409 });
    const entry = graph.nodes.find((node) => node.id === lens.flow.entryId) || null;
    const endpoint = String(entry?.label || "").match(/^([A-Z]+)\s+(.+)$/);
    return {
      projectId: graph.project.projectId,
      flowId: lens.flow.id,
      graphVersion: graph.state.graphVersion,
      contextRef: lens.flow.contextRef,
      title: lens.flow.title,
      method: endpoint ? endpoint[1] : null,
      route: endpoint ? endpoint[2] : null,
    };
  };

  const resolveSnapshot = (snapshot) => {
    const project = projects.get(snapshot.projectId);
    if (!project) return { status: "unavailable", reason: "Referenced project is not active in this workspace." };
    const graph = project.app.getGraph();
    const lens = getFlowProjection(graph, snapshot.flowId);
    if (!lens) return { status: "unavailable", reason: "Referenced flow is not present in the current project graph." };
    if (graph.state.graphVersion === snapshot.graphVersion && lens.flow.contextRef === snapshot.contextRef) return { status: "current", currentGraphVersion: graph.state.graphVersion, currentContextRef: lens.flow.contextRef };
    return { status: "stale", reason: "Referenced project graph or Flow Context Ref has changed.", currentGraphVersion: graph.state.graphVersion, currentContextRef: lens.flow.contextRef };
  };

  const workspaceContracts = () => {
    const stored = readWorkspaceContractReferences(workspaceId, { registryRoot: options.registryRoot });
    if (stored.status !== "available") return { schemaVersion: "flowpeek-workspace-contract-reference-list/v1", status: "unavailable", records: [], reason: stored.reason, limitation: "Unsafe or unreadable machine-local contract metadata was not reused." };
    return {
      schemaVersion: "flowpeek-workspace-contract-reference-list/v1",
      status: "available",
      total: stored.records.length,
      records: resolveWorkspaceContractReferences(stored.records, resolveSnapshot),
      limitation: "References remain separate from every project graph and require both reviewed Flow Context Refs to remain current.",
    };
  };

  const contractCatalog = (projectId, requestedLimit, requestedOffset) => {
    const project = projects.get(projectId);
    if (!project) throw Object.assign(new Error("Project is not active in this workspace."), { statusCode: 404 });
    const graph = project.app.getGraph();
    const limit = Math.max(1, Math.min(Number.isInteger(requestedLimit) ? requestedLimit : 100, 200));
    const flows = [...(graph.flows || [])].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || (flows.length && requestedOffset >= flows.length)) throw Object.assign(new Error("offset must select an existing Flow Lens page."), { statusCode: 400 });
    const offset = requestedOffset;
    const end = Math.min(offset + limit, flows.length);
    const selected = flows.slice(offset, end).map((flow) => {
      const lens = getFlowProjection(graph, flow.id);
      return { id: lens.flow.id, title: lens.flow.title, contextRef: lens.flow.contextRef, graphVersion: graph.state.graphVersion };
    });
    const omittedFlowIds = [...flows.slice(0, offset), ...flows.slice(end)].map((flow) => flow.id);
    return {
      schemaVersion: "flowpeek-workspace-contract-catalog/v1",
      projectId: graph.project.projectId,
      graphVersion: graph.state.graphVersion,
      total: flows.length,
      offset,
      returned: selected.length,
      omittedFlowIds,
      truncated: omittedFlowIds.length > 0,
      previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
      nextOffset: end < flows.length ? end : null,
      warning: omittedFlowIds.length ? `Showing Flow Lenses ${offset + 1}-${end} of ${flows.length}; ${omittedFlowIds.length} can be selected on another page.` : null,
      flows: selected,
    };
  };

  const workspacePayload = () => ({
    schemaVersion: WORKSPACE_HUB_SCHEMA,
    mode: "workspace-hub",
    workspaceId,
    sourceOfTruth: { host: "127.0.0.1", port: server.address()?.port || null, url: server.address() ? `http://127.0.0.1:${server.address().port}` : null },
    activeProjectId,
    projectCount: projects.size,
    projects: projectList(),
    contractReferences: workspaceContracts(),
    diagnostics,
    boundaries: {
      graphIsolation: "Each project retains an independent graph, projectId, graphVersion, watcher, and .flowpeek cache.",
      crossProjectEdges: "No cross-project edge is inferred from matching names or routes. Explicit contract/evidence references are required.",
      internalBackends: "Ephemeral loopback backends are implementation details; the hub port is the user-facing web source of truth.",
      portability: "The workspace definition is machine-local and excluded from handoff exports.",
    },
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { ok: true, mode: "workspace-hub", workspaceId, activeProjectId, projectCount: projects.size, port: server.address().port });
      if (request.method === "GET" && ["/api/workspace", "/api/serve-workspace"].includes(url.pathname)) return send(response, 200, workspacePayload());
      if (request.method === "GET" && url.pathname === "/api/workspace/contracts") return send(response, 200, workspaceContracts());
      if (request.method === "GET" && url.pathname === "/api/workspace/contracts/catalog") return send(response, 200, contractCatalog(url.searchParams.get("projectId"), Number(url.searchParams.get("limit") || 100), Number(url.searchParams.get("offset") || 0)));
      if (request.method === "POST" && url.pathname === "/api/workspace/projects") {
        if (!trustedLocalMutation(request)) return send(response, 403, { error: "Workspace project activation must come from a trusted local caller." });
        const result = await addProject(await readJsonBody(request));
        activeProjectId = result.project.projectId;
        persist();
        return send(response, result.created ? 201 : 200, { ...result, workspace: workspacePayload() });
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/active") {
        if (!trustedLocalMutation(request)) return send(response, 403, { error: "Workspace activation must come from a trusted local caller." });
        const body = await readJsonBody(request);
        if (!projects.has(body.projectId)) return send(response, 404, { error: "Project is not active in this workspace." });
        activeProjectId = body.projectId;
        return send(response, 200, workspacePayload());
      }
      if (request.method === "POST" && url.pathname === "/api/workspace/contracts") {
        if (!trustedLocalMutation(request)) return send(response, 403, { error: "Workspace contract references must come from a trusted local caller." });
        const body = await readJsonBody(request);
        if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some((key) => !["operationId", "source", "target", "summary", "declaredBy"].includes(key))) return send(response, 400, { error: "Workspace contract references accept only operationId, source, target, summary, and declaredBy." });
        const source = flowSnapshot(body?.source, "Source contract snapshot");
        const target = flowSnapshot(body?.target, "Target contract snapshot");
        const result = saveWorkspaceContractReference(workspaceId, { operationId: body?.operationId, source, target, summary: body?.summary, declaredBy: body?.declaredBy }, { registryRoot: options.registryRoot });
        return send(response, result.created ? 201 : 200, { ...result, workspace: workspacePayload() });
      }
      const active = projects.get(activeProjectId);
      if (!active) return send(response, 503, { error: "Workspace has no active project." });
      if (request.method === "POST" && url.pathname === "/api/scan") {
        if (!trustedLocalMutation(request)) return send(response, 403, { error: "Workspace scans must come from a trusted local caller." });
        const body = await readJsonBody(request);
        if (!body || Array.isArray(body) || typeof body !== "object") return send(response, 400, { error: "Workspace scan request must be a JSON object." });
        if (Object.keys(body).length) return send(response, 400, { error: "A workspace scan only refreshes the active project's configured root. Use /api/workspace/projects to activate another project." });
        return forwardJsonMutation(response, active.app.port, "/api/scan", {});
      }
      return proxy(request, response, active.app.port);
    } catch (error) {
      return send(response, error.statusCode || 400, { error: error.message || "Workspace request failed." });
    }
  });

  const portBinding = await listenOnAvailablePort(server, Number(options.port ?? 4780), options);
  let hubRegistration;
  try { hubRegistration = writeHubRegistration(workspaceId, server.address().port, { registryRoot: options.registryRoot }); }
  catch (error) {
    await closeServer(server);
    await Promise.all([...projects.values()].map((item) => closeServer(item.app.server)));
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await closeServer(server);
    await Promise.all([...projects.values()].map((item) => closeServer(item.app.server)));
    removeHubRegistration(hubRegistration, { registryRoot: options.registryRoot });
  };
  return { server, port: server.address().port, portBinding, workspaceId, addProject, workspace: workspacePayload, close };
}

async function activateOnWorkspaceHubPort(options, port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(options.timeout || 750) });
  if (!response.ok) return null;
  let health;
  try { health = await response.json(); }
  catch { return null; }
  if (health.mode !== "workspace-hub") return null;
  if (options.workspaceId && health.workspaceId !== options.workspaceId) return null;
  const activated = await fetch(`http://127.0.0.1:${port}/api/workspace/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: path.resolve(options.root), serviceLabel: options.serviceLabel || null }),
  });
  if (!activated.ok) throw new Error((await activated.json()).error || "Unable to activate project on the existing workspace hub.");
  return activated.json();
}

function unavailableEndpoint(error) {
  return error?.name === "TimeoutError" || error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED";
}

async function activateOnWorkspaceHub(options = {}) {
  const registered = readHubRegistration(options.workspaceId, { registryRoot: options.registryRoot });
  const ports = [...new Set([Number(options.port), registered?.status === "active" ? registered.endpoint.port : null].filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
  for (const port of ports) {
    try {
      const activated = await activateOnWorkspaceHubPort(options, port);
      if (activated) return { ...activated, hubPort: port, discoveredFromRegistry: port !== Number(options.port) };
    } catch (error) {
      if (!unavailableEndpoint(error)) throw error;
    }
  }
  return null;
}

module.exports = {
  WORKSPACE_DEFINITION_SCHEMA,
  WORKSPACE_HUB_SCHEMA,
  WORKSPACE_HUB_REGISTRATION_SCHEMA,
  activateOnWorkspaceHub,
  readHubRegistration,
  readDefinition,
  startWorkspaceServer,
};
