"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("Viewer publishes a bounded, keyboard-described flow journey with explicit evidence vocabulary", () => {
  assert.match(index, /id="flow-list"/);
  assert.match(index, /id="graph-reading-key"/);
  assert.match(index, /aria-describedby="graph-reading-key"/);
  assert.match(index, /STATIC EVIDENCE · NOT RUNTIME ORDER/);
  assert.match(index, /Planned · not in source/);
  assert.match(index, /Inventory only · no implied relationship/);
  assert.match(index, /Use the static flow list, Find code search, and inspector controls for keyboard navigation\./);
  assert.match(app, /function mapTitle\(view\)/);
  assert.match(app, /domain: "Domain overview"/);
  assert.match(app, /node\[type = 'planned'\]/);
  assert.match(app, /edge\[type = 'planned'\]/);
  assert.doesNotMatch(app, /node\[planned = true\]/);
  assert.doesNotMatch(app, /edge\[planned = true\]/);
  assert.match(app, /inventory only/);
  assert.match(app, /node\[analysisStatus = 'inventory-only'\]/);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /\.project-bar \{[^}]*overflow-x: auto;[^}]*white-space: nowrap;/);
  assert.match(styles, /@media \(max-width: 900px\) \{[\s\S]*?\.scan-form \{ grid-template-columns: 1fr; \}[\s\S]*?\.scan-form button \{ width: 100%; \}/);
  assert.doesNotMatch(styles, /body \{[^}]*min-width: 1024px/);
});

test("Viewer title and primary header follow active project metadata", () => {
  assert.match(index, /<title>Loading project · Flopeek<\/title>/);
  assert.match(index, /id="viewer-project-title">Loading project\.\.\.<\/h1>/);
  assert.match(index, /<span class="product-name">FLOPEEK<\/span> · LOCAL PROJECT FLOW EXPLORER/);
  assert.match(app, /function activeProjectMetadata\(\)/);
  assert.match(app, /state\.workspace\?\.projects\?\.find\(\(project\) => project\.active\)/);
  assert.match(app, /activeWorkspaceProject\?\.serviceLabel \|\| graphProject\.name/);
  assert.match(app, /\$\("#viewer-project-title"\)\.textContent = project\.name/);
  assert.match(app, /document\.title = `\$\{project\.name\} · Flopeek`/);
  assert.match(app, /\$\("#project-name"\)\.textContent = state\.graph\.project\.name;\s*renderProjectIdentity\(\);/);
  assert.match(styles, /\.app-header h1 \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(styles, /@media \(max-width: 900px\) \{[\s\S]*?\.app-header h1 \{ max-width: calc\(100vw - 28px\); \}/);
});

test("Viewer exposes cancellation only for a bounded running scan and states the retained-graph boundary", () => {
  assert.match(index, /id="cancel-scan"/);
  assert.match(app, /state\.events\.addEventListener\("scan-status"/);
  assert.match(app, /status === "running" && outcome\?\.mode === "bounded-full-analysis"/);
  assert.match(app, /Scan did not complete\. Flopeek kept the last complete graph and marks it source-unverified\./);
  assert.match(app, /request\("\/api\/scan\/cancel"/);
});

test("Viewer makes repeated static convention discovery opt-in and states its evidence boundary", () => {
  assert.match(app, /id="find-related-implementations"/);
  assert.match(app, /\/api\/related-implementations\?contextRef=/);
  assert.match(app, /does not read source into this view or prove UI behavior, runtime wiring, or semantic equivalence/);
  assert.match(app, /data-related-implementation/);
});

test("Viewer exposes canonical identity, multi-parent history, and developer-only local PK", () => {
  assert.match(app, /function canonicalIdentitySection\(packet\)/);
  assert.match(app, /Canonical identity/);
  assert.match(app, /Stable ID/);
  assert.match(app, /All parents/);
  assert.match(app, /Identity history/);
  assert.match(app, /Copy stable Context Ref/);
  assert.match(app, /developerModeEnabled\(\)/);
  assert.match(app, /Local node PK/);
  assert.match(app, /\/api\/node-identity\?id=/);
});
