"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");

test("the zero-Flow-Lens sidebar explains the boundary and offers technical-map navigation", () => {
  assert.match(APP, /No static HTTP\/request entry point detected\./);
  assert.match(APP, /This does not mean the application has no behavior\./);
  assert.match(APP, /data-empty-flow-action="overview"/);
  assert.match(APP, /data-empty-flow-action="search"/);
  assert.match(APP, /state\.mode = "overview"/);
});
