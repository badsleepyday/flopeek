"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { projectView } = require("../../src/graph-service");
const { scanRepository } = require("../../src/scanner");

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "renderer-projection-corpus.json"), "utf8"));

function sourceFor(definition) {
  const calls = Array.from({ length: definition.functions }, () => []);
  for (let index = 0; index < definition.directCallStatements; index += 1) {
    const source = index % definition.functions;
    const target = (source + Math.floor(index / definition.functions) + 1) % definition.functions;
    calls[source].push(`node${target}();`);
  }
  return calls.map((body, index) => `export function node${index}() { ${body.join(" ")} }`).join("\n");
}

test("renderer projection corpus pins small, medium, and dense bounded static maps", (t) => {
  assert.equal(corpus.schemaVersion, "flopeek-renderer-projection-corpus/v1");
  assert.deepEqual(corpus.fixtures.map((item) => item.id), ["small", "medium", "dense"]);
  assert.ok(corpus.fixtures[0].functions < corpus.fixtures[1].functions && corpus.fixtures[1].functions < corpus.fixtures[2].functions);
  assert.equal(corpus.projection.maxNodes, 100);
  assert.equal(corpus.projection.maxEdges, 200);
  for (const definition of corpus.fixtures) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `flopeek-renderer-${definition.id}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "projection.ts"), sourceFor(definition), "utf8");
    const graph = scanRepository(root, { persistIdentity: false });
    const projection = projectView(graph, corpus.projection);
    assert.equal(graph.stats.functions, definition.functions);
    assert.equal(graph.stats.calls, definition.directCallStatements);
    assert.ok(projection.nodes.length <= corpus.projection.maxNodes);
    assert.ok(projection.edges.length <= corpus.projection.maxEdges);
    assert.equal(projection.basis.graphVersion, graph.state.graphVersion);
  }
});
