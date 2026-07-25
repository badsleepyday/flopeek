"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("./server");

const SHOWCASE_SCHEMA = "flopeek-showcase/v1";
const SHOWCASE_WORKSPACE_SCHEMA = "flopeek-showcase-workspace/v1";
const SHOWCASE_STATE_FILE = ".flopeek-showcase-workspace.json";
const DEFAULT_SHOWCASE_ROOT = path.join(__dirname, "..", "examples", "commerce-showcase");
const COPY_IGNORES = new Set([".flopeek", ".flowpeek", ".git", "node_modules"]);

class ShowcaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ShowcaseError";
    this.code = code;
  }
}

function readJson(target, code) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    throw new ShowcaseError(code, `Unable to read ${target}: ${error.message}`);
  }
}

function resolveInside(root, relative, field) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative)) throw new ShowcaseError("invalid-showcase-path", `${field} must be a repository-relative path.`);
  const target = path.resolve(root, ...relative.split("/").filter(Boolean));
  const relation = path.relative(root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new ShowcaseError("showcase-path-escape", `${field} resolves outside the showcase workspace.`);
  return target;
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== SHOWCASE_SCHEMA) throw new ShowcaseError("invalid-showcase-schema", `Showcase manifest must use ${SHOWCASE_SCHEMA}.`);
  if (typeof manifest.id !== "string" || !manifest.id || typeof manifest.title !== "string" || !manifest.title) throw new ShowcaseError("invalid-showcase-identity", "Showcase manifest requires id and title.");
  if (typeof manifest.primaryFlow?.flowId !== "string" || !manifest.primaryFlow.flowId || typeof manifest.primaryFlow.route !== "string" || typeof manifest.primaryFlow.method !== "string") throw new ShowcaseError("invalid-showcase-flow", "Showcase manifest requires a primary static flow identity.");
  if (typeof manifest.change?.path !== "string" || typeof manifest.change?.template !== "string" || typeof manifest.change?.description !== "string") throw new ShowcaseError("invalid-showcase-change", "Showcase manifest requires one declared source change and template.");
  if (!Array.isArray(manifest.limitations) || manifest.limitations.length < 4 || manifest.limitations.some((item) => typeof item !== "string" || !item.trim())) throw new ShowcaseError("invalid-showcase-boundaries", "Showcase manifest requires explicit evidence limitations.");
  return manifest;
}

function loadShowcase(sourceRoot = DEFAULT_SHOWCASE_ROOT) {
  const root = fs.realpathSync(sourceRoot);
  const manifest = validateManifest(readJson(path.join(root, "flopeek-showcase.json"), "invalid-showcase-manifest"));
  const sourcePath = resolveInside(root, manifest.change.path, "change.path");
  const templatePath = resolveInside(root, manifest.change.template, "change.template");
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new ShowcaseError("missing-showcase-source", `Declared showcase source does not exist: ${manifest.change.path}`);
  if (!fs.existsSync(templatePath) || !fs.statSync(templatePath).isFile()) throw new ShowcaseError("missing-showcase-template", `Declared showcase template does not exist: ${manifest.change.template}`);
  return { root, manifest, sourcePath, templatePath };
}

function fileSha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function copyShowcase(sourceRoot, workspaceRoot) {
  fs.cpSync(sourceRoot, workspaceRoot, {
    recursive: true,
    filter: (entry) => !COPY_IGNORES.has(path.basename(entry)),
  });
}

function prepareShowcase(options = {}) {
  const source = loadShowcase(options.sourceRoot || DEFAULT_SHOWCASE_ROOT);
  const workspaceRoot = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-showcase-"));
  if (options.workspaceRoot) {
    if (fs.existsSync(workspaceRoot) && fs.readdirSync(workspaceRoot).length) throw new ShowcaseError("showcase-workspace-not-empty", "An explicit showcase workspace must be empty.");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }
  copyShowcase(source.root, workspaceRoot);
  const baselinePath = resolveInside(workspaceRoot, source.manifest.change.path, "change.path");
  const changedTemplatePath = resolveInside(workspaceRoot, source.manifest.change.template, "change.template");
  const state = {
    schemaVersion: SHOWCASE_WORKSPACE_SCHEMA,
    showcaseId: source.manifest.id,
    temporaryWorkspace: true,
    sourceWrites: "explicit-showcase-apply-reset-only",
    targetApplicationExecution: "disabled",
    change: {
      path: source.manifest.change.path,
      baselineSha256: fileSha256(baselinePath),
      changedSha256: fileSha256(changedTemplatePath),
    },
  };
  fs.writeFileSync(path.join(workspaceRoot, SHOWCASE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return {
    schemaVersion: SHOWCASE_WORKSPACE_SCHEMA,
    workspaceRoot,
    manifest: source.manifest,
    state,
    sourceRoot: source.root,
  };
}

function loadWorkspace(workspaceRoot) {
  const root = fs.realpathSync(workspaceRoot);
  const statePath = path.join(root, SHOWCASE_STATE_FILE);
  if (!fs.existsSync(statePath)) throw new ShowcaseError("not-showcase-workspace", `Refusing source mutation because ${SHOWCASE_STATE_FILE} is missing.`);
  const state = readJson(statePath, "invalid-showcase-workspace");
  if (state.schemaVersion !== SHOWCASE_WORKSPACE_SCHEMA || state.temporaryWorkspace !== true || typeof state.showcaseId !== "string") throw new ShowcaseError("invalid-showcase-workspace", "Refusing source mutation because the workspace marker is invalid.");
  const source = loadShowcase();
  if (source.manifest.id !== state.showcaseId || source.manifest.change.path !== state.change?.path) throw new ShowcaseError("showcase-workspace-mismatch", "The workspace marker does not match the installed showcase contract.");
  const target = resolveInside(root, state.change.path, "workspace.change.path");
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new ShowcaseError("missing-workspace-source", `Showcase source is missing: ${state.change.path}`);
  return { root, state, source, target };
}

function showcaseStatus(workspaceRoot) {
  const workspace = loadWorkspace(workspaceRoot);
  const currentSha256 = fileSha256(workspace.target);
  const status = currentSha256 === workspace.state.change.baselineSha256
    ? "baseline"
    : currentSha256 === workspace.state.change.changedSha256
      ? "changed"
      : "diverged";
  return {
    schemaVersion: SHOWCASE_WORKSPACE_SCHEMA,
    showcaseId: workspace.state.showcaseId,
    workspaceRoot: workspace.root,
    status,
    changePath: workspace.state.change.path,
    targetApplicationExecuted: false,
    limitation: "Status compares only the declared showcase source hash. It is not repository cleanliness, runtime evidence, or business verification.",
  };
}

function applyShowcaseChange(workspaceRoot) {
  const workspace = loadWorkspace(workspaceRoot);
  const status = showcaseStatus(workspace.root);
  if (status.status === "diverged") throw new ShowcaseError("showcase-source-diverged", "Refusing to overwrite a showcase source file that differs from both declared states.");
  if (status.status === "changed") return { ...status, changed: false };
  fs.copyFileSync(workspace.source.templatePath, workspace.target);
  const result = showcaseStatus(workspace.root);
  if (result.status !== "changed") throw new ShowcaseError("showcase-apply-failed", "The declared showcase change did not reach its expected hash.");
  return { ...result, changed: true };
}

function resetShowcase(workspaceRoot) {
  const workspace = loadWorkspace(workspaceRoot);
  const status = showcaseStatus(workspace.root);
  if (status.status === "diverged") throw new ShowcaseError("showcase-source-diverged", "Refusing to overwrite a showcase source file that differs from both declared states.");
  if (status.status === "baseline") return { ...status, changed: false };
  fs.copyFileSync(workspace.source.sourcePath, workspace.target);
  const result = showcaseStatus(workspace.root);
  if (result.status !== "baseline") throw new ShowcaseError("showcase-reset-failed", "The showcase source did not return to its expected baseline hash.");
  return { ...result, changed: true };
}

function cleanupShowcase(workspaceRoot) {
  const workspace = loadWorkspace(workspaceRoot);
  fs.rmSync(workspace.root, { recursive: true, force: true });
}

async function startShowcase(options = {}) {
  const prepared = prepareShowcase(options);
  let app;
  try {
    app = await startServer({
      root: prepared.workspaceRoot,
      port: Number.isInteger(options.port) ? options.port : 4780,
      portFallback: options.portFallback !== false,
      registerServeWorkspace: false,
    });
    if (!app.getGraph().flows.some((flow) => flow.id === prepared.manifest.primaryFlow.flowId)) throw new ShowcaseError("missing-primary-showcase-flow", `The primary showcase flow was not detected: ${prepared.manifest.primaryFlow.flowId}`);
  } catch (error) {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(prepared.workspaceRoot, { recursive: true, force: true });
    throw error;
  }
  const query = new URLSearchParams({ showcase: prepared.manifest.id, flow: prepared.manifest.primaryFlow.flowId });
  const url = `http://127.0.0.1:${app.port}/?${query.toString()}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => app.server.close(resolve));
    if (options.keepWorkspace !== true) cleanupShowcase(prepared.workspaceRoot);
  };
  return {
    schemaVersion: SHOWCASE_WORKSPACE_SCHEMA,
    workspaceRoot: prepared.workspaceRoot,
    url,
    port: app.port,
    portBinding: app.portBinding,
    primaryFlow: prepared.manifest.primaryFlow,
    graphState: app.getGraph().state,
    evidenceBoundaries: prepared.manifest.limitations,
    commands: {
      apply: `flopeek showcase apply "${prepared.workspaceRoot}"`,
      reset: `flopeek showcase reset "${prepared.workspaceRoot}"`,
      status: `flopeek showcase status "${prepared.workspaceRoot}"`,
    },
    targetApplicationExecuted: false,
    demonstrationOnly: true,
    app,
    close,
  };
}

function showcasePublicResult(instance) {
  return {
    schemaVersion: instance.schemaVersion,
    workspaceRoot: instance.workspaceRoot,
    url: instance.url,
    port: instance.port,
    portBinding: instance.portBinding,
    primaryFlow: instance.primaryFlow,
    graphState: instance.graphState,
    evidenceBoundaries: instance.evidenceBoundaries,
    commands: instance.commands,
    targetApplicationExecuted: false,
    demonstrationOnly: true,
  };
}

function printShowcase(instance) {
  const result = showcasePublicResult(instance);
  console.log(`Flopeek showcase: ${result.url}`);
  console.log(`Temporary workspace: ${result.workspaceRoot}`);
  console.log(`Primary static flow: ${result.primaryFlow.method} ${result.primaryFlow.route}`);
  console.log(`Apply the declared change: ${result.commands.apply}`);
  console.log(`Reset the declared change: ${result.commands.reset}`);
  console.log("The target application is not executed. This is a demonstration, not independent benchmark or runtime evidence.");
}

module.exports = {
  DEFAULT_SHOWCASE_ROOT,
  SHOWCASE_SCHEMA,
  SHOWCASE_STATE_FILE,
  SHOWCASE_WORKSPACE_SCHEMA,
  ShowcaseError,
  applyShowcaseChange,
  cleanupShowcase,
  loadShowcase,
  prepareShowcase,
  printShowcase,
  resetShowcase,
  showcasePublicResult,
  showcaseStatus,
  startShowcase,
  validateManifest,
};
