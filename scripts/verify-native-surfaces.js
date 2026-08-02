#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  BOUNDED,
  HANDLE_SAFE,
  MATERIALIZED,
  UNSUPPORTED,
  mcpSurfaceCategory,
  serverSurfaceCategory,
} = require("../src/native-surface-contract");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "flopeek-native-surface-matrix/v1";
const CLI_COMMANDS = Object.freeze([
  "scan",
  "view",
  "impact",
  "delta",
  "bootstrap",
  "mcp",
  "serve",
]);
const CLI_CLASSIFICATIONS = Object.freeze({
  scan: BOUNDED,
  view: BOUNDED,
  impact: BOUNDED,
  delta: BOUNDED,
  bootstrap: BOUNDED,
  mcp: HANDLE_SAFE,
  serve: MATERIALIZED,
});
const SMOKE_TESTS = Object.freeze([
  "test/unit/core-cli-mode.test.js",
  "test/unit/native-mcp-handle.test.js",
  "test/unit/native-server-handle.test.js",
  "test/unit/native-surface-contract.test.js",
]);
const CATEGORIES = new Set([HANDLE_SAFE, BOUNDED, MATERIALIZED, UNSUPPORTED]);

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function registeredMcpTools(source) {
  const names = [...source.matchAll(/\bregister(?:MetadataWrite|WithAnnotations)?\("([^"]+)"/gu)]
    .map((match) => match[1]);
  if (names.length < 40 || new Set(names).size !== names.length) {
    throw new Error("MCP surface registry is incomplete or contains duplicate tool names.");
  }
  return names;
}

function registeredHttpRoutes(source) {
  const routes = [...source.matchAll(/request\.method === "(GET|POST)" && url\.pathname === "([^"]+)"/gu)]
    .map((match) => ({ method: match[1], pathname: match[2] }));
  if (routes.length < 50
    || new Set(routes.map((route) => `${route.method} ${route.pathname}`)).size !== routes.length) {
    throw new Error("HTTP surface registry is incomplete or contains duplicate routes.");
  }
  return routes;
}

function registeredCliCommands(source) {
  const match = source.match(/if \(\[(?<commands>(?:"[^"]+",?\s*)+)\]\.includes\(values\[0\]\)\)/u);
  if (!match?.groups?.commands) throw new Error("CLI command registry could not be read.");
  return JSON.parse(`[${match.groups.commands}]`);
}

function buildSurfaceMatrix({
  mcpSource,
  serverSource,
  cliSource,
  verification,
  binarySha256 = null,
}) {
  if (verification?.exitCode !== 0) {
    throw new Error("Native surface runtime verification did not pass.");
  }
  const registeredCli = new Set(registeredCliCommands(cliSource));
  for (const command of CLI_COMMANDS) {
    if (!registeredCli.has(command)) {
      throw new Error(`CLI command is not registered: ${command}.`);
    }
  }
  const verified = verification.exitCode === 0;
  const cli = CLI_COMMANDS.map((command) => ({
    command,
    classification: CLI_CLASSIFICATIONS[command],
    modes: {
      native: {
        implementationVisible: true,
        fallbackVisible: true,
        authority: "rollout-gated-native-or-visible-javascript-fallback",
      },
      "native-experimental": {
        implementationVisible: true,
        fallbackVisible: true,
        authority: "rust",
      },
    },
    graphJsonPolicy: "never-read-when-native-authority",
    cacheDisabledPolicy: "no-repository-metadata",
    persistentPolicy: "sqlite-only",
  }));
  const mcp = registeredMcpTools(mcpSource).map((name) => ({
    name,
    classification: mcpSurfaceCategory(name),
  }));
  const http = registeredHttpRoutes(serverSource).map(({ method, pathname }) => ({
    method,
    pathname,
    classification: serverSurfaceCategory(method, pathname),
  }));
  for (const surface of [...cli, ...mcp, ...http]) {
    if (!CATEGORIES.has(surface.classification)) {
      throw new Error(`Unclassified native surface: ${surface.command || surface.name || `${surface.method} ${surface.pathname}`}.`);
    }
  }
  return {
    schemaVersion: SCHEMA,
    generatedAt: new Date().toISOString(),
    binarySha256,
    summary: {
      cliCommands: cli.length,
      mcpTools: mcp.length,
      httpRoutes: http.length,
      unclassified: 0,
    },
    invariants: {
      handleSafeDoesNotMaterialize: verified,
      materializedSharesOneMaterializationPerHandle: verified,
      refreshUsesNewMaterialization: verified,
      cacheDisabledUsesOwningSession: verified,
      staleAndExpiredHandlesFailClosed: verified,
      nativeAuthorityReadsGraphJson: !verified,
    },
    cli,
    mcp,
    http,
    verification,
  };
}

function runSmoke(binary) {
  const result = childProcess.spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...SMOKE_TESTS,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    env: {
      ...process.env,
      ...(binary ? {
        FLOPEEK_NATIVE_CORE: binary,
        FLOPEEK_NATIVE_CORE_BINARY: binary,
      } : {}),
    },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.error || result.status !== 0) {
    throw new Error(`Native surface runtime smoke failed: ${result.error?.message || stderr || stdout}`);
  }
  return {
    command: process.execPath,
    arguments: ["--test", "--test-concurrency=1", ...SMOKE_TESTS],
    exitCode: result.status,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    testFiles: [...SMOKE_TESTS],
  };
}

function main(argv = process.argv.slice(2)) {
  const binaryArgument = argument(argv, "--binary");
  const binary = binaryArgument ? path.resolve(binaryArgument) : null;
  const output = argument(argv, "--output");
  if (binary && (!fs.existsSync(binary) || !fs.statSync(binary).isFile())) {
    throw new Error("Native surface verifier binary does not exist.");
  }
  const verification = runSmoke(binary);
  const matrix = buildSurfaceMatrix({
    mcpSource: fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8"),
    serverSource: fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8"),
    cliSource: fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8"),
    verification,
    binarySha256: binary ? sha256(fs.readFileSync(binary)) : null,
  });
  const serialized = `${JSON.stringify(matrix, null, 2)}\n`;
  if (output) {
    const resolved = path.resolve(output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, serialized);
  }
  process.stdout.write(serialized);
  return matrix;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Native surface verification blocked: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CLI_COMMANDS,
  SCHEMA,
  SMOKE_TESTS,
  buildSurfaceMatrix,
  registeredCliCommands,
  registeredHttpRoutes,
  registeredMcpTools,
};
