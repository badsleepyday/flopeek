"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { getFlowProjection, getTestRuns } = require("../../src/graph-service");
const { startServer } = require("../../src/server");

const FIXTURE_ROOT = path.join(__dirname, "..", "fixtures", "runner-adapter-repository");

function close(app) {
  return new Promise((resolve) => app?.server?.close(resolve));
}

function runRepositoryCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Repository-owned runner command timed out after 30 seconds."));
    }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (status, signal) => { clearTimeout(timeout); resolve({ status, signal, stdout, stderr }); });
  });
}

test("a repository-owned npm test command can report a current failing Flow Lens step without Flopeek executing it", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-runner-command-"));
  const root = path.join(temporary, "repository");
  const registryRoot = path.join(temporary, "registry");
  let app;
  try {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    app = await startServer({ root, port: 0, open: false, registryRoot, registerServeWorkspace: false });
    const graph = app.getGraph();
    const flow = graph.flows.find((candidate) => candidate.title === "GET /api/reports");
    assert.ok(flow, "fixture must expose a current GET /api/reports Flow Lens");
    const lens = getFlowProjection(graph, flow.id);
    const stepId = lens.steps.at(-1).id;
    const runId = `repository-command-${Date.now()}`;
    const command = process.platform === "win32" ? "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "call npm.cmd test --silent"] : ["test", "--silent"];
    const runnerEnvironment = {
      ...process.env,
      FLOPEEK_EVENT_ENDPOINT: `http://127.0.0.1:${app.port}/api/test-run-events`,
      FLOPEEK_FLOW_ID: lens.flow.id,
      FLOPEEK_FLOW_CONTEXT_REF: lens.flow.contextRef,
      FLOPEEK_FLOW_STEP_ID: stepId,
      FLOPEEK_RUN_ID: runId,
    };
    delete runnerEnvironment.NODE_TEST_CONTEXT;
    const result = await runRepositoryCommand(command, args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: runnerEnvironment,
    });
    const runs = getTestRuns(app.getGraph(), { flowId: lens.flow.id });
    const run = runs.runs.find((candidate) => candidate.runId === runId);
    assert.ok(run, JSON.stringify({ status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr, runs }));
    assert.notEqual(result.status, 0, "the fixture command must preserve the repository test failure");
    assert.equal(run.status, "failed");
    assert.equal(run.stoppedAtStepId, stepId);
    assert.equal(run.events.length, 3);
    const stored = fs.readFileSync(path.join(root, ".flopeek", "test-runs", "events.json"), "utf8");
    assert.equal(stored.includes("Intentional fixture assertion failure"), false);
    if (result.stderr.trim()) assert.equal(stored.includes(result.stderr.trim()), false);
  } finally {
    await close(app);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
