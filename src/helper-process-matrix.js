"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanRepositoryBounded } = require("./bounded-scan");
const { goFacts } = require("./go-adapter");
const { csharpFacts } = require("./csharp-adapter");

function available(command) {
  try { require("node:child_process").execFileSync(command, [command.includes("dotnet") ? "--info" : "version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function waitForFile(target, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(target)) return fs.readFileSync(target, "utf8").trim();
    await wait(20);
  }
  return null;
}

async function processStopped(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(Number(pid), 0); } catch { return true; }
    await wait(25);
  }
  return false;
}

function withTestEnvironment(values, action) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return action(); }
  finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function fixture(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flopeek-helper-${kind}-`));
  const source = path.join(root, kind === "go" ? "main.go" : "Program.cs");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: `helper-${kind}` }));
  fs.writeFileSync(source, kind === "go" ? "package main\nfunc main() {}\n" : "public class Program { static void Main() {} }\n");
  return { root, source, pidFile: path.join(root, "helper.pid") };
}

function invoke(kind, source) { return kind === "go" ? goFacts([source]) : csharpFacts([source]); }

async function probeNormalAndTimeout(kind) {
  const item = fixture(kind);
  try {
    const normal = await withTestEnvironment({ FLOPEEK_TEST_MODE: "1", FLOPEEK_TEST_HELPER_PID_FILE: item.pidFile, FLOPEEK_TEST_HELPER_DELAY_MS: "40", FLOPEEK_TEST_HELPER_TIMEOUT_MS: "5000" }, async () => {
      const facts = invoke(kind, item.source);
      const pid = fs.existsSync(item.pidFile) ? fs.readFileSync(item.pidFile, "utf8").trim() : null;
      return { factCount: facts.size, pid, pidObserved: Boolean(pid), stopped: pid ? await processStopped(pid) : true };
    });
    fs.rmSync(item.pidFile, { force: true });
    const timeout = await withTestEnvironment({ FLOPEEK_TEST_MODE: "1", FLOPEEK_TEST_HELPER_PID_FILE: item.pidFile, FLOPEEK_TEST_HELPER_DELAY_MS: "1500", FLOPEEK_TEST_HELPER_TIMEOUT_MS: "80" }, async () => {
      const facts = invoke(kind, item.source);
      const pid = await waitForFile(item.pidFile, 1_000);
      return { factCount: facts.size, pid, pidObserved: Boolean(pid), stopped: pid ? await processStopped(pid) : true };
    });
    return { normal, timeout };
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
}

async function probeBoundedAbort(kind) {
  const item = fixture(kind);
  try {
    const controller = new AbortController();
    const resultPromise = withTestEnvironment({ FLOPEEK_TEST_MODE: "1", FLOPEEK_TEST_HELPER_PID_FILE: item.pidFile, FLOPEEK_TEST_HELPER_DELAY_MS: "1500" }, () => scanRepositoryBounded(item.root, { signal: controller.signal, persistIdentity: false }));
    const pid = await waitForFile(item.pidFile);
    controller.abort("helper-process-matrix");
    const result = await resultPromise;
    return { pid, pidObserved: Boolean(pid), status: result.status, cachePromotionAllowed: result.cachePromotion.allowed, stopped: pid ? await processStopped(pid) : true };
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
}

async function probeConcurrent(kind) {
  const probes = [fixture(kind), fixture(kind)];
  try {
    const results = await Promise.all(probes.map(async (item) => withTestEnvironment({ FLOPEEK_TEST_MODE: "1", FLOPEEK_TEST_HELPER_PID_FILE: item.pidFile, FLOPEEK_TEST_HELPER_DELAY_MS: "100", FLOPEEK_TEST_HELPER_TIMEOUT_MS: "5000" }, async () => {
      const facts = invoke(kind, item.source);
      const pid = fs.existsSync(item.pidFile) ? fs.readFileSync(item.pidFile, "utf8").trim() : null;
      return { factCount: facts.size, pid, pidObserved: Boolean(pid), stopped: pid ? await processStopped(pid) : true };
    })));
    return results;
  } finally { for (const item of probes) fs.rmSync(item.root, { recursive: true, force: true }); }
}

async function runHelperProcessMatrix() {
  const toolchains = { go: available(process.platform === "win32" ? "go.exe" : "go"), csharp: available(process.platform === "win32" ? "dotnet.exe" : "dotnet") };
  const results = {};
  for (const kind of ["go", "csharp"]) {
    if (!toolchains[kind]) { results[kind] = { status: "unavailable" }; continue; }
    results[kind] = {
      status: "available",
      completionAndTimeout: await probeNormalAndTimeout(kind),
      abort: await probeBoundedAbort(kind),
      concurrent: await probeConcurrent(kind),
    };
  }
  return { schemaVersion: "flopeek-helper-process-matrix/v1", platform: process.platform, toolchains, results, limitation: "This fixture-only matrix observes direct parser helper lifecycle. It does not execute a target application or constitute macOS evidence when run elsewhere." };
}

if (require.main === module) runHelperProcessMatrix().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { runHelperProcessMatrix };
