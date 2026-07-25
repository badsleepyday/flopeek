"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

test("generated Flowpeek cache under a committed fixture is ignored without ignoring the fixture source", () => {
  const generated = spawnSync("git", ["check-ignore", "-q", "--no-index", "test/fixtures/django-management-command-flow/.flowpeek/graph.json"], { cwd: ROOT, windowsHide: true });
  const source = spawnSync("git", ["check-ignore", "-q", "--no-index", "test/fixtures/django-management-command-flow/expectations.json"], { cwd: ROOT, windowsHide: true });
  assert.equal(generated.status, 0, "fixture-local Flowpeek cache must be ignored");
  assert.equal(source.status, 1, "fixture source must remain visible to Git");
});
