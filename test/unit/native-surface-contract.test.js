"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  BOUNDED,
  HANDLE_SAFE,
  MATERIALIZED,
  MCP_BOUNDED,
  MCP_HANDLE_SAFE,
  SERVER_HANDLE_SAFE,
  mcpSurfaceCategory,
  serverSurfaceCategory,
} = require("../../src/native-surface-contract");

const ROOT = path.resolve(__dirname, "..", "..");

test("every registered MCP tool has an explicit native handle category", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8");
  const names = [...source.matchAll(/\bregister(?:MetadataWrite|WithAnnotations)?\("([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(names.length > 40);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.ok([BOUNDED, HANDLE_SAFE, MATERIALIZED].includes(mcpSurfaceCategory(name)), name);
  for (const name of MCP_HANDLE_SAFE) assert.ok(names.includes(name), `stale MCP handle-safe contract entry: ${name}`);
  for (const name of MCP_BOUNDED) assert.ok(names.includes(name), `stale MCP bounded contract entry: ${name}`);
});

test("every HTTP endpoint is classified and the broad server surface remains materialized", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
  const routes = [...source.matchAll(/request\.method === "(GET|POST)" && url\.pathname === "([^"]+)"/gu)]
    .map((match) => `${match[1]} ${match[2]}`);
  assert.ok(routes.length > 50);
  for (const route of routes) {
    const [method, pathname] = route.split(" ", 2);
    assert.ok([HANDLE_SAFE, MATERIALIZED].includes(serverSurfaceCategory(method, pathname)), route);
  }
  for (const route of SERVER_HANDLE_SAFE) assert.ok(routes.includes(route), `stale server handle-safe contract entry: ${route}`);
  assert.match(source, /nativeGraphHandle:\s*true/);
  assert.match(source, /core\.materializeGraph\(current\)/);
});
