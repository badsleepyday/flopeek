"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { validateSurfaceEvidence } = require("../../scripts/build-native-rollout-evidence");
const {
  CLI_COMMANDS,
  SCHEMA,
  buildSurfaceMatrix,
} = require("../../scripts/verify-native-surfaces");

const ROOT = path.resolve(__dirname, "..", "..");

test("machine surface matrix classifies every CLI, MCP, and HTTP registration", () => {
  const matrix = buildSurfaceMatrix({
    mcpSource: fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8"),
    serverSource: fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8"),
    cliSource: fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8"),
    verification: { exitCode: 0 },
  });
  assert.equal(matrix.schemaVersion, SCHEMA);
  assert.deepEqual(matrix.cli.map((entry) => entry.command), [...CLI_COMMANDS]);
  assert.ok(matrix.summary.mcpTools > 40);
  assert.ok(matrix.summary.httpRoutes > 50);
  assert.equal(matrix.summary.unclassified, 0);
  assert.ok(matrix.mcp.every((entry) => typeof entry.classification === "string"));
  assert.ok(matrix.http.every((entry) => typeof entry.classification === "string"));
  assert.ok(matrix.cli.every((entry) => entry.modes.native.fallbackVisible));
  assert.ok(matrix.cli.every((entry) => entry.modes["native-experimental"].authority === "rust"));
});

test("surface matrix fails closed when a required CLI command disappears", () => {
  const cliSource = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8")
    .replace('"scan",', "");
  assert.throws(() => buildSurfaceMatrix({
    mcpSource: fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8"),
    serverSource: fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8"),
    cliSource,
    verification: { exitCode: 0 },
  }), /CLI command is not registered/);
});

test("surface matrix fails closed when a newly registered surface has no explicit category", () => {
  const mcpSource = `${fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8")}\nregister("future_unclassified_tool", {});\n`;
  assert.throws(() => buildSurfaceMatrix({
    mcpSource,
    serverSource: fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8"),
    cliSource: fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8"),
    verification: { exitCode: 0 },
  }), /Unclassified native surface/u);
});

test("rollout validator binds the complete surface matrix to the exact candidate binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-surface-validator-"));
  const file = path.join(root, "native-surface-matrix.json");
  const binarySha256 = "a".repeat(64);
  const matrix = buildSurfaceMatrix({
    mcpSource: fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8"),
    serverSource: fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8"),
    cliSource: fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8"),
    verification: { exitCode: 0 },
    binarySha256,
  });
  try {
    fs.writeFileSync(file, JSON.stringify(matrix));
    assert.equal(validateSurfaceEvidence(file, {
      "@flopeek/native-linux-x64-gnu": { binarySha256 },
    }).cliCommands, 7);
    matrix.invariants.nativeAuthorityReadsGraphJson = true;
    fs.writeFileSync(file, JSON.stringify(matrix));
    assert.throws(() => validateSurfaceEvidence(file, {
      "@flopeek/native-linux-x64-gnu": { binarySha256 },
    }), /complete exact-binary native surface matrix/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
