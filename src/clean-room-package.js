"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { atomicWriteJson } = require("./graph-cache");
const { npmInvocation, runPackageAudit } = require("./package-policy");

const CLEAN_ROOM_REPORT_SCHEMA = "flowpeek-clean-room-package-report/v1";

class CleanRoomError extends Error {
  constructor(code, message, report = null) {
    super(message);
    this.name = "CleanRoomError";
    this.code = code;
    this.report = report;
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceFingerprint(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".flowpeek" || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(root);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return { algorithm: "sha256", value: hash.digest("hex"), files: files.length };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env || process.env,
    timeout: options.timeoutMilliseconds || 180_000,
    windowsHide: true,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
  if (result.error) throw new CleanRoomError("command-start-failed", `${options.label || command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new CleanRoomError("command-failed", `${options.label || command} failed with exit code ${result.status}.`);
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), status: result.status };
}

function npmRun(args, options = {}) {
  const npm = npmInvocation();
  return run(npm.command, [...npm.prefixArgs, ...args], { ...options, label: options.label || `npm ${args[0]}` });
}

function parseJsonOutput(output, label) {
  try { return JSON.parse(String(output || "")); }
  catch (error) { throw new CleanRoomError("invalid-command-json", `${label} did not return valid JSON: ${error.message}`); }
}

function phase(report, id, operation) {
  const started = process.hrtime.bigint();
  try {
    const result = operation();
    report.phases.push({ id, status: "passed", milliseconds: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)) });
    return result;
  } catch (error) {
    report.phases.push({ id, status: "failed", milliseconds: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)), code: error.code || "unexpected-error" });
    throw error;
  }
}

async function asyncPhase(report, id, operation) {
  const started = process.hrtime.bigint();
  try {
    const result = await operation();
    report.phases.push({ id, status: "passed", milliseconds: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)) });
    return result;
  } catch (error) {
    report.phases.push({ id, status: "failed", milliseconds: Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3)), code: error.code || "unexpected-error" });
    throw error;
  }
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new CleanRoomError("timeout", `${label} exceeded ${milliseconds} ms.`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function inspectInstalledMcp(installedCli, fixture, consumer, timeoutMilliseconds) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [installedCli, "mcp", fixture], cwd: consumer, stderr: "pipe" });
  const client = new Client({ name: "flowpeek-clean-room-verifier", version: "1.0.0" });
  try {
    await withTimeout(client.connect(transport), timeoutMilliseconds, "MCP connection");
    const tools = await withTimeout(client.listTools(), timeoutMilliseconds, "MCP tools/list");
    const bootstrapResult = await withTimeout(client.callTool({ name: "get_agent_bootstrap", arguments: {} }), timeoutMilliseconds, "MCP get_agent_bootstrap");
    const text = bootstrapResult.content.find((item) => item.type === "text")?.text;
    const bootstrap = parseJsonOutput(text, "MCP get_agent_bootstrap");
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    return {
      connected: true,
      toolCount: toolNames.length,
      requiredTools: {
        getAgentBootstrap: toolNames.includes("get_agent_bootstrap"),
        getFlowProjection: toolNames.includes("get_flow_projection"),
        resolveContextRef: toolNames.includes("resolve_context_ref"),
      },
      bootstrapSchemaVersion: bootstrap.schemaVersion,
      graphStatus: bootstrap.graph.status,
      sourceWrites: bootstrap.policy.sourceWrites,
      targetExecution: bootstrap.policy.targetExecution,
    };
  } finally {
    try { await client.close(); }
    catch {
      try { await transport.close(); } catch { /* best-effort child cleanup */ }
    }
  }
}

function cleanRoomReport() {
  return {
    schemaVersion: CLEAN_ROOM_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    status: "running",
    evidenceClass: "clean-room-package-observation",
    environment: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      lifecycleScriptsDuringInstall: false,
      timingPolicy: "host-specific-non-gating",
    },
    packageAudit: null,
    artifact: null,
    phases: [],
    smoke: null,
    cleanup: { status: "pending" },
    publication: { attempted: false, approved: false },
    limitations: [
      "This report proves only one isolated tarball pack, install, and bounded static command sequence on the declared host.",
      "It does not prove every operating system, registry publication, upgrade compatibility, runtime application behavior, parser accuracy, or alpha/beta/stable readiness.",
      "The target fixture is copied before scanning; no target application, test command, package script, or arbitrary shell command is executed.",
      "MCP startup verifies protocol and bounded graph tools. Metadata-writing MCP tools remain non-source-writing and are not invoked by this check.",
    ],
  };
}

async function verifyCleanRoomPackage(root, options = {}) {
  const repository = fs.realpathSync(root);
  const report = cleanRoomReport();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-clean-room-"));
  const packDirectory = path.join(workspace, "pack");
  const consumer = path.join(workspace, "consumer");
  const fixture = path.join(workspace, "fixture");
  let failure = null;
  try {
    fs.mkdirSync(packDirectory, { recursive: true });
    fs.mkdirSync(consumer, { recursive: true });
    const packed = phase(report, "pack-and-audit", () => runPackageAudit(repository, { dryRun: false, packDestination: packDirectory, timeoutMilliseconds: options.packTimeoutMilliseconds || 180_000 }));
    report.packageAudit = packed.report;
    if (packed.report.status !== "passed") throw new CleanRoomError("package-audit-failed", "The produced tarball failed the committed package policy.");
    const tarball = path.join(packDirectory, packed.packResult.filename);
    if (!fs.existsSync(tarball)) throw new CleanRoomError("missing-tarball", "npm pack did not create the declared tarball.");
    report.artifact = { filename: path.basename(tarball), sha256: sha256File(tarball), packedBytes: fs.statSync(tarball).size };

    phase(report, "copy-fixture", () => {
      fs.cpSync(path.join(repository, "examples", "commerce-showcase"), fixture, { recursive: true, errorOnExist: true });
      fs.writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "flowpeek-clean-room-consumer", private: true, version: "0.0.0" }, null, 2)}\n`, "utf8");
    });
    const before = sourceFingerprint(fixture);
    const install = phase(report, "install-tarball", () => npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: consumer, timeoutMilliseconds: options.installTimeoutMilliseconds || 300_000 }));
    report.environment.installWarningsPresent = Boolean(install.stderr.trim());
    const installedRoot = path.join(consumer, "node_modules", "flowpeek");
    const installedPackage = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
    const installedCli = path.join(installedRoot, installedPackage.bin?.flowpeek || "src/cli.js");
    const binShim = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "flowpeek.cmd" : "flowpeek");
    if (!fs.existsSync(installedCli) || !fs.existsSync(binShim)) throw new CleanRoomError("missing-installed-binary", "The installed package did not expose the declared flowpeek binary.");

    const execFlowpeek = (argumentsList, label, timeoutMilliseconds = 120_000) => npmRun(["exec", "--offline", "--", "flowpeek", ...argumentsList], { cwd: consumer, label, timeoutMilliseconds });
    const version = phase(report, "binary-version", () => execFlowpeek(["--version"], "installed flowpeek --version"));
    const help = phase(report, "binary-help", () => execFlowpeek(["help"], "installed flowpeek help"));
    const doctor = phase(report, "binary-doctor", () => parseJsonOutput(execFlowpeek(["doctor", fixture, "--platform", "all", "--format", "json"], "installed flowpeek doctor").stdout, "installed flowpeek doctor"));
    const scan = phase(report, "bounded-static-scan", () => parseJsonOutput(execFlowpeek(["scan", fixture, "--format", "json", "--no-cache"], "installed flowpeek scan", 180_000).stdout, "installed flowpeek scan"));
    const mcp = await asyncPhase(report, "mcp-startup", () => inspectInstalledMcp(installedCli, fixture, consumer, options.mcpTimeoutMilliseconds || 60_000));
    const after = sourceFingerprint(fixture);
    report.smoke = {
      packageIdentity: { expectedName: "flowpeek", actualName: installedPackage.name, expectedVersion: packed.packResult.version, actualVersion: installedPackage.version, binShimPresent: true },
      version: { expected: installedPackage.version, actual: version.stdout.trim(), matched: version.stdout.trim() === installedPackage.version },
      help: { rendered: help.stdout.includes("Flowpeek") && help.stdout.includes("flowpeek mcp") && help.stdout.includes("flowpeek scan") },
      doctor: { schemaVersion: doctor.schemaVersion, ok: doctor.ok, errors: doctor.summary?.errors ?? null, warnings: doctor.summary?.warnings ?? null, strict: doctor.strict },
      scan: {
        schemaVersion: scan.schemaVersion,
        graphSchemaVersion: scan.schemaVersion,
        files: scan.stats?.scannedFiles ?? null,
        nodes: scan.stats?.nodes ?? null,
        edges: scan.stats?.edges ?? null,
        applicationFlows: scan.flows?.length ?? null,
        cacheStatus: scan.analysis?.cacheState?.status ?? null,
      },
      mcp,
      targetFixture: { copied: true, sourceFingerprintBefore: before, sourceFingerprintAfter: after, unchanged: before.value === after.value, applicationExecuted: false, testCommandExecuted: false },
    };
    const requiredSmoke = [
      installedPackage.name === "flowpeek",
      installedPackage.version === packed.packResult.version,
      report.smoke.version.matched,
      report.smoke.help.rendered,
      doctor.summary?.errors === 0,
      scan.analysis?.cacheState?.status === "disabled",
      mcp.connected && Object.values(mcp.requiredTools).every(Boolean) && mcp.sourceWrites === "not-exposed" && mcp.targetExecution === "not-exposed",
      before.value === after.value,
    ];
    if (!requiredSmoke.every(Boolean)) throw new CleanRoomError("smoke-contract-failed", "One or more clean-room smoke contracts failed.");
    report.status = "passed";
  } catch (error) {
    failure = error instanceof CleanRoomError ? error : new CleanRoomError("unexpected-error", error.message);
    report.status = "failed";
    report.failure = { code: failure.code, message: failure.message };
  } finally {
    const cleanupStarted = process.hrtime.bigint();
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      report.cleanup = { status: fs.existsSync(workspace) ? "failed" : "passed", milliseconds: Number((Number(process.hrtime.bigint() - cleanupStarted) / 1_000_000).toFixed(3)) };
    } catch (error) {
      report.cleanup = { status: "failed", milliseconds: Number((Number(process.hrtime.bigint() - cleanupStarted) / 1_000_000).toFixed(3)), code: error.code || "cleanup-error" };
    }
    if (report.cleanup.status !== "passed") {
      report.status = "failed";
      if (!failure) failure = new CleanRoomError("cleanup-failed", "The clean-room workspace could not be removed.");
      report.failure ||= { code: failure.code, message: failure.message };
    }
  }
  if (failure) throw new CleanRoomError(failure.code, failure.message, report);
  return report;
}

function writeCleanRoomReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, report);
  return file;
}

module.exports = {
  CLEAN_ROOM_REPORT_SCHEMA,
  CleanRoomError,
  sha256File,
  sourceFingerprint,
  verifyCleanRoomPackage,
  writeCleanRoomReport,
};
