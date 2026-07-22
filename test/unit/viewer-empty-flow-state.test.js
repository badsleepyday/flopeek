"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");
const INDEX = fs.readFileSync(path.join(__dirname, "..", "..", "public", "index.html"), "utf8");

test("the zero-Flow-Lens sidebar explains the boundary and offers technical-map navigation", () => {
  assert.match(APP, /No supported static entry point detected\./);
  assert.match(APP, /This does not mean the application has no behavior\./);
  assert.match(APP, /data-empty-flow-action="overview"/);
  assert.match(APP, /data-empty-flow-action="search"/);
  assert.match(APP, /state\.mode = "overview"/);
});

test("candidate repository checks keep the active map and cancellation boundary explicit", () => {
  assert.ok(APP.includes("Checking new repository · current map remains active"));
  assert.ok(APP.includes("Candidate repository check in progress."));
  assert.ok(APP.includes("Cancel is unavailable until the candidate is accepted."));
  assert.ok(APP.includes("The current map remains active until the check succeeds."));
  assert.ok(APP.includes("submit.disabled = Boolean(requestedRoot)"));
});

test("viewer labels package-scoped graphs as a static subtree rather than a repository-wide map", () => {
  assert.ok(INDEX.includes('id="package-scope-badge"'));
  assert.ok(INDEX.includes('id="package-scope-boundary"'));
  assert.ok(APP.includes("Static package subtree only."));
  assert.ok(APP.includes("Session only · repository cache unchanged"));
  assert.ok(APP.includes('aria-describedby", "package-scope-boundary'));
  assert.ok(APP.includes("does not prove workspace membership, dependency ownership, build activation, or runtime topology."));
  assert.ok(APP.includes("does not replace the repository-wide cache."));
});

test("viewer keeps Canvas as the supported renderer and bounds the WebGL option as a preview", () => {
  assert.match(INDEX, /id="renderer-mode"/);
  assert.match(INDEX, /<option value="canvas">Canvas<\/option>/);
  assert.match(INDEX, /<option value="webgl">WebGL preview<\/option>/);
  assert.match(APP, /renderer: "canvas"/);
  assert.match(APP, /WebGL preview: experimental/);
  assert.match(APP, /renderer: state\.renderer === "webgl" \? \{ name: "canvas", webgl: true \} : \{ name: "canvas" \}/);
  assert.match(APP, /state\.renderer = "canvas"/);
  assert.match(APP, /WebGL preview is unavailable here; Canvas remains active/);
});

test("viewer exposes a read-only local delivery ledger without treating workflow status as proof", () => {
  assert.match(INDEX, /id="open-delivery-ledger"/);
  assert.match(APP, /function openDeliveryLedger/);
  assert.match(APP, /\/api\/work-records\?limit=50/);
  assert.match(APP, /LOCAL DELIVERY METADATA/);
  assert.match(APP, /does not prove source execution, CI success, approval authority, or runtime behavior/);
});

test("Viewer Continue mode keeps planned delivery metadata opt-in and visually distinct from factual graph evidence", () => {
  assert.match(INDEX, /id="continue-mode"/);
  assert.match(INDEX, /id="planned-overlay-filter"/);
  assert.match(APP, /PLANNED/);
  assert.match(APP, /continueMode: false/);
  assert.match(APP, /request\("\/api\/planned-overlays"\)/);
  assert.match(APP, /state\.events\.addEventListener\("planned-overlay"/);
  assert.match(APP, /if \(!state\.continueMode \|\| !state\.plannedOverlayId\) return null/);
  assert.match(APP, /type: "planned"/);
  assert.match(APP, /node\[type = 'planned'\]/);
  assert.match(APP, /edge\[type = 'planned'\]/);
  assert.match(APP, /"line-style": "dashed"/);
  assert.match(APP, /delivery plan · not found in source/);
  assert.match(APP, /does not create a source node, static call, impact result, Flow Lens step, parser-coverage fact, implementation result, or runtime observation/);
  assert.match(APP, /copy-planned-context/);
  assert.match(APP, /flowpeek-viewer-planned-node-context\/v1/);
  assert.match(APP, /record-plan-reconciliation/);
  assert.match(APP, /\/api\/plan-reconciliations/);
  assert.match(APP, /actorKind: "human"/);
  assert.match(APP, /cannot change source, parser facts, Flow Lens, impact, test proof, runtime evidence, or approval authority/);
  assert.match(APP, /Baseline \/ Planned \/ Current/);
  assert.match(APP, /\/api\/continuation-comparison/);
  assert.match(APP, /Missing retained evidence is not treated as missing implementation/);
  assert.match(APP, /Baseline divergence/);
  assert.match(APP, /\/api\/checkpoint-divergence/);
});
