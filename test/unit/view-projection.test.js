"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { projectView } = require("../../src/graph-service");
const { scanRepository } = require("../../src/scanner");

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-view-projection-"));
  write(root, "package.json", JSON.stringify({ name: "view-projection" }));
  const imports = [];
  for (let index = 0; index < 52; index += 1) {
    const name = `dependency-${String(index).padStart(2, "0")}`;
    write(root, `src/${name}.ts`, `export const ${name.replaceAll("-", "_")} = ${index};\n`);
    imports.push(`import { ${name.replaceAll("-", "_")} } from './${name}';`);
  }
  write(root, "src/main.ts", `${imports.join("\n")}\nexport const count = 52;\n`);
  return root;
}

test("view projections are version-bound, bounded, and explicit about omitted static evidence", () => {
  const root = fixture();
  try {
    const graph = scanRepository(root, { persistIdentity: false });
    const view = projectView(graph, { mode: "dependencies", scope: "application", focus: "file:src/main.ts", maxNodes: 10, maxEdges: 8 });
    assert.equal(view.schemaVersion, "flowpeek-view-projection/v2");
    assert.equal(view.basis.projectId, graph.project.projectId);
    assert.equal(view.basis.graphVersion, graph.state.graphVersion);
    assert.equal(view.display.bounds.maxNodes, 10);
    assert.equal(view.display.bounds.maxEdges, 8);
    assert.equal(view.display.catalog.nodes.returned, 10);
    assert.ok(view.display.catalog.nodes.omitted > 0);
    assert.ok(view.display.catalog.edges.omittedBecauseNodeBound > 0);
    assert.equal(view.display.catalog.truncated, true);
    assert.match(view.display.catalog.warning, /bounded/);
    assert.throws(() => projectView(graph, { maxNodes: 101 }), /maxNodes must be an integer/);
    assert.throws(() => projectView(graph, { maxEdges: 201 }), /maxEdges must be an integer/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("view CLI exposes the same bounded projection contract without creating cache state in inspection mode", () => {
  const root = fixture();
  try {
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const output = execFileSync(process.execPath, [cli, "view", root, "--mode", "dependencies", "--focus", "file:src/main.ts", "--max-nodes", "9", "--max-edges", "7", "--no-cache", "--format", "json"], { encoding: "utf8" });
    const view = JSON.parse(output);
    assert.equal(view.schemaVersion, "flowpeek-view-projection/v2");
    assert.equal(view.display.bounds.maxNodes, 9);
    assert.equal(view.display.bounds.maxEdges, 7);
    assert.equal(fs.existsSync(path.join(root, ".flowpeek")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("view CLI accepts the documented semantic level option instead of treating it as a repository path", () => {
  const root = fixture();
  try {
    const cli = path.join(__dirname, "..", "..", "src", "cli.js");
    const output = execFileSync(process.execPath, [cli, "view", root, "--level", "domain", "--no-cache", "--format", "json"], { encoding: "utf8" });
    const view = JSON.parse(output);
    assert.equal(view.view.level, "domain");
    assert.ok(view.nodes.every((node) => node.hierarchy.level === "domain"));
    assert.equal(fs.existsSync(path.join(root, ".flowpeek")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
