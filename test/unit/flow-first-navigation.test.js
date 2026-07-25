"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const viewer = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

test("Viewer starts at a bounded Flow Lens when a supported flow exists and keeps Project Home as the no-flow fallback", () => {
  assert.match(viewer, /id="open-primary-flow"/);
  assert.match(app, /initialFlowOpened: false/);
  assert.match(app, /const firstFlow = state\.graph\.flows\?\.\[0\];/);
  assert.match(app, /if \(firstFlow\) \{\s*await openFlowLens\(firstFlow\.id\);\s*\} else \{\s*await openProjectHome/s);
  assert.match(app, /No supported static Flow Lens is available in this graph version\./);
});
