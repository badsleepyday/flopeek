"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const cytoscape = require("cytoscape");

function loadSynchronizer() {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");
  const start = source.indexOf("function elementId");
  const end = source.indexOf("function renderGraph");
  assert.ok(start >= 0 && end > start, "Viewer graph reconciliation helpers must remain available.");
  return new Function(`${source.slice(start, end)}\nreturn { synchronizeCytoscape, focusRenderedView };`)();
}

test("live renderer reconciliation preserves viewport and unchanged-node positions while adding bounded graph elements", () => {
  const { synchronizeCytoscape } = loadSynchronizer();
  const cy = cytoscape({ headless: true, elements: [
    { data: { id: "a", label: "A" }, position: { x: 120, y: 80 } },
    { data: { id: "b", label: "B" }, position: { x: 340, y: 80 } },
    { data: { id: "a-b", source: "a", target: "b", type: "imports" } },
  ] });
  cy.zoom(1.3);
  cy.pan({ x: 24, y: -12 });
  const beforeA = cy.getElementById("a").position();
  const beforeB = cy.getElementById("b").position();
  const result = synchronizeCytoscape(cy, [
    { data: { id: "a", label: "A updated" } },
    { data: { id: "b", label: "B" } },
    { data: { id: "c", label: "C" } },
    { data: { id: "a-b", source: "a", target: "b", type: "imports" } },
    { data: { id: "b-c", source: "b", target: "c", type: "uses" } },
  ], null);
  assert.deepEqual(cy.getElementById("a").position(), beforeA);
  assert.deepEqual(cy.getElementById("b").position(), beforeB);
  assert.equal(cy.zoom(), 1.3);
  assert.deepEqual(cy.pan(), { x: 24, y: -12 });
  assert.equal(cy.getElementById("a").data("label"), "A updated");
  assert.equal(cy.getElementById("c").length, 1);
  assert.ok(Number.isFinite(cy.getElementById("c").position("x")));
  assert.deepEqual(result, { addedNodes: 1, addedEdges: 1, removed: 0 });
});

test("a changed compact projection receives a bounded automatic fit instead of inheriting an unrelated viewport", () => {
  const { focusRenderedView } = loadSynchronizer();
  const calls = [];
  const cy = {
    zoomValue: 2.4,
    fit: () => calls.push("fit"),
    zoom(value) { if (value === undefined) return this.zoomValue; this.zoomValue = value; calls.push(`zoom:${value}`); },
    center: () => calls.push("center"),
    nodes: () => ({ length: 2 }),
    getElementById: () => ({ length: 0 }),
  };
  focusRenderedView(cy, { focusId: null }, 2);
  assert.deepEqual(calls, ["fit", "zoom:1.35", "center"]);
  assert.equal(cy.zoomValue, 1.35);
});
