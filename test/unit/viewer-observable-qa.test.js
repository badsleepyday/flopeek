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
